---
title: logs
description: Stream CloudWatch logs for your ECS service.
---

Stream recent and live CloudWatch logs for the current project, without opening the AWS console.

## What it does

- Resolves the log group (`/ecs/<project-name>`, overridable via `ECS_LOG_GROUP`) and region (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`) automatically.
- Prints recent lines with dimmed ISO timestamps and task IDs; errors in red, warnings in yellow.
- With `-f`, polls every 2 seconds until Ctrl+C, which exits cleanly.
- On expired credentials, prints the `aws sso login` / `aws configure` hint and exits 1; on a missing log group, suggests the matching `aws logs describe-log-groups` lookup instead of throwing.
- Emits a `logs_streamed` telemetry event recording success and filter options.

## Usage

```bash
npx deploy-stack logs
npx deploy-stack logs api --tail 100 --error
npx deploy-stack logs -f --since 5m
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `[service]` | Service/container filter. Defaults to the project service. |
| `--tail <n>` | Recent lines to show (default `50`). |
| `-f, --follow` | Stream live until interrupted. |
| `--error` | Show only error lines (`ERROR`, `FATAL`, `Exception`, `fail`, `5XX`). |
| `--since <duration>` | Look-back window, e.g. `5m`, `1h`, `1d` (default `1h` for one-shot reads). |
| `--region <region>` | Explicit AWS region override. |

## See also

- [exec](/deploy-stack/cli/exec/)
- [status](/deploy-stack/cli/status/)
