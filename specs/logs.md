# Spec: Context-Aware Log Streaming (`deploy-stack logs`)

## Objective
Provide real-time and historical CloudWatch log streaming directly in the terminal, automatically mapped to the ECS task and cluster without requiring the user to look up log group names or open the AWS Management Console.

## CLI Command & Flags
\`\`\`bash
deploy-stack logs [service] [options]
\`\`\`
- `[service]` (optional): Name of the service/container. Defaults to the primary application service defined in `terraform/main.tf`.
- `--tail <lines>`: Number of recent log lines to display (default: `50`).
- `-f, --follow`: Stream logs continuously in real time (polling interval: 2 seconds).
- `--error`: Filter output for common failure keywords (`ERROR`, `FATAL`, `Exception`, `fail`, `500`, `502`).
- `--since <duration>`: Filter logs from a relative time window (e.g., `5m`, `1h`, `1d`). Default: `1h` when not following.
- `--region <region>`: Explicit AWS region override.

## Precedence & Resolution
1. **Region Precedence:** `--region` flag -> `AWS_REGION` environment variable -> `terraform/main.tf` (`region = "..."`) -> fallback `us-east-2`.
2. **Log Group Resolution:** Infer the CloudWatch log group `/ecs/<project-name>` by reading `terraform/main.tf` or project config. If not found, list log groups matching the project prefix.
3. **AWS Session Handling:** On `ExpiredTokenException` or `UnrecognizedClientException`, print the standard recovery guidance (`aws sso login` / `aws configure`) and exit with code 1.

## Output Formatting
- Standardize on `picocolors`.
- Prefix each line with formatted ISO timestamp (dimmed/gray) and task ID (dimmed).
- Highlight lines containing errors or HTTP 5XX statuses in red; warnings in yellow.
- Handle `SIGINT` (Ctrl+C) gracefully when following streams, printing a clean exit message without uncaught rejection traces.

## Testing & Stability Requirements
- Add comprehensive Vitest unit tests in `tests/logs.test.js`.
- Mock `@aws-sdk/client-cloudwatch-logs` (`FilterLogEventsCommand`, `DescribeLogStreamsCommand`).
- Verify region resolution precedence, error filtering, line count truncation, and graceful exit on missing log groups.
- Zero network dependencies during test execution.