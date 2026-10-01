# Spec: Serverless Compute Primitives (`deploy-stack --target lambda`)

## Overview
Provide an alternate **AWS Lambda + Amazon API Gateway HTTP API (v2)** deployment target (`--target lambda`) alongside the default ECS Fargate + ALB architecture (`--target ecs` / `fargate`). Using the **AWS Lambda Web Adapter** extension inside the generated container image, existing web applications (Node.js/Express, Next.js, FastAPI/Python, Go, Rust, etc.) run on AWS Lambda with zero application code changes and a **$0.00/mo fixed compute and load-balancer baseline**.

---

## 1. CLI Flags & Interactive Prompt (`src/core/parser.js` & `src/commands/init.js`)

### 1.1 Flag Parsing (`src/core/parser.js`)
* Support `--target <target>` in `parseArgs` / `extractInitOptions`:
  * Canonical values: `'ecs'` (default) and `'lambda'`.
  * Accept `'fargate'` as a synonym for `'ecs'`.
  * Reject unknown values before provisioning with `INVALID_COMPUTE_TARGET` (`✖ Invalid compute target "<value>". Supported targets: ecs, lambda`).

### 1.2 Interactive & Headless `init` (`src/commands/init.js`)
* In headless mode (`--headless`), default `target` to `'ecs'` unless `--target lambda` is explicitly passed.
* In interactive mode, if `--target` was not explicitly passed, prompt via `@clack/prompts` `select`:
  * Message: `"Select your AWS compute target:"`
  * Options:
    * `ecs` — `"ECS Fargate + ALB (Always-on containers, zero cold starts — ~$31.28/mo compute+ALB baseline)"`
    * `lambda` — `"AWS Lambda + API Gateway v2 (Scale-to-zero serverless containers — $0.00/mo fixed compute baseline)"`
* Pass `target` (`'ecs' | 'lambda'`) into `generateInfrastructure`, `renderPreFlightCard`, and `init_run` telemetry (`target: 'ecs' | 'lambda'`).

---

## 2. Container Image & AWS Lambda Web Adapter (`src/templates/dockerfile.js`)

* When `target === 'lambda'`, inject the official **AWS Lambda Web Adapter** layer into the generated `Dockerfile` (final runtime stage):
  ```dockerfile
  COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
  ENV AWS_LWA_PORT={{PORT}}
  ENV PORT={{PORT}}
  ```
* This allows standard HTTP servers (`app.listen(process.env.PORT)`) to handle API Gateway HTTP API v2 payloads transparently on Lambda without changing application code or handlers.

---

## 3. Generated Terraform Topology (`templates/terraform/main-lambda.tf` → `terraform/main.tf`)

When `target === 'lambda'`, write `templates/terraform/main-lambda.tf` to `terraform/main.tf`:

### 3.1 Preserved Core Resources (Addon & Command Compatibility)
* Keep the same resource names for shared primitives so `database.tf` and addons (`s3.tf`, `dynamodb.tf`, `bedrock.tf`, `ses.tf`, `sqs.tf`, `redis.tf`) remain compatible:
  * `aws_ecr_repository.app` and `aws_ecr_lifecycle_policy.app`
  * `aws_iam_role.task_role` (assumed by `["lambda.amazonaws.com", "ecs-tasks.amazonaws.com"]` so all addon `aws_iam_role_policy` attachments targeting `aws_iam_role.task_role.id` work out of the box)
  * `aws_iam_role.execution_role`
  * `aws_secretsmanager_secret.app_env` and `aws_secretsmanager_secret_version.app_env`
  * `aws_vpc.main`, `aws_subnet.public`, `aws_internet_gateway.main`, `aws_route_table.public`, `aws_security_group.ecs_tasks` (kept so RDS/Aurora `database.tf` and `redis.tf` security group references `aws_security_group.ecs_tasks.id` continue to validate cleanly)
  * GitHub OIDC provider & `aws_iam_role.github_actions` (updated to include `lambda:UpdateFunctionCode`, `lambda:GetFunction`, `lambda:GetFunctionConfiguration` alongside existing permissions).

### 3.2 Serverless Compute & Routing Resources
* **`aws_cloudwatch_log_group.app`:**
  * `name = "/aws/lambda/${local.app_name}-fn"` (or retain `/ecs/${local.app_name}` / alias so `deploy-stack logs` can discover it).
  * `retention_in_days = 30`
* **`aws_lambda_function.app`:**
  * `function_name = "${local.app_name}-fn"`
  * `role = aws_iam_role.task_role.arn`
  * `architectures = ["x86_64"]`
  * `memory_size = 512`
  * `timeout = 30`
  * `environment { variables = { PORT = tostring(var.container_port), AWS_LWA_PORT = tostring(var.container_port), APP_SECRETS_ARN = aws_secretsmanager_secret.app_env.arn, ... } }`
  * **Day-0 Bootstrap Compatibility:**
    * *Important AWS API note:* AWS Lambda `CreateFunction` with `package_type = "Image"` fails on Day-0 `terraform apply` if the newly created ECR repository has no image yet (`Source image does not exist`), unlike ECS `aws_ecs_task_definition`.
    * Evaluate and use the cleanest Day-0-safe pattern that passes `terraform validate`, `tflint`, and live `apply` before the first `git push` (or document how `apply` / `main-lambda.tf` handles Day-0 creation vs container deployment).
