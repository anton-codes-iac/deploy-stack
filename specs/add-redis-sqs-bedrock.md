# Spec: Modular Service Engine (`deploy-stack add`) — `db:redis`, `queue:sqs` & `ai:bedrock`

## Overview
Extend the modular service engine with three new capabilities:
1. **`db:redis`**: AWS ElastiCache for Valkey 8.0 (`cache.t4g.micro`) isolated inside the VPC with security group ingress restricted to ECS tasks.
2. **`queue:sqs`**: Managed Amazon SQS standard queue with long polling, paired with a Dead-Letter Queue (DLQ, `maxReceiveCount = 3`), least-privilege Task Role IAM permissions, and conditional scale-to-zero worker auto-scaling.
3. **`ai:bedrock`**: Least-privilege Amazon Bedrock runtime IAM permissions (`InvokeModel` and `InvokeModelWithResponseStream` across foundation models and cross-region inference profiles) attached to the ECS Task Role with a configurable `--model` flag.

---

## Part 1: Registry Contracts, CLI Flags & Container Env Wiring

### 1. Preserve the Existing Split Between `src/utils/addons.js` and `src/commands/add.js`
* **`ADDON_REGISTRY` in `src/utils/addons.js`:** Keep the exact existing schema (`file`, `template`, `label`, `cost: { model, monthlyFixed, summary }`). Do not add `envVars` to `src/utils/addons.js`.
  * **`db:redis`**:
    * `file` and `template`: `redis.tf`
    * `label`: `ElastiCache Valkey 8.0`
    * `cost`: `model` set to `fixed-baseline`, `monthlyFixed` set to `9.49` (using `$0.013/hr` / `$9.49/mo` as the canonical `us-east-2` reference rate across code, tests, and docs), and `summary` describing the `~$9.49/mo` fixed baseline (`$0.013/hr` Valkey 8.0 `cache.t4g.micro` in `us-east-2`) with `$0` intra-AZ VPC transfer.
  * **`queue:sqs`**:
    * `file` and `template`: `sqs.tf`
    * `label`: `SQS + DLQ`
    * `cost`: `model` set to `usage-based`, `monthlyFixed` set to `0`, and `summary` noting `$0/mo` fixed baseline with the first 1M requests/mo free and `$0.40` per million requests thereafter.
  * **`ai:bedrock`**:
    * `file` and `template`: `bedrock.tf`
    * `label`: `Bedrock Runtime IAM`
    * `cost`: `model` set to `usage-based`, `monthlyFixed` set to `0`, and `summary` noting `$0/mo` fixed baseline billed per 1K input/output tokens on `InvokeModel` calls.
* **`ADDON_ENV_VARS` in `src/commands/add.js`:** Keep environment variable definitions in `ADDON_ENV_VARS` in `src/commands/add.js`:
  * `db:redis`: injects `REDIS_URL` pointing to `redis://<cluster_node_0_address>:6379`.
  * `queue:sqs`: injects `SQS_QUEUE_URL` (`aws_sqs_queue.main.id`) and `SQS_DLQ_URL` (`aws_sqs_queue.dlq.id`).
  * `ai:bedrock`: injects `BEDROCK_MODEL_ID` populated with the resolved model ID.

### 2. `runAdd(options = {})` Signature & `--model` Flag Handling (`src/commands/add.js`, `bin/cli.js`)
* Preserve the existing single-object signature `runAdd(options = {})` where `capability` is read from `options`.
* Export `DEFAULT_BEDROCK_MODEL` set to `us.anthropic.claude-sonnet-4-20250514-v1:0`.
* Default `model` to `DEFAULT_BEDROCK_MODEL` in both `parseAddArgs` and `runAdd` (matching the exact `partitionKey` pattern).
* Silently ignore `--model` when `capability` is not `ai:bedrock` (matching `--partition-key`).
* Validate `model` only when `capability === 'ai:bedrock'`, positioned immediately after the `UNSUPPORTED_CAPABILITY` check and before `TERRAFORM_NOT_INITIALIZED`:
  * Allow only alphanumeric characters, underscores, dots, colons, and hyphens.
  * On validation failure, match the exact failure convention of `INVALID_PARTITION_KEY`: log the error, track `add_run` with `projectName`, `capability`, `success: false`, and `error_code: 'INVALID_MODEL_ID'`, flush telemetry, call `process.exit(1)`, and return `{ ok: false, reason: 'invalid_model_id' }`.
