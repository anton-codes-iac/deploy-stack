# Spec: Modular Service Engine (`deploy-stack add`) — `storage:s3` & `db:dynamodb`

## Overview
Introduce the `deploy-stack add <capability>` command to provision modular Day-2 cloud primitives without requiring users to write Terraform, configure IAM policies, or open the AWS Management Console. This implementation establishes the table-driven `ADDON_REGISTRY` architecture, consolidates project/region resolution in `src/utils/resolvers.js`, and delivers two scale-to-zero primitives:
1. **`deploy-stack add storage:s3`**: Private S3 bucket with CloudFront Origin Access Control (OAC), CORS rules for browser uploads, and least-privilege IAM permissions on `aws_iam_role.task_role`.
2. **`deploy-stack add db:dynamodb`**: Scale-to-zero (`PAY_PER_REQUEST`) DynamoDB table with Point-in-Time Recovery (PITR), a free VPC Gateway Endpoint wired to `aws_route_table.public`, and least-privilege IAM task permissions.

Because addon files (`terraform/s3.tf`, `terraform/dynamodb.tf`) live directly inside `terraform/` and use `local.app_name`, `deploy-stack destroy` automatically tears them down as part of the Terraform state, `deploy-stack eject` naturally leaves them in place as standard HCL files, and PR-preview workspaces deliberately receive isolated per-workspace buckets/tables.

---

## Part 1: Resolver Deduplication & CLI Dispatch (`src/utils/resolvers.js`, `src/commands/add.js`, `bin/cli.js`)

### 1. Extend `src/utils/resolvers.js` (Single Source of Truth)
Instead of duplicating flag/file/basename resolution inside `add.js`, extend `src/utils/resolvers.js`:
* **`resolveProjectName(options = {}, cwd = process.cwd())`:**
  1. If `options.projectName` is provided (mapped from `--project-name`), return it.
  2. Otherwise, if `terraform/main.tf` exists in `cwd`, extract the project name from the rendered file by matching either:
     * `app_name\s*=\s*"([^"$]+)\$\{local\.env_suffix\}"` (from `locals`), or
     * `resource\s+"aws_ecr_repository"\s+"app"\s*\{[^}]*?name\s*=\s*"([^"]+)-repo"`
  3. Fall back to `path.basename(cwd)`.
* Reuse `resolveRegion(options, cwd)` and `resolveProjectName(options, cwd)` in `src/commands/add.js`.

### 2. Command Signature & `ADDON_REGISTRY`
```bash
deploy-stack add <capability> [--region <region>] [--project-name <name>] [--partition-key <key>] [--force]
```
* Keep the `add` branch in `bin/cli.js` thin (and add a `deploy-stack add <capability>` line to `HELP_TEXT`), delegating capability lookup to a table-driven `ADDON_REGISTRY` inside `src/commands/add.js`.
* **Supported `<capability>` keys:** `'storage:s3'` and `'db:dynamodb'`.
* **Flag Scoping & Validation:**
  * `parseAddArgs(args)` must support both `--flag value` and `--flag=value` forms, mapping `--project-name` to `projectName`, `--partition-key` to `partitionKey` (default `'id'`), `--region` to `region`, and `--force` (supporting both bare `--force` -> `true` and `--force=true` / `--force=false` for parity with other CLI parsers).
  * `--partition-key` applies only to `db:dynamodb` (ignore if not passed; if passed, validate that it matches `/^[a-zA-Z0-9_.-]+$/` so it cannot break HCL interpolation, throwing a validation error with `error_code: 'INVALID_PARTITION_KEY'` otherwise).
* **Unknown / Missing Capability:**
  * If `<capability>` is omitted or not in `ADDON_REGISTRY`, print a clear error listing supported capabilities (`storage:s3`, `db:dynamodb`), emit `trackEvent('add_run', { capability: capability || 'none', success: false, error_code: 'UNSUPPORTED_CAPABILITY' })`, `await flushTelemetry()`, and exit/throw.

### 3. Preconditions & Idempotency
* **Terraform Project Guard:** Verify that `terraform/main.tf` exists in `cwd`. If missing, print `No terraform/main.tf found. Run "deploy-stack init" first before adding services.`, emit `trackEvent('add_run', { capability, success: false, error_code: 'TERRAFORM_NOT_INITIALIZED' })`, `await flushTelemetry()`, and exit/throw.
* **Idempotency & `--force` Guard:**
  * `storage:s3` writes `terraform/s3.tf`.
  * `db:dynamodb` writes `terraform/dynamodb.tf`.
  * If the target `.tf` file already exists and `--force` is **not** set, print a warning (`terraform/<file>.tf already exists. Pass --force to overwrite.`), emit `trackEvent('add_run', { projectName, capability, success: false, error_code: 'ADDON_ALREADY_EXISTS' })`, `await flushTelemetry()`, and return without modifying files.

