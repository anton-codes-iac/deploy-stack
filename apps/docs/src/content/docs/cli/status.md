---
title: status
description: Check ECS service health and CloudWatch alarms.
---

Instant health dashboard for your deployment. Exits cleanly when healthy; hands off to `diagnose` automatically when degraded.

## What it does

- Queries ECS (`desiredCount` vs `runningCount`/`pendingCount`) and project-prefixed CloudWatch alarms.
- Prints a color-coded dashboard: service status, replicas (green/yellow/red), and alarm states.
- If degraded (`runningCount < desiredCount` or any alarm firing), prints the degraded notice, invokes `diagnose`, and exits 1.
- Resolves region like `logs` (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`); cluster, service, and log group default to `<project-name>-cluster`, `<project-name>-service`, `/ecs/<project-name>` (overridable via `ECS_CLUSTER` / `ECS_SERVICE` / `ECS_LOG_GROUP`).
- Emits a `status_run` telemetry event recording health and outcome.

## Usage

```bash
npx deploy-stack status
npx deploy-stack status --json
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--json` | Output the raw status payload as JSON; disables auto-diagnose. |
| `--region <region>` | Explicit AWS region override. |
