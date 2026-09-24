---
title: gc
description: Discover and delete orphaned ECR images, CloudWatch log groups, and Elastic IPs.
---

Dry-run discovery and interactive deletion of orphaned AWS resources left behind by failed deployments, deleted PR previews, or manual console changes — protecting your AWS bill without leaving the terminal.

## What it does

- Scans ECR repositories matching `<project-name>-*` for untagged images and batch-deletes them.
- Scans CloudWatch log groups under `/ecs/<project-name>-*` (preview leftovers; the live `/ecs/<project-name>` group is never matched) and deletes them.
- Scans Elastic IPs and releases any without an association (stops the hourly unused-EIP charge).
- Paginates all discovery APIs, so large accounts are fully scanned.
- Prints a categorized dry-run summary with per-target counts before asking anything.

## Usage

```bash
npx deploy-stack gc
npx deploy-stack gc --region eu-west-1
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--region <region>` | Explicit AWS region override. |
| `--project-name <name>` | Explicit project name override (defaults to the current directory name). |

## Safety

Deletion requires explicit interactive confirmation (`Are you sure you want to permanently delete these orphaned resources? (y/N)`, defaulting to no). There is intentionally no `--yes` flag, so the command can never wipe resources from a CI pipeline by accident. Declining or cancelling deletes nothing; finding nothing skips the prompt entirely.

## See also

- [status](/deploy-stack/cli/status/)
- [Ephemeral PR Previews](/deploy-stack/guides/ephemeral-pr-previews/)