---

## Part 2: IAM Role Binding & Container Environment Injection (`src/commands/add.js`)

### 1. Attach Policies to Existing `aws_iam_role.task_role`
* `templates/terraform/main.tf` already defines `aws_iam_role.task_role` (line 76) and wires `task_role_arn = aws_iam_role.task_role.arn` (line 116).
* Do **not** modify `templates/terraform/main.tf` or create a duplicate role. Reference `role = aws_iam_role.task_role.id` directly in the `aws_iam_role_policy` blocks inside `s3.tf` and `dynamodb.tf`.

### 2. Deterministic `injectContainerEnvVars(mainTfContent, envEntries)`
The user's generated `terraform/main.tf` contains an already-rendered `environment = [...]` block inside `aws_ecs_task_definition.app` (`container_definitions = jsonencode([...])`), potentially alongside compose env vars, database env vars, and secondary containers.
* **Anchor Strategy:**
  1. Locate `resource "aws_ecs_task_definition" "app"` in `terraform/main.tf`.
  2. Find the **first** `environment = [` array inside that resource (which belongs to the primary app container, prior to any secondary containers).
  3. Walk the balanced square brackets `[...]` of that `environment` array.
  4. For each `{ name, value }` in `envEntries`:
     * Check if `{ name = "<NAME>"` (or `"name": "<NAME>"`) already exists inside that `environment` block. If it already exists, skip inserting a duplicate (ensuring idempotent reruns with `--force`).
     * Otherwise, insert `{ name = "${entry.name}", value = "${entry.value}" }` cleanly before the closing `]` of that `environment` array.
* **Injected Variables:**
  * For `storage:s3`:
    * `S3_BUCKET_NAME` -> `${aws_s3_bucket.storage.id}`     * `S3_CDN_URL` -> `https://${aws_cloudfront_distribution.storage_cdn.domain_name}`
  * For `db:dynamodb`:
    * `DYNAMODB_TABLE_NAME` -> `${aws_dynamodb_table.main.name}`  ---  ## Part 3: Capability 1 — `storage:s3` (`templates/terraform/addons/s3.tf` -> `terraform/s3.tf`)  Render `terraform/s3.tf` with the following specifications:  1. **Workspace-Aware Naming & S3 63-Character / Lowercase Rules:**    * Include `data "aws_caller_identity" "current" {}` in `s3.tf`.    * Because `-storage-<12-digit-account-id>` takes 21 characters, truncate and sanitize the prefix (`local.app_name`) to at most 42 characters, lowercase it, and strip any trailing hyphen **before** appending `-storage-${data.aws_caller_identity.current.account_id}` so the full account ID is never truncated and S3 naming rules are always satisfied:
     `bucket = "${trimsuffix(substr(lower(local.app_name), 0, 42), "-")}-storage-${data.aws_caller_identity.current.account_id}"`
2. **Private S3 Bucket (`aws_s3_bucket.storage`):**
   * `aws_s3_bucket_public_access_block.storage`: `block_public_acls = true`, `block_public_policy = true`, `ignore_public_acls = true`, `restrict_public_buckets = true`.
   * `aws_s3_bucket_server_side_encryption_configuration.storage`: `sse_algorithm = "AES256"`.
   * `aws_s3_bucket_cors_configuration.storage`: Allow `["GET", "PUT", "POST", "DELETE", "HEAD"]`, `allowed_origins = ["*"]` (include an HCL comment noting this is intentionally open for zero-config presigned uploads and can be restricted to the app domain), `allowed_headers = ["*"]`, `expose_headers = ["ETag"]`, `max_age_seconds = 3000`.