* Update `HELP_TEXT` in `bin/cli.js` to include the new capabilities and `--model <id>`.

### 3. Parameterized Container Env Injection for `main.tf` and `worker.tf` (`src/commands/add.js`)
* Update `injectContainerEnvVars` so it is not hardcoded strictly to the `"app"` task definition resource name—either accept a target task definition resource name parameter (`"app"` vs `"worker"`) or match whichever `aws_ecs_task_definition` block is present in the file.
* Apply `injectContainerEnvVars` to `terraform/main.tf` as today, and if `terraform/worker.tf` exists in the project's `terraform` directory, also apply `injectContainerEnvVars` to `terraform/worker.tf` (for all capabilities in `runAdd`, including reruns of `storage:s3` and `db:dynamodb`) so worker containers receive the same addon environment variables as the web container.

---

## Part 2: Capability 1 — `db:redis` (`templates/terraform/addons/redis.tf` -> `terraform/redis.tf`)

1. **Networking & Security Group (Match `templates/terraform/network.tf`):**
   * Define `aws_elasticache_subnet_group.redis` named `${local.app_name}-redis-subnets` referencing `aws_subnet.public[*].id`.
   * Define `aws_security_group.redis` named `${local.app_name}-redis-sg` in `aws_vpc.main.id`:
     * Ingress: TCP port `6379` restricted strictly to `aws_security_group.ecs_tasks.id`.
     * Egress: standard all-traffic egress with the `trivy:ignore:AVD-AWS-0104` annotation to match `network.tf`.
2. **Collision-Free 20-Character Cluster ID (`aws_elasticache_cluster.redis`):**
   * AWS ElastiCache `cluster_id` allows at most 20 characters, must start with a letter, and cannot end with a hyphen. Pure prefix truncation cuts off the `-pr-N` suffix on project names >= 11 characters and collides across workspaces.
   * Construct `cluster_id` deterministically within 20 characters by combining:
     * A leading `ds-` prefix (3 chars, guaranteeing a leading ASCII letter),
     * Up to 5 characters of the sanitized lowercase `local.app_name` (trimmed of trailing hyphens),
     * A hyphen plus a 5-character substring of `md5(local.app_name)` (6 chars total, guaranteeing uniqueness between `default` and PR workspaces regardless of project name length),
     * The `-redis` suffix (6 chars, totaling at most 20 characters).
   * Configure `engine = "valkey"`, `engine_version = "8.0"`, `node_type = "cache.t4g.micro"`, `num_cache_nodes = 1`, `port = 6379`, `subnet_group_name`, and `security_group_ids`.
3. **Outputs:**
   * Output `redis_endpoint` (`cache_nodes[0].address`) and `redis_port` (`port`).

---

## Part 3: Capability 2 — `queue:sqs` (`templates/terraform/addons/sqs.tf` -> `terraform/sqs.tf`)

1. **Queues & Redrive Policy:**
   * `aws_sqs_queue.dlq`: named `${local.app_name}-dlq`, 14-day retention (`1209600` seconds), `sqs_managed_sse_enabled = true`.
   * `aws_sqs_queue.main`: named `${local.app_name}-queue`, 30s visibility timeout, 4-day retention (`345600` seconds), 20s long polling (`receive_wait_time_seconds = 20`), `sqs_managed_sse_enabled = true`, and `redrive_policy` targeting `aws_sqs_queue.dlq.arn` with `maxReceiveCount = 3`.
