# Spec: FinOps Hibernation (`sleep` / `wake`), Scheduled Cron Jobs, and IaC Drift Detection

## Overview
Deliver three Day-2 operational and FinOps capabilities in Phase 10 to complete the ECS Fargate + RDS operational lifecycle:
1. **Environment Hibernation & FinOps (`deploy-stack sleep [env]` & `deploy-stack wake [env]`):** Pause non-production or idle environments with a single command by scaling ECS services (`app` and `worker`) to `0` and stopping RDS instances or Aurora Serverless v2 clusters, displaying exact hourly/monthly cost savings and guarding against AWS's 7-day RDS auto-restart behavior.
2. **Scheduled Cron Jobs (`deploy-stack add cron`):** Provision Amazon EventBridge Scheduler rules (`aws_scheduler_schedule`) that invoke ephemeral ECS Fargate tasks inside the private VPC on a `cron(...)` or `rate(...)` schedule with a `$0.00/mo` fixed baseline.
3. **Scheduled IaC Drift Detection (`deploy-stack init --setup-ci-drift` / `.github/workflows/drift.yml`):** Scaffold an automated GitHub Actions workflow that periodically runs `terraform plan -detailed-exitcode` against live AWS state and automatically opens/updates a GitHub Issue (and dispatches an optional Slack webhook) when out-of-band AWS Console changes are detected.

---

## Part 1: Environment Hibernation & FinOps (`deploy-stack sleep` & `deploy-stack wake`)

### 1. CLI Surface & Routing
* Register two new top-level commands in `bin/cli.js` and `src/core/parser.js`:
  * `deploy-stack sleep [env]` → `src/commands/sleep.js` (`runSleep`)
  * `deploy-stack wake [env]` → `src/commands/wake.js` (`runWake`)
* Supported flags for both commands:
  * Positional `[env]` or `--workspace <name>`: Optional workspace/environment name (e.g. `staging`, `dev`, `pr-42`). If provided, resolves resource names with the workspace suffix (`${projectName}-${env}`) matching Terraform's `local.app_name` convention (`terraform.workspace == "default" ? var.project_name : "${var.project_name}-${terraform.workspace}"`).
  * `--project-name <name>`, `--cluster <name>`, `--service <name>`, `--db-identifier <id>`, `--region <region>`.
  * `--skip-db`: Scale ECS services only and leave the database running.
  * `--wait` / `--no-wait`: On `wake`, wait for RDS/Aurora to become `available` and ECS tasks to reach `runningCount >= desiredCount` (default: wait with `pollUntil`, skippable with `--no-wait`).
  * `--yes` / `--force` / `--headless`: Skip interactive confirmation on `sleep` when targeting the default (`production`/`default`) environment.

### 2. Safety Guard on Production / Default Environment
* If no `[env]` / `--workspace` is specified (or `env === 'default'` / `'prod'` / `'production'`) and `--yes` / `--force` / `--headless` is not passed:
  * Prompt interactively via `@clack/prompts` `confirm` (`"Put environment to sleep? This will take the web service offline until you run 'deploy-stack wake'."`, default `false`).
  * When a non-default environment is passed (e.g., `deploy-stack sleep staging`), proceed without requiring an extra confirmation prompt.

### 3. `deploy-stack sleep` Execution Flow
1. **Resolve Target Context:**
   * Resolve region (`resolveAwsRegion`), project name (`resolveProjectName`), and effective app prefix (`env && env !== 'default' ? `${projectName}-${env}` : projectName`).
   * Inspect `terraform/` files locally (if present) via `parseTerraformConfig` to know whether `worker.tf` and `database.tf` exist and which `dbEngine` is configured.
2. **Scale ECS Services to Zero:**
   * Query `DescribeServicesCommand` on cluster `${appPrefix}-cluster` for `${appPrefix}-service` and (if present in `terraform/worker.tf` or discovered in the cluster) `${appPrefix}-worker`.
   * Record the pre-sleep `desiredCount` (or default to `1` for web, `1` for worker) in memory/output, and call `UpdateServiceCommand({ cluster, service, desiredCount: 0 })` for each active service whose `desiredCount > 0`.
   * If a service is already at `desiredCount === 0`, report it as already asleep (idempotent).
