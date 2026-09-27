---
title: Understanding Your AWS Bill
description: What each part of your deploy-stack infrastructure costs, what the CLI estimates cover, and how to keep spend low.
---

Every deploy-stack command that touches infrastructure tells you what it costs *before* you pay it: `apply` shows a pre-flight estimate, `add` prints the cost impact of each addon, and your `README.md` keeps a refreshed monthly baseline. This guide explains what those numbers include, what they leave out, and where the cost levers are.

All reference rates below are for `us-east-2` (the stack default) and assume a 730-hour month. Other regions typically land within ~5–15% of these figures.

## The Fixed Monthly Baseline

These resources bill by the hour (or month) whether your app serves one request or one million. A minimal stack (256 CPU / 512 MB Fargate micro, no database) runs **~$31.68/mo**:

| Resource | Math | Monthly |
| -------- | ---- | ------- |
| Fargate task (0.25 vCPU + 0.5 GB) | (0.25 × $0.04048 + 0.5 × $0.004445) × 730 hrs | ~$9.01 |
| Application Load Balancer (base + ~1 LCU) | ($0.0225 + $0.008) × 730 hrs | ~$22.27 |
| Secrets Manager (1 app secret) | 1 × $0.40 | $0.40 |

Optional fixed add-ons to the baseline:

| Addition | Monthly |
| -------- | ------- |
| Background worker service (second identical Fargate task) | doubles Fargate to ~$18.02 — but scales to $0 when its SQS queue is empty |
| RDS Postgres (`db.t4g.micro` + 20 GB gp3 + managed secret) | ~$13.98 + $0.40 secret |
| Valkey caching (`add db:redis`, `cache.t4g.micro`) | ~$9.49 |

So a typical full stack (web + database + Valkey) lands around **~$55.55/mo**, and the CLI's estimate always reflects your actual `terraform/` directory — container size, worker, database, secrets, and fixed-cost addons included.

## What the Estimate Leaves Out (Usage Billing)

Anything that scales with traffic is billed on use and intentionally excluded from the fixed number:

- **Addons:** `storage:s3` (storage, requests, CloudFront egress), `db:dynamodb` (requests, storage, backups), `queue:sqs` (requests past the 1M free tier), `ai:bedrock` (per-token inference). Each `add` run prints its own billing drivers.
- **Data transfer:** outbound traffic and CloudFront egress beyond free tiers.
- **Logs & images:** CloudWatch Logs ingestion (14-day retention is configured) and ECR image storage (~$0.10/GB-mo) — usually cents, plus `gc` cleans up orphans.
- **Traffic spikes:** ALB capacity units above the ~1 LCU baseline, and RDS backup storage past the free allowance.

Rule of thumb: the fixed baseline is your floor; side projects with modest traffic typically land within a few dollars above it.

## Cost Savers Built Into the Stack

- **No NAT gateway.** Tasks run in public subnets behind the ALB security group instead of behind a ~$33/mo NAT — the single biggest saving versus a conventional VPC layout.
- **Micro defaults, scale up deliberately.** Fargate micro, single-AZ `db.t4g.micro`, and single-node Valkey keep the floor low; grow container size or add read replicas only when metrics say so.
- **Workers scale to zero.** The SQS-driven worker parks at 0 tasks (and $0 compute) when the queue drains — you pay for background capacity only while jobs exist.
- **PR previews self-destruct.** Each open pull request runs a full copy of the stack (~$31+/mo each while open, mostly the extra ALB), so previews are destroyed automatically when the PR closes. Close stale PRs and run `gc` to catch leftovers.
- **Serverless-first addons.** DynamoDB on-demand, SQS, and Bedrock cost nothing at rest — prefer them over always-on resources when the workload fits.

## Keeping Estimates Accurate

- The `README.md` estimate refreshes automatically on every `add` and `apply` — if you hand-edit `terraform/`, re-run `apply` (or `--dry-run`) to re-sync it.
- Estimates follow your real config: bigger `--size` at `init`, extra secrets, and new addons all flow into the number on the next run.
- For hard budget enforcement, pair the CLI estimates with an AWS Budgets billing alarm in the console — the CLI tells you the expected spend, AWS tells you the actuals.