* **`aws_apigatewayv2_api.main`:**
  * `name = "${local.app_name}-http-api"`
  * `protocol_type = "HTTP"`
* **`aws_apigatewayv2_integration.lambda`:**
  * `api_id = aws_apigatewayv2_api.main.id`
  * `integration_type = "AWS_PROXY"`
  * `integration_uri = aws_lambda_function.app.invoke_arn`
  * `payload_format_version = "2.0"`
* **`aws_apigatewayv2_route.default` & `aws_apigatewayv2_stage.default`:**
  * `$default` route forwarding to `integrations/${aws_apigatewayv2_integration.lambda.id}` and `$default` stage with `auto_deploy = true`.
* **`aws_lambda_permission.apigw`:**
  * Grants `apigateway.amazonaws.com` `lambda:InvokeFunction` on `aws_lambda_function.app.function_name`.
* **`aws_cloudfront_distribution.cdn`:**
  * Fronts the API Gateway HTTP API domain (`replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")`) with `origin_protocol_policy = "https-only"` (since API Gateway v2 endpoints are HTTPS-only).
* **Outputs:**
  * `cloudfront_url = "https://${aws_cloudfront_distribution.cdn.domain_name}"`
  * `api_gateway_url = aws_apigatewayv2_api.main.api_endpoint` (replaces or complements `alb_dns_name`).

---

## 4. CI/CD Deployment Workflow (`templates/github/deploy-lambda.yml` → `.github/workflows/deploy.yml`)

* When `target === 'lambda'`, generate `.github/workflows/deploy.yml` from `templates/github/deploy-lambda.yml`:
  * Builds the Docker image (`linux/amd64`) with the AWS Lambda Web Adapter layer and pushes `${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}` and `:latest`.
  * Deploys to AWS Lambda via:
    ```bash
    aws lambda update-function-code \
      --function-name "${PROJECT_NAME}-fn" \
      --image-uri "${ECR_REGISTRY}/${ECR_REPOSITORY}:${IMAGE_TAG}"
    aws lambda wait function-updated \
      --function-name "${PROJECT_NAME}-fn"
    ```

---

## 5. Pre-Flight Cost & Topology Visualizer (`src/utils/visualizer.js`)

* Detect `computeTarget: 'lambda'` in `parseTerraformConfig` (when `terraform/main.tf` contains `resource "aws_lambda_function"` or via `config.target === 'lambda'`) and in `buildConfigFromInit`.
* When `computeTarget === 'lambda'`:
  * **Topology lines:**
    * Replace `🌐 ALB (Public Entry & Health: ...)` with `🌐 API Gateway HTTP API v2 (Scale-to-zero HTTPS entry)`.
    * Replace `📦 ECS Web Service ...` with `⚡ AWS Lambda Web Service 🟢 <framework> [512 MB · Scale-to-zero]`.
  * **Cost Calculation (`calculateMonthlyCost`):**
    * `fargate`: `$0.00` (for the web service; if a Fargate worker exists, only the worker bills Fargate).
    * `alb`: `$0.00` (API Gateway HTTP API v2 is usage-based at `$1.00` per million requests, `$0.00/mo` fixed baseline).
    * A Lambda + No-DB project shows `Fixed Baseline: ~$0.80/mo (Secrets: $0.80)`.
    * A Lambda + Aurora Serverless v2 (`0 ACU`) project shows `Fixed Baseline: ~$0.80/mo (RDS: $0.00, Secrets: $0.80)`.

---

## 6. Addon & Day-2 Command Compatibility

* **`deploy-stack add` (`src/commands/add.js`):**
  * When injecting container environment variables into `terraform/main.tf`, support both ECS (`environment = [` JSON array inside `container_definitions`) and Lambda (`environment { variables = { ... } }` block inside `aws_lambda_function.app`), or keep a shared local/map so `deploy-stack add s3`, `dynamodb`, `bedrock`, `ses`, `redis`, `sqs` work on `--target lambda` projects.
  * For `add cron` on a `--target lambda` project without ECS: either target `aws_lambda_function.app.arn` (`lambda:InvokeFunction`) or fail with a clear message if `cron` requires ECS.
* **`deploy-stack logs` (`src/commands/logs.js`):**
  * If `terraform/main.tf` is a Lambda target (`parseTerraformConfig(cwd).computeTarget === 'lambda'`), default the CloudWatch log group to `/aws/lambda/${appName}-fn`.

---

## 7. Documentation, Roadmap & Validation

1. **Documentation & Roadmap:**
   * Update `apps/docs/src/content/docs/cli/init.md` and `apps/docs/src/content/docs/guides/architecture.md` to document `--target lambda` and the scale-to-zero Lambda Web Adapter + API Gateway v2 topology.
   * Mark `[x] Serverless Compute Primitives: deploy-stack --target lambda` as completed in `apps/docs/src/content/docs/roadmap.md` (completing 19/19 items in Phase 10!).
2. **Tests & IaC Validation:**
   * Add unit tests in `tests/generator.test.js`, `tests/visualizer.test.js`, `tests/headless.test.js`, and `tests/add.test.js` covering `--target lambda`.
   * Add a `target: lambda` project check to `scripts/test-iac.js` and `.github/workflows/iac-validation.yml` so `templates/terraform/main-lambda.tf` is continuously validated with `terraform validate` and `tflint`.