3. **Stop Database (Unless `--skip-db`):**
   * Use `findDbTarget(rdsClient, dbIdentifier, cwd)` from `src/utils/rds.js`.
   * **Standard RDS Instance (`kind === 'instance'`):**
     * If `status === 'available'`, call `StopDBInstanceCommand({ DBInstanceIdentifier: id })`.
     * If `status === 'stopped'` or `'stopping'`, treat as idempotent and report already stopped/stopping.
   * **Aurora Cluster (`kind === 'cluster'`):**
     * If `status === 'available'`, call `StopDBClusterCommand({ DBClusterIdentifier: id })` (or if it is already configured with `0 ACU` auto-pause, note that stopping the cluster halts compute immediately and prevents wake-ups until `deploy-stack wake`).
4. **7-Day AWS RDS Auto-Restart Guard & Savings Summary:**
   * AWS automatically restarts stopped RDS instances and Aurora clusters after **7 consecutive days**.
   * Print a clear warning with the exact UTC timestamp (`now + 7 days`):
     * `⚠ AWS Note: Stopped RDS databases automatically restart after 7 days (<YYYY-MM-DD HH:mm UTC>). Re-run "npx deploy-stack sleep" or "npx deploy-stack destroy" for longer archiving.`
   * Persist a lightweight state marker in `.deploy-stack/sleep-state.json` (gitignored if `.deploy-stack/` is local, or purely advisory) recording `{ env, sleptAt, autoRestartAt, services: { app: prevDesiredCount, worker: prevWorkerDesiredCount }, dbId, dbKind }` so `deploy-stack wake` (and `deploy-stack status`) can restore exact replica counts and warn if the 7-day window has elapsed.
   * **FinOps Savings Calculation:**
     * Calculate and display the exact hourly and monthly compute savings using the rates from `src/utils/visualizer.js`:
       * Web Fargate task (`$9.01/mo` = `~$0.0123/hr` per replica)
       * Worker Fargate task (`$9.01/mo` = `~$0.0123/hr` per replica when active)
       * RDS `db.t4g.micro` (`$13.98/mo` = `~$0.0192/hr` compute paused; note that `20 GB` gp3 storage `~$2.30/mo` and ALB `$22.27/mo` remain active while infrastructure exists).
     * Example output:
       `💰 Estimated Savings While Asleep: ~$0.032/hr (~$22.99/mo in Fargate + RDS compute paused)`
       `Wake anytime with: npx deploy-stack wake [env]`
   * Emit `trackSuccess('sleep_run', { env_kind: isDefault ? 'default' : 'named', ecs_scaled: count, db_stopped: boolean, db_kind })`.

### 4. `deploy-stack wake` Execution Flow
1. **Start Database First (Unless `--skip-db`):**
   * Resolve database via `findDbTarget`.
   * If `status === 'stopped'`, call `StartDBInstanceCommand` (`kind === 'instance'`) or `StartDBClusterCommand` (`kind === 'cluster'`).
   * Unless `--no-wait` is passed, poll with `pollUntil` (`DescribeDBInstancesCommand` / `DescribeDBClustersCommand`) until `status === 'available'` before starting ECS tasks so booting containers never crash-loop on an unreachable database.
2. **Restore ECS Service Desired Counts:**
   * Read `.deploy-stack/sleep-state.json` if present for the target `env` to restore previous `desiredCount` values (defaulting to `desiredCount = 1` for `${appPrefix}-service` and `desiredCount = 1` for `${appPrefix}-worker` if no state file exists).
   * Call `UpdateServiceCommand({ cluster, service, desiredCount })`.
   * Remove the entry for `env` from `.deploy-stack/sleep-state.json`.
   * Emit `trackSuccess('wake_run', { env_kind, ecs_restored: count, db_started: boolean, waited: boolean })`.

---

## Part 2: Scheduled Cron Jobs (`deploy-stack add cron`)

