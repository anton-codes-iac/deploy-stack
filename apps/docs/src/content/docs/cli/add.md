---
title: add
description: Provision modular cloud addons like private S3 storage, DynamoDB tables, Valkey caching, SQS queues, or Bedrock AI access.
---

Provision modular Day-2 cloud primitives without writing Terraform, configuring IAM policies, or opening the AWS Management Console.

## What it does

- `storage:s3` creates a private S3 bucket (encrypted, CloudFront OAC, CORS ready for presigned browser uploads) and injects `S3_BUCKET_NAME` and `S3_CDN_URL` into your container.
- `db:dynamodb` creates a `PAY_PER_REQUEST` DynamoDB table (no fixed hourly instance cost) with Point-in-Time Recovery, a free VPC Gateway Endpoint, and injects `DYNAMODB_TABLE_NAME` into your container.
- `db:redis` provisions a cost-optimized ElastiCache for Valkey 8.0 node (Redis-protocol compatible) isolated in your VPC, reachable only from your ECS tasks, and injects `REDIS_URL` into your container.
- `queue:sqs` creates an SQS queue with long polling and a Dead-Letter Queue, and injects `SQS_QUEUE_URL` and `SQS_DLQ_URL` into your container. If your project has a background worker service, it also wires scale-to-zero auto-scaling driven by queue depth.
- `ai:bedrock` grants your container least-privilege permission to invoke Amazon Bedrock foundation models (no static AWS keys) and injects `BEDROCK_MODEL_ID` into your container. Run it interactively to pick a provider and model from the catalog, or pass `--model <id>` directly.
- Every addon attaches least-privilege IAM policies to your ECS task role, so your application code can use the AWS SDK with no extra configuration.
- Addon files live in `terraform/` (`s3.tf`, `dynamodb.tf`, `redis.tf`, `sqs.tf`, `bedrock.tf`), so `destroy` tears them down and `eject` keeps them automatically. PR-preview workspaces get isolated per-workspace resources. If your project has a `worker.tf` background service, addon environment variables are injected there too.

> **Bedrock model access:** AWS requires you to enable model access in the Bedrock console before your first `InvokeModel` call — including in the regions behind your `us.*` cross-region inference profile. IAM permissions alone are not enough. Anthropic models additionally require a one-time First Time Use (FTU) form in the Bedrock console.

## Usage

```bash
npx deploy-stack add storage:s3
npx deploy-stack add db:dynamodb
npx deploy-stack add db:dynamodb --partition-key userId
npx deploy-stack add db:redis
npx deploy-stack add queue:sqs
npx deploy-stack add ai:bedrock
npx deploy-stack add ai:bedrock --model us.anthropic.claude-haiku-4-5-20251001-v1:0
npx deploy-stack add ai:bedrock --list-models
npx deploy-stack add ai:bedrock --refresh
npx deploy-stack add storage:s3 --force
```

After adding, run `deploy-stack apply` (or commit and push to trigger CI) to provision the resource.

To switch Bedrock models later, just run `deploy-stack add ai:bedrock` again (interactively) or with a new `--model <id>` — the model reference updates in place across `bedrock.tf`, `main.tf`, and `worker.tf` without needing `--force`.

## Flags

| Flag | Description |
| ---- | ----------- |
| `--region <region>` | Explicit AWS region override. |
| `--project-name <name>` | Explicit project name override (defaults to the name in `terraform/main.tf`, then the directory name). |
| `--partition-key <key>` | DynamoDB partition key name (default `id`). Letters, numbers, underscore, hyphen, and dot only. Only applies to `db:dynamodb`. |
| `--model <id>` | Bedrock model or inference profile ID (default `us.anthropic.claude-sonnet-4-6`). Only applies to `ai:bedrock`. |
| `--list-models` | Print the Bedrock model catalog (works offline, no project required). Only applies to `ai:bedrock`. |
| `--refresh` | Refresh the Bedrock model catalog from live AWS data before listing or provisioning. Only applies to `ai:bedrock`. |
| `--force` | Overwrite the existing addon file (also accepts `--force=false`). Without it, re-adding refuses to clobber your edits. |

Requires a project initialized with `deploy-stack init` (`terraform/main.tf` must exist).

## Cost & Billing Drivers

- `storage:s3`: $0/mo fixed baseline; billed per GB stored ($0.023/GB-mo), S3 PUT/GET requests, and CloudFront egress.
- `db:dynamodb`: $0/mo fixed instance baseline (the VPC Gateway Endpoint is free); billed per read/write request, table storage ($0.25/GB-mo), and PITR continuous backups ($0.20/GB-mo once data is written).
- `db:redis`: ~$9.49/mo fixed baseline ($0.013/hr Valkey 8.0 `cache.t4g.micro`); $0 intra-AZ VPC transfer. Each open PR preview runs its own node while the PR is open.
- `queue:sqs`: $0/mo fixed baseline; first 1M requests/mo free, then $0.40 per million requests.
- `ai:bedrock`: $0/mo fixed baseline; billed per 1K input/output tokens on `InvokeModel` calls.

`deploy-stack add` prints the cost impact, refreshes the estimate in your `README.md` (or `DEPLOYMENT.md`), and `deploy-stack apply` lists active addons in its pre-flight preview. Reference rates are us-east-2; actual charges vary by region and usage.

## See also

- [apply](/deploy-stack/cli/apply/)
- [destroy](/deploy-stack/cli/destroy/)
