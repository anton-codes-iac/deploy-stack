---
title: add
description: Provision modular cloud addons like private S3 storage or DynamoDB tables.
---

Provision modular Day-2 cloud primitives without writing Terraform, configuring IAM policies, or opening the AWS Management Console.

## What it does

- `storage:s3` creates a private S3 bucket (encrypted, CloudFront OAC, CORS ready for presigned browser uploads) and injects `S3_BUCKET_NAME` and `S3_CDN_URL` into your container.
- `db:dynamodb` creates a `PAY_PER_REQUEST` DynamoDB table (no fixed hourly instance cost) with Point-in-Time Recovery, a free VPC Gateway Endpoint, and injects `DYNAMODB_TABLE_NAME` into your container.
- Both attach least-privilege IAM policies to your ECS task role, so your application code can use the AWS SDK with no extra configuration.
- Addon files live in `terraform/` (`s3.tf`, `dynamodb.tf`), so `destroy` tears them down and `eject` keeps them automatically. PR-preview workspaces get isolated per-workspace buckets and tables.

## Usage

```bash
npx deploy-stack add storage:s3
npx deploy-stack add db:dynamodb
npx deploy-stack add db:dynamodb --partition-key userId
npx deploy-stack add storage:s3 --force
```

After adding, run `deploy-stack apply` (or commit and push to trigger CI) to provision the resource.

## Flags

| Flag | Description |
| ---- | ----------- |
| `--region <region>` | Explicit AWS region override. |
| `--project-name <name>` | Explicit project name override (defaults to the name in `terraform/main.tf`, then the directory name). |
| `--partition-key <key>` | DynamoDB partition key name (default `id`). Letters, numbers, underscore, hyphen, and dot only. Only applies to `db:dynamodb`. |
| `--force` | Overwrite the existing addon file (also accepts `--force=false`). Without it, re-adding refuses to clobber your edits. |

Requires a project initialized with `deploy-stack init` (`terraform/main.tf` must exist).

## Cost & Billing Drivers

Both addons have no fixed hourly instance cost (usage-billed) on top of your stack's fixed baseline:

- `storage:s3`: $0/mo fixed baseline; billed per GB stored ($0.023/GB-mo), S3 PUT/GET requests, and CloudFront egress.
- `db:dynamodb`: $0/mo fixed instance baseline (the VPC Gateway Endpoint is free); billed per read/write request, table storage ($0.25/GB-mo), and PITR continuous backups ($0.20/GB-mo once data is written).

`deploy-stack add` prints the cost impact, refreshes the estimate in your `README.md` (or `DEPLOYMENT.md`), and `deploy-stack apply` lists active addons in its pre-flight preview. Reference rates are us-east-2; actual charges vary by region and usage.

## See also

- [apply](/deploy-stack/cli/apply/)
- [destroy](/deploy-stack/cli/destroy/)