### 1. Capability Registration & CLI Flags
* Add `cron` (or `cron:scheduler` with alias `cron`) to `SUPPORTED_CAPABILITIES` in `src/utils/addons.js` and `src/commands/add.js`.
* Supported flags on `deploy-stack add cron`:
  * `--schedule <expression>`: EventBridge Scheduler expression, e.g. `"cron(0 2 * * ? *)"` or `"rate(1 hour)"`. If omitted in interactive mode, prompt via `@clack/prompts` with common presets (`Hourly — rate(1 hour)`, `Daily at 00:00 UTC — cron(0 0 * * ? *)`, `Every 15 minutes — rate(15 minutes)`, `Custom expression...`). In headless mode without `--schedule`, default to `"cron(0 0 * * ? *)"` (daily at midnight UTC).
  * `--cmd <command>` / `--cron-command <command>`: Command to execute inside the container when triggered (e.g. `"npm run cron"` or `"node scripts/cleanup.js"`). In headless mode without `--cmd`, default to `"npm run cron"`.
  * `--name <job-name>`: Optional job slug (default: `"default"` or `"daily-job"`, sanitized to `[a-z0-9-]`), allowing multiple named schedules or updating in place with `--force`.
  * `--timezone <tz>`: Optional IANA timezone string for `schedule_expression_timezone` (default: `"UTC"`).
* Validate `--schedule` before the Terraform guard: must match `/^(cron|rate|at)\(.+\)$/` (`INVALID_CRON_SCHEDULE`).
* Validate `--timezone` against safe characters `/^[A-Za-z0-9/_+-]{1,64}$/` (`INVALID_TIMEZONE`).

### 2. Generated Terraform (`templates/terraform/addons/cron.tf` → `terraform/cron.tf`)
* Provision:
  1. **`aws_iam_role.scheduler_cron_role`:** Assumed by `scheduler.amazonaws.com`.
  2. **`aws_iam_role_policy.scheduler_cron_policy`:** Grants `ecs:RunTask` on `aws_ecs_task_definition.app.arn` (both revision-specific and family wildcard `${aws_ecs_task_definition.app.family}:*`) and `iam:PassRole` on `aws_iam_role.execution_role.arn` and `aws_iam_role.task_role.arn` (with `Condition: { StringLike: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }`).
  3. **`aws_scheduler_schedule.cron`:**
     * `name = "${local.app_name}-cron-__CRON_NAME__"`
     * `flexible_time_window { mode = "OFF" }`
     * `schedule_expression = "__SCHEDULE_EXPRESSION__"`
     * `schedule_expression_timezone = "__SCHEDULE_TIMEZONE__"`
     * `target`:
       * `arn = aws_ecs_cluster.main.arn`
       * `role_arn = aws_iam_role.scheduler_cron_role.arn`
       * `ecs_parameters`:
         * `task_definition_arn = aws_ecs_task_definition.app.arn`
         * `launch_type = "FARGATE"`
         * `task_count = 1`
         * `network_configuration` using `aws_subnet.public[*].id`, `[aws_security_group.ecs_tasks.id]`, and `assign_public_ip = true` (matching `aws_ecs_service.app` so it can pull from ECR and reach RDS without a NAT Gateway).
       * `input = jsonencode({ containerOverrides = [{ name = "${local.app_name}-container", command = ["sh", "-c", __CRON_COMMAND_JSON__] }] })`
* Ensure all generated HCL in `cron.tf` passes `terraform validate` and `tflint` with zero warnings.
* **Cost Metadata (`src/utils/addons.js`):**
  * `monthlyCost: 0.0`
  * `pricingModel: 'usage'`
  * `costImpact: '$0/mo fixed baseline (first 14M EventBridge Scheduler invocations/mo free); billed only for Fargate seconds while the cron task runs'`

---

## Part 3: Scheduled IaC Drift Detection (`.github/workflows/drift.yml`)

### 1. CLI Integration (`deploy-stack drift` or `init --setup-ci-drift`)
* Support two entrypoints so both new and existing projects can enable Scheduled IaC Drift Detection:
  1. **During `deploy-stack init`:**
     * New flag `--setup-ci-drift` in `src/core/parser.js` and `src/commands/init.js`.
     * When `--setup-ci-drift` is passed (or offered in interactive `init`), scaffold `.github/workflows/drift.yml`.
  2. **On existing projects (`deploy-stack drift` or `deploy-stack drift --setup`):**
     * Register `drift` in `bin/cli.js` → `src/commands/drift.js` (`runDrift`).
     * `deploy-stack drift --setup` (or `deploy-stack drift init`): Scaffolds `.github/workflows/drift.yml` into an already-initialized project (reading region and state bucket from `terraform/main.tf` and `terraform/backend.tf`).
     * `deploy-stack drift` (default check mode): Executes `terraform init -input=false` + `terraform plan -detailed-exitcode -no-color` locally in `terraform/`, interpreting exit code `0` (`✅ No infrastructure drift detected`), exit code `2` (`⚠ Infrastructure drift detected!` with the resource diff summary and `error_code: 'DRIFT_DETECTED'`), and exit code `1` (`TERRAFORM_PLAN_FAILED`).

