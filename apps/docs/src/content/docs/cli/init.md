---
title: Initializing Project (npx deploy-stack)
description: Scaffold production-ready AWS infrastructure and CI/CD pipelines.
---

Generate Terraform, Docker, and GitHub Actions files for your project.

## What it does

- Turns your codebase into a deployable AWS project: auto-detects your framework, `Procfile`, `vercel.json`, and `docker-compose.yml`, warns about framework-specific migration issues (NestJS bind address, Next.js standalone output, SvelteKit/Astro adapters), then provisions the remote-state S3 bucket and synthesizes Terraform, Docker, and CI/CD files.
- Backs up any existing generated files before overwriting them, and writes AI assistant rule files for the assistants you choose (advanced mode) or the ones already present in your repo (quickstart mode).
- Finishes with the exact next steps: the `apply` command to provision, and the `git` commands to commit and push.
- Emits `project_provisioned` and `cli-error` telemetry events (disable with `--no-telemetry`).

## Usage

```bash
npx deploy-stack
npx deploy-stack --headless --framework=nextjs --region=us-east-2
```

Running with no subcommand starts the interactive setup wizard (`init` is the default command).

## Headless flags

| Flag | Description |
| ---- | ----------- |
| `--headless` | Bypass all interactive prompts (for CI/CD and automation). |
| `--framework=<name>` | `node`, `nextjs`, `nuxt`, `python`, `django`, `rails`, `go`, `static`. |
| `--region=<region>` | AWS region (e.g. `us-east-1`). |
| `--port=<port>` | Container port your app listens on. |
| `--size=<size>` | Fargate task size preset. |
| `--healthCheckPath=<path>` | ALB health-check path. |
| `--desiredCount=<n>` | Number of tasks to run. |
| `--branch=<name>` | Branch the CI workflow deploys. |
| `--needsDatabase` | Provision a managed database. |
| `--enablePrPreviews` | Enable ephemeral PR preview environments. |
| `--dir=<path>` | Target directory for generated files. |
| `--preconfigured` | Skip framework-specific warnings (for preconfigured setups). |
| `--no-telemetry` | Disable telemetry for this run. |

See the [Headless Mode guide](/guides/headless/) for automation examples.
