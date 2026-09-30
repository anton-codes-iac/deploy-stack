---
title: Initializing Project (npx deploy-stack)
description: Scaffold production-ready AWS infrastructure and CI/CD pipelines.
---

Generate Terraform, Docker, and GitHub Actions files for your project.

## What it does

- Turns your codebase into a deployable AWS project: auto-detects your framework, `Procfile`, `vercel.json`, and Compose files, warns about framework-specific migration issues (NestJS bind address, Next.js standalone output, SvelteKit/Astro adapters), then provisions the remote-state S3 bucket and synthesizes Terraform, Docker, and CI/CD files.
- Scans your manifests for infrastructure signals before prompting: database drivers and migration markers pre-select the managed PostgreSQL prompt, worker dependencies pre-fill the background-worker command, and detected capabilities (Redis, SQS, S3, DynamoDB, Bedrock, SES) come pre-checked in the addon picker — every suggestion shows the exact evidence that triggered it (`detected: ioredis, REDIS_URL`). Detection is read-only and skips secret values entirely.
- Scaffolds selected addons in the same run (same pipeline as [`add`](/deploy-stack/cli/add/), including container env injection and README cost refresh), offers to wire the pre-deploy database migration gate into the generated workflow, offers scheduled IaC drift detection (a daily `terraform plan` workflow that opens GitHub Issues), and prints a full stack topology preview when addons are included.
- Backs up any existing generated files before overwriting them, and writes AI assistant rule files for the assistants you choose (advanced mode) or the ones already present in your repo (quickstart mode). Your own `README.md` is never overwritten: deployment docs go to `README.md` only when it is absent or was previously generated, otherwise to `DEPLOYMENT.md` (or `DEPLOY-STACK.md` when both are yours), with an existing `secret_keys.json` left untouched.
- Finishes with the exact next steps: the `apply` command to provision, and the `git` commands to commit and push.
- Writes a fixed-baseline monthly cost estimate into the generated deployment doc, refreshed automatically whenever you later run [`add`](/deploy-stack/cli/add/).
- Emits `project_provisioned` (recording the database engine, detected/selected addons, migration-gate status, and drift-detection status) and `cli-error` telemetry events (disable with `--no-telemetry`).

## Usage

```bash
npx deploy-stack
npx deploy-stack --headless --framework=nextjs --region=us-east-2
npx deploy-stack --headless --framework=nestjs --needsDatabase \
  --with db:redis,ai:bedrock,email:ses --domain example.com --setup-ci-migrate
```

Running with no subcommand starts the interactive setup wizard (`init` is the default command).

## Headless flags

| Flag | Description |
| ---- | ----------- |
| `--headless` | Bypass all interactive prompts (for CI/CD and automation). |
| `--framework=<name>` | `node`, `nestjs`, `nextjs`, `nuxt`, `svelte`, `python`, `django`, `rails`, `go`, `static`. |
| `--region=<region>` | AWS region (e.g. `us-east-1`). |
| `--port=<port>` | Container port your app listens on. |
| `--size=<size>` | Fargate task size preset. |
| `--healthCheckPath=<path>` | ALB health-check path. |
| `--desiredCount=<n>` | Number of tasks to run. |
| `--branch=<name>` | Branch the CI workflow deploys. |
| `--needsDatabase` | Provision a managed database. |
| `--db-engine <engine>` | Database engine: `postgres` (default), `mysql` (MySQL 8.0), or `aurora-postgresql` (Serverless v2 scale-to-zero). Skip the interactive engine prompt. |
| `--enablePrPreviews` | Enable ephemeral PR preview environments. |
| `--dir=<path>` | Target directory for generated files. |
| `--preconfigured` | Skip framework-specific warnings (for preconfigured setups). |
| `--with <capabilities>` | Comma-separated (or repeatable) addon capabilities to scaffold during init (`storage:s3`, `db:dynamodb`, `db:redis`, `queue:sqs`, `ai:bedrock`, `email:ses`, `cron`). Pre-checks the interactive picker, or scaffolds directly in headless mode. |
| `--model <id>` | Bedrock model override when `ai:bedrock` is included (defaults to the catalog's recommended model). |
| `--domain <domain>` | Domain for the SES identity when `email:ses` is included (required in headless mode). |
| `--zone-id <id>` | Route 53 hosted zone ID for automatic SES DNS records. |
| `--from-email <email>` | Default SES sender address (default `noreply@<domain>`). |
| `--setup-ci-migrate` | Wire the pre-deploy database migration gate into the generated workflow when a database and migration command are detected. |
| `--setup-ci-drift` | Scaffold `.github/workflows/drift.yml`: a daily 06:00 UTC `terraform plan` check that opens (or updates) a GitHub Issue labeled `iac-drift` on drift and closes it when resolved. |
| `--no-telemetry` | Disable telemetry for this run (or set `DO_NOT_TRACK=1` for all runs). |

New here? Start with the [Quickstart](/deploy-stack/guides/quickstart/).

See the [Supported Frameworks](/deploy-stack/guides/frameworks/) guide for detection rules and per-framework requirements, and the [Headless Mode guide](/deploy-stack/guides/headless/) for automation examples.

After scaffolding, continue with [CI/CD Pipeline & First Deploy](/deploy-stack/guides/cicd-pipeline/).
