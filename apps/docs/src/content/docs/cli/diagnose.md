---
title: diagnose
description: Diagnose failing ECS deployments from logs and task state.
---

Inspect recent ECS task failures and CloudWatch logs for the current project.

## What it does

- Saves you from digging through the AWS console by finding the most recently stopped ECS task for this project and showing why it stopped plus the failing container's recent log events (up to 50 lines).
- Resolves its inputs automatically: the AWS region from `AWS_REGION`, falling back to `region` in `terraform/main.tf` (default `us-east-2`); the cluster (`<project-name>-cluster`, overridable via `ECS_CLUSTER`); and the log group (`/ecs/<project-name>`, overridable via `ECS_LOG_GROUP`).
- Lists up to 10 recent stopped tasks, describes up to 5 of them, and diagnoses the most recently stopped one: stopped reason, failing container name, exit code, and container reason.
- Makes no changes to your infrastructure; it is read-only. Prints a healthy message and exits when no stopped tasks exist.
- On expired AWS credentials, points you to `aws sso login` / `aws configure` and the [AWS credentials guide](/guides/aws-credentials/), then exits with code 1 instead of throwing.
- Emits a `diagnose_run` telemetry event recording success and whether the service was healthy.

## Usage

```bash
npx deploy-stack diagnose
npx deploy-stack wtf
```

`wtf` is an alias for `diagnose`.

## Flags

This command accepts no CLI flags. Region, cluster, and log group are resolved as described above, not from flags.