3. **CloudFront Distribution (`aws_cloudfront_distribution.storage_cdn`):**
   * Coexists cleanly alongside `aws_cloudfront_distribution.cdn` (the ALB distribution in `main.tf`).
   * `aws_cloudfront_origin_access_control.storage_oac`: `origin_access_control_origin_type = "s3"`, `signing_behavior = "always"`, `signing_protocol = "sigv4"`.
   * `aws_cloudfront_distribution.storage_cdn`: Point origin to `aws_s3_bucket.storage.bucket_regional_domain_name` with `origin_access_control_id = aws_cloudfront_origin_access_control.storage_oac.id`, `viewer_protocol_policy = "redirect-to-https"`, `allowed_methods = ["GET", "HEAD", "OPTIONS"]`, `cached_methods = ["GET", "HEAD"]`, `cloudfront_default_certificate = true`, and standard `forwarded_values` (`query_string = false`, `cookies { forward = "none" }`).
   * `aws_s3_bucket_policy.storage_oac_policy`: Grant principal `cloudfront.amazonaws.com` action `s3:GetObject` on `${aws_s3_bucket.storage.arn}/*` conditioned on `StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.storage_cdn.arn }`. 4. **Least-Privilege IAM Policy (`aws_iam_role_policy.storage_s3_access`):**    * Attach to `role = aws_iam_role.task_role.id` granting `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on `aws_s3_bucket.storage.arn` and `${aws_s3_bucket.storage.arn}/*`.
5. **Outputs:**
   * `output "s3_bucket_name" { value = aws_s3_bucket.storage.id }`
   * `output "s3_cdn_domain" { value = aws_cloudfront_distribution.storage_cdn.domain_name }`

---

## Part 4: Capability 2 — `db:dynamodb` (`templates/terraform/addons/dynamodb.tf` -> `terraform/dynamodb.tf`)

Render `terraform/dynamodb.tf` with the following specifications:

1. **Workspace-Aware Scale-to-Zero Table (`aws_dynamodb_table.main`):**
   * `name = "${local.app_name}-table"` (deliberately isolates PR-preview workspaces with their own table via `local.app_name`).    * `billing_mode = "PAY_PER_REQUEST"`    * `hash_key = "{{PARTITION_KEY}}"` (defaults to `"id"`, fixed type `"S"`, no sort key/GSI in v1)    * `attribute { name = "{{PARTITION_KEY}}", type = "S" }`    * `point_in_time_recovery { enabled = true }`    * `server_side_encryption { enabled = true }` 2. **Free VPC Gateway Endpoint (`aws_vpc_endpoint.dynamodb`):**    * `vpc_id = aws_vpc.main.id`    * `service_name = "com.amazonaws.{{REGION}}.dynamodb"`    * `vpc_endpoint_type = "Gateway"`    * `route_table_ids = [aws_route_table.public.id]` (referencing `aws_route_table.public` defined in `terraform/network.tf`). 3. **Least-Privilege IAM Policy (`aws_iam_role_policy.dynamodb_access`):**    * Attach to `role = aws_iam_role.task_role.id` granting `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`, `dynamodb:Query`, `dynamodb:Scan`, `dynamodb:BatchGetItem`, `dynamodb:BatchWriteItem`, `dynamodb:DescribeTable` on `aws_dynamodb_table.main.arn` and `${aws_dynamodb_table.main.arn}/index/*`.
4. **Outputs:**
   * `output "dynamodb_table_name" { value = aws_dynamodb_table.main.name }`
   * `output "dynamodb_table_arn" { value = aws_dynamodb_table.main.arn }`

---

## Part 5: UX, Docs & Testing

1. **Terminal UX & Telemetry:**
   * Display `intro(' deploy-stack add 🧩 ')`, log created/updated files and injected env vars (`S3_BUCKET_NAME`, `S3_CDN_URL`, or `DYNAMODB_TABLE_NAME`), and display `outro(...)` instructing the user to run `deploy-stack apply`.
   * Emit `trackEvent('add_run', { projectName, capability, success: true })` and `await flushTelemetry()`.
2. **Documentation (`apps/docs/src/content/docs/cli/add.md`):**
   * Document `deploy-stack add storage:s3` and `deploy-stack add db:dynamodb`, including flags (`--partition-key`, `--force`, `--region`, `--project-name`) and the injected container environment variables.
3. **Unit Tests (`tests/add.test.js` & `tests/resolvers.test.js`):**
   * Test `resolveProjectName` extraction from rendered `terraform/main.tf` (`local.app_name` and `aws_ecr_repository.app`) and `--project-name` override.
   * Test `parseAddArgs` (including `--flag value`, `--flag=value`, and `--force=false` forms) and invalid `--partition-key` rejection (`INVALID_PARTITION_KEY`).
   * Test missing `terraform/main.tf` (`TERRAFORM_NOT_INITIALIZED`), unknown capability (`UNSUPPORTED_CAPABILITY`), and existing addon file with/without `--force` (`ADDON_ALREADY_EXISTS`).
   * Test `injectContainerEnvVars` against a real generated `terraform/main.tf` (including multi-container / existing env vars), verifying idempotency when run twice with `--force`.
   * Verify generated `terraform/s3.tf` references `aws_iam_role.task_role.id`, uses `"${trimsuffix(substr(lower(local.app_name), 0, 42), "-")}-storage-${data.aws_caller_identity.current.account_id}"`, and configures OAC + AES256 + CORS.
   * Verify generated `terraform/dynamodb.tf` references `aws_iam_role.task_role.id`, `route_table_ids = [aws_route_table.public.id]`, `PAY_PER_REQUEST`, PITR, and custom `--partition-key`.