2. **Task Role IAM Policy (`aws_iam_role_policy.queue_sqs_access`):**
   * Named `${local.app_name}-queue-sqs-access` attached to `aws_iam_role.task_role.id`.
   * Grant `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:GetQueueAttributes`, and `sqs:GetQueueUrl` on both `aws_sqs_queue.main.arn` and `aws_sqs_queue.dlq.arn`.
3. **Worker Queue-Depth Auto-Scaling (`{{WORKER_AUTOSCALING_BLOCK}}`):**
   * Detect whether `worker.tf` exists in the project's `terraform` directory during `runAdd` and pass a boolean flag into `renderAddonTemplate`. When `worker.tf` exists, render the auto-scaling resources as active HCL; when absent, render the same block commented out with `# ` per line.
   * **Auto-Scaling Resources (Scale-Out + Scale-In):**
     * `aws_appautoscaling_target.worker_scale`: `service_namespace = "ecs"`, `scalable_dimension = "ecs:service:DesiredCount"`, `resource_id = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"`, `min_capacity = 0`, `max_capacity = 5`. (Note: AWS Application Auto Scaling automatically creates the `AWSServiceRoleForApplicationAutoScaling_ECSService` service-linked role upon target registration.)
     * **Scale-Out Policy & Alarm:** `aws_appautoscaling_policy.worker_scale_out` (`policy_type = "StepScaling"`, `adjustment_type = "ChangeInCapacity"`, `cooldown = 60`, step adjustment `+1` with `metric_interval_lower_bound = 0`) triggered by `aws_cloudwatch_metric_alarm.sqs_queue_high` (`AWS/SQS` `ApproximateNumberOfMessagesVisible`, `QueueName = aws_sqs_queue.main.name`, `statistic = "Average"`, `period = 60`, `evaluation_periods = 1`, `comparison_operator = "GreaterThanOrEqualToThreshold"`, `threshold = 1`).
     * **Scale-In Policy & Alarm (Scale back to zero):** `aws_appautoscaling_policy.worker_scale_in` (`policy_type = "StepScaling"`, `adjustment_type = "ChangeInCapacity"`, `cooldown = 300`, step adjustment `-5` with `metric_interval_upper_bound = 0`) triggered by `aws_cloudwatch_metric_alarm.sqs_queue_empty` (`AWS/SQS` `ApproximateNumberOfMessagesVisible`, `QueueName = aws_sqs_queue.main.name`, `statistic = "Maximum"`, `period = 60`, `evaluation_periods = 5`, `comparison_operator = "LessThanOrEqualToThreshold"`, `threshold = 0`).
   * **Worker `desired_count` Drift Prevention:** Add `lifecycle { ignore_changes = [desired_count] }` to `aws_ecs_service.worker` in `templates/terraform/worker.tf` (and update the `worker.tf` snapshot in `tests/generator.test.js`). Additionally, when `runAdd` runs `queue:sqs` on an existing project where `terraform/worker.tf` is present but lacks `ignore_changes`, idempotently inject `lifecycle { ignore_changes = [desired_count] }` into `aws_ecs_service.worker` in `terraform/worker.tf`.
4. **Outputs:**
   * Output `sqs_queue_url`, `sqs_queue_arn`, and `sqs_dlq_url`.

---

## Part 4: Capability 3 — `ai:bedrock` (`templates/terraform/addons/bedrock.tf` -> `terraform/bedrock.tf`)

