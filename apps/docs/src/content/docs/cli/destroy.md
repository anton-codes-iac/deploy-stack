---
title: destroy
description: Tear down all AWS resources provisioned for this project.
---

Permanently delete the AWS infrastructure created by `apply` when a project is retired or needs a clean rebuild, protecting you from ongoing AWS charges.

## What it does

- Verifies you are in a deploy-stack project (`terraform/backend.tf` must exist) and that the `terraform` binary is installed, exiting otherwise.
- Asks for explicit confirmation before doing anything destructive; declining cancels with no changes.
- Runs `terraform destroy -auto-approve` in `terraform/`, streaming progress, so all compute resources (ECS, ALB, database, and related resources) are removed.
- Parses the state bucket name and region out of `terraform/backend.tf` (region defaults to `us-east-2` when not found), then optionally asks whether to also empty and delete the S3 state bucket via `teardownStateBucket`. Answering "No" keeps the bucket so `apply` can restore the infrastructure later.
- Emits an `infrastructure_destroyed` telemetry event recording success and whether the state bucket was retained.

## Usage

```bash
npx deploy-stack destroy
```

## Flags

This command accepts no CLI flags. Both confirmation prompts are interactive.

## See also

- [apply](/deploy-stack/cli/apply/)
- [doctor](/deploy-stack/cli/doctor/)