### 2. Generated GitHub Actions Workflow (`templates/github/drift.yml` → `.github/workflows/drift.yml`)
* **Triggers:**
  * `schedule: [{ cron: '0 6 * * *' }]` (daily at 06:00 UTC)
  * `workflow_dispatch: {}` (manual one-click trigger in GitHub Actions UI)
* **Permissions:**
  * `id-token: write` (for AWS OIDC role assumption)
  * `contents: read`
  * `issues: write` (to open/update GitHub Issues when drift is detected)
* **Steps:**
  1. Checkout repository (`actions/checkout@v4`).
  2. Configure AWS credentials via the existing GitHub OIDC role (`aws-actions/configure-aws-credentials@v4` with `${{ secrets.AWS_ROLE_ARN }}` and the project's `AWS_REGION`).
  3. Setup Terraform (`hashicorp/setup-terraform@v3`, `terraform_wrapper: false`).
  4. Run `terraform init -input=false` in `working-directory: ./terraform`.
  5. Run `terraform plan -detailed-exitcode -no-color -out=tfplan` in `./terraform`, capturing the exit code (`0`, `1`, or `2`) and saving human-readable diff output (`terraform show -no-color tfplan > plan.txt`).
  6. **Automated Issue Creation / Update on Exit Code `2`:**
     * Use `actions/github-script@v7` (or `gh issue`) when `steps.plan.outputs.exitcode == '2'` to search for an open issue labeled `iac-drift` (creating the label if needed):
       * If an open `iac-drift` issue already exists, update its body/comment with the latest timestamp and Terraform plan diff (avoiding duplicate daily issue spam).
       * Otherwise, open a new issue titled `"⚠️ Infrastructure Drift Detected in AWS"` containing the truncated Terraform plan diff and remediation commands (`npx deploy-stack apply` to reconcile or `terraform import`).
     * If `steps.plan.outputs.exitcode == '0'` and an open `iac-drift` issue exists, automatically comment `"✅ Drift resolved"` and close the issue!
  7. **Optional Slack Notification:**
     * If `${{ secrets.SLACK_WEBHOOK_URL }}` is configured and exit code is `2`, POST a JSON alert payload with the repository name, workflow run link, and drift summary.

---

## Part 4: Documentation, Roadmap & Validation

### 1. Documentation & Roadmap Updates
* Create `apps/docs/src/content/docs/cli/sleep.md` (covering `deploy-stack sleep` and `deploy-stack wake`) and `apps/docs/src/content/docs/cli/drift.md` (covering `deploy-stack drift` and `.github/workflows/drift.yml`), and register them in the Starlight sidebar if configured.
* Update `apps/docs/src/content/docs/cli/add.md` with `deploy-stack add cron` (`--schedule`, `--cmd`, `--name`, `--timezone`).
* Check off the 3 items in `apps/docs/src/content/docs/roadmap.md`:
  * `[x] Scheduled Cron Jobs`
  * `[x] Environment Hibernation & FinOps`
  * `[x] Scheduled IaC Drift Detection`

### 2. Tests & IaC Validation
* Add unit tests:
  * `tests/sleep-wake.test.js`: Verify ECS scaling to `0`, RDS `StopDBInstanceCommand` / `StopDBClusterCommand`, `--skip-db`, 7-day auto-restart warning output, `.deploy-stack/sleep-state.json` persistence, `wake` RDS polling before ECS restore, and production confirmation guard.
  * `tests/add.test.js`: Verify `deploy-stack add cron` renders `terraform/cron.tf`, validates `--schedule` and `--timezone`, supports `--cmd` and `--name`, and emits `add_run` telemetry.
  * `tests/drift.test.js`: Verify `deploy-stack drift --setup` generates valid `.github/workflows/drift.yml` YAML, and `deploy-stack drift` handles `terraform plan -detailed-exitcode` exit codes `0`, `1`, and `2`.
* Extend `scripts/test-iac.js` and `.github/workflows/iac-validation.yml` so `cron` is included in the `--with` addons validation run (`terraform validate` + `tflint`).