1. **Task Role IAM Policy (`aws_iam_role_policy.ai_bedrock_access`):**
   * Named `${local.app_name}-ai-bedrock-access` attached to `aws_iam_role.task_role.id`.
   * Grant `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on both `arn:aws:bedrock:*::foundation-model/*` and `arn:aws:bedrock:*:*:inference-profile/*`.
2. **Template Placeholder & Output:**
   * Replace `{{BEDROCK_MODEL_ID}}` in `renderAddonTemplate` with the resolved model ID and expose `output "bedrock_model_id"`.

---

## Part 5: Visualizer, Viewport Budget & Doc Sync (`src/utils/visualizer.js`)

1. **Preserve `estimateMonthlyCost(config)` Contract:**
   * Keep the existing return object shape unchanged, summing `monthlyFixed` from active addons into the monthly total and deriving hourly cost as `total / 730`.
2. **Deterministic Viewport Compaction in `renderDryRunPreview(config)` (<= 14 Lines, <= 90 Columns):**
   * **Addon Tree Lines:**
     * When `1` or `2` addons are active, keep the existing per-addon tree line format (including the puzzle emoji and ANSI styling) so existing 2-addon tests continue to pass unchanged.
     * When `3` or more addons are active, collapse them into a single tree line displaying the puzzle emoji and `[Addons (<count>): <comma-separated capability keys>]` (e.g., `[Addons (5): storage:s3, db:dynamodb, db:redis, queue:sqs, ai:bedrock]`, which is 80 visible characters and never requires truncation).
   * **Fixed Baseline Line (`<= 90` visible characters):**
     * When fixed-cost addons (`monthlyFixed > 0`) are active, include `Addons: $<sum>` in `costParts`.
     * If the resulting `Est. Fixed Baseline:` line exceeds 90 visible characters (which happens when Fargate, ALB, RDS, Secrets, and Addons are all present simultaneously), switch the parenthetical breakdown to a compact form (e.g., omitting colons or folding minor items like `Secrets: $0.40` into the total) so the line stays strictly `<= 90` visible characters.
   * **Usage-Based Summary Line Suppression:**
     * Filter active addons to those with `(addon.cost?.monthlyFixed || 0) === 0`.
     * Only render the `+ Usage-based (<N> addon/addons): $0/mo fixed ...` line when that filtered count is strictly `> 0`. When only `db:redis` is active (zero usage-based addons), omit the usage-based line completely.
3. **Keep `### Active Addons (Usage-Based)` Heading in `syncDocCostEstimate`:**
   * Retain the existing heading string in `syncDocCostEstimate` for test compatibility.

---

## Part 6: Docs, Snapshots & Unit Tests

1. **Snapshots (`tests/generator.test.js`):**
   * Run `npx vitest run -u` to update the `Heroku_Procfile_Migration - worker.tf` snapshot after adding `lifecycle { ignore_changes = [desired_count] }` to `templates/terraform/worker.tf`.
2. **Documentation & Roadmap (`apps/docs/`, `README.md`):**
   * Update `apps/docs/src/content/docs/cli/add.md`, `apps/docs/src/content/docs/guides/ephemeral-pr-previews.md` (noting the `$9.49/mo` / `$0.013/hr` per-PR Valkey cluster cost when `db:redis` is used), `README.md`, and `apps/docs/src/content/docs/roadmap.md`.
   * Include a note in `cli/add.md` reminding users to enable model access in the AWS Bedrock console across backing `us.*` inference profile regions.
3. **Unit Tests (`tests/add.test.js` & `tests/visualizer.test.js`):**
   * Cover `db:redis` (including MD5-suffixed 20-char `cluster_id` uniqueness across workspaces and fixed cost impact), `queue:sqs` (both with and without `worker.tf`, verifying active vs. commented auto-scaling and `worker.tf` env var + `ignore_changes` injection), and `ai:bedrock` (default model, custom `--model`, `INVALID_MODEL_ID` exit/return behavior, and ignoring `--model` on other capabilities).
   * In `tests/visualizer.test.js`, test:
     * Only `db:redis` active (verifying `+ Usage-based` line is suppressed when 0 usage-based addons are present).
     * Maximal configuration (`hasDb: true`, `hasWorker: true`, `hasSecrets: true`, and all 5 addons active) asserting total box height `<= 14` lines and every line `<= 90` visible characters.