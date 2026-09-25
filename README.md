# deploy-stack ☁️🚀

> The zero-lock-in cloud generator. Eject your containerized web app from expensive PaaS platforms to production-ready, highly available AWS infrastructure in 60 seconds.

[![NPM Version](https://img.shields.io/npm/v/deploy-stack.svg?color=blue&logo=npm)](https://www.npmjs.com/package/deploy-stack)
[![Node.js Support](https://img.shields.io/node/v/deploy-stack.svg?color=brightgreen)](https://www.npmjs.com/package/deploy-stack)
[![Security: Trivy](https://img.shields.io/badge/Security-Trivy_Scanned-blue.svg?logo=docker)](https://trivy.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<!-- ![deploy-stack CLI demonstration](./docs/demo.gif) -->

---

## The Problem

Managed platforms like Vercel, Heroku, or Render offer rapid initial deployments, but costs escalate quickly with seat pricing, compute caps, and bandwidth markups.

Migrating directly to AWS provides greater cost efficiency and infrastructure control. However, architecting raw Terraform for ECS clusters, Application Load Balancers, CloudFront distributions, and keyless CI/CD pipelines typically requires writing hundreds of lines of complex boilerplate infrastructure code.

## The Solution

**`deploy-stack`** is an interactive CLI that streamlines the process. It analyzes your project requirements and generates **clean, readable, and completely ejectable Terraform and GitHub Actions workflows** directly inside your repository.

You retain complete ownership of your infrastructure code without relying on black-box platforms.

---

## ✨ Features

**🚀 Zero-Config Deployments**
* **Framework Agnostic:** Tailored container presets for 10 supported frameworks — Node.js/Express, NestJS, Next.js, Nuxt 3, SvelteKit, Python/FastAPI, Django, Rails, Go, and Static Sites (React, Vue, Astro).
* **Smart Discovery:** Automatically detects build output directories and generates highly optimized, multi-stage Dockerfiles.
* **Migration Engines:** Natively parses Heroku `Procfile` configurations, `vercel.json` routing rules, and `docker-compose.yml` sidecar architectures to automatically translate them into standard AWS Fargate and Application Load Balancer topologies.
* **Database Scaffolding:** Automatically provisions fully isolated, zero-trust AWS RDS PostgreSQL databases for backend monoliths.

**🛡️ DevSecOps & Security**
* **Automated Trivy Scanning:** Integrated IaC and container vulnerability scanning on every GitHub Actions run.
* **Continuous IaC Validation:** Matrix pipeline scaffolds all 10 supported frameworks headlessly and gates every commit on `terraform validate`, `tflint`, and Trivy (HIGH/CRITICAL).
* **Hardened Containers:** Explicitly drops root privileges using `nginx-unprivileged` and distroless bases for strict Fargate security compliance.
* **Zero-Secret CI/CD:** Utilizes AWS IAM OpenID Connect (OIDC) for automated deployments—no long-lived AWS keys in GitHub.
* **Built-in Secrets Manager:** Push local `.env` variables into encrypted AWS Secrets Manager vaults, pull them back onto a new machine, and audit local-vs-remote drift — with one-prompt rolling ECS restarts for value-only rotations.

**☁️ AWS Native Architecture**
* **Production Defaults:** Provisions an Amazon ECS Fargate cluster fronted by an Application Load Balancer across multiple availability zones.
* **Global Edge Acceleration:** Integrated AWS CloudFront CDN distribution with SSL termination and edge caching.
* **Cost & Observability:** Prevents runaway AWS bills with explicit 14-day CloudWatch log retention and auto-generates 5XX error alerting.

**🛠️ Developer Experience**
* **Zero Vendor Lock-In:** Generates standard, readable Terraform (`.tf`) files. You own the infrastructure.
* **Native S3 State Locking:** Automatically creates an encrypted S3 state bucket utilizing modern Terraform concurrency locking.
* **Safe Iteration:** Idempotent CLI safely backs up existing configurations to `.bak` files to guarantee zero data loss.
* **Ephemeral PR Previews (Opt-In):** Automatically spins up completely isolated AWS Fargate environments for every Pull Request and posts the live preview URL to GitHub, accelerating team code reviews.
* **Day-2 Observability:** Stream CloudWatch logs (`logs --tail --error -f`), check service health (`status`, with auto-`diagnose` on degradation), open a shell in a running container (`exec`), tunnel into your private database (`db connect`), clean up orphaned resources (`gc`, dry-run first with explicit confirmation), and roll back to a previous deployment (`rollback [revision]`, with live progress) without leaving the terminal.
* **🤖 IDE AI Integration:** Automatically generates contextual rules for Cursor, Windsurf, Copilot, and Claude to prevent Terraform hallucinations.

---

## 📚 Documentation & Guides
Transitioning from PaaS to AWS involves a few architectural shifts. Start with our **[live documentation site](https://anton-codes-iac.github.io/deploy-stack)** for full CLI references, guides, and migration walkthroughs. We've also written concise guides to help you understand how `deploy-stack` handles the heavy lifting:
* [Migrating from Heroku to AWS (Procfile Support)](./apps/docs/src/content/docs/migrations/heroku-procfile-to-aws.md)
* [Managing Secrets & Environment Variables](./apps/docs/src/content/docs/guides/secrets-management.md)
* [Zero-Trust Database Connections](./apps/docs/src/content/docs/guides/database-connections.md)
* [Migrating Next.js from Vercel](./apps/docs/src/content/docs/migrations/nextjs-vercel-to-aws.md)
* [Ephemeral PR Previews & AWS Costs](./apps/docs/src/content/docs/guides/ephemeral-pr-previews.md)

---

## 🚀 Quick Start

Run the CLI directly in your project root:

```bash
npx deploy-stack
```

The interactive wizard will analyze your codebase, detect your framework, estimate your AWS costs, and generate your Terraform and GitHub Actions configurations.

---

## 🧰 CLI Command Reference

`deploy-stack` manages the entire lifecycle of your infrastructure.

* **`npx deploy-stack apply`**
  Wraps Terraform execution in terminal-friendly UI. Automatically provisions your AWS infrastructure and outputs your live CDN and Load Balancer URLs. Prompts for confirmation before provisioning and offers to recreate a missing S3 state bucket automatically.
  *Tip: Append `--dry-run` to preview the architecture topology and estimated cost without provisioning anything.*
  
* **`npx deploy-stack secrets push <file>`**
  Securely encrypts your local environment variables (e.g., `.env.production`) into AWS Secrets Manager and maps them to your ECS container at runtime. Detects whether key names changed (commit `secret_keys.json` + push to redeploy) or only values changed (accept the rolling-restart prompt, no redeploy needed). If the env file is missing, offers to create an empty one interactively (exits 1 under `--headless`/CI instead of prompting).

* **`npx deploy-stack secrets pull <file>`**
  Merges the remote vault payload back into your local `.env` — onboarding, recovery, sync. Keeps local-only variables, asks before overwriting conflicts (automatic with `--headless`).

* **`npx deploy-stack secrets audit <file>`**
  Diffs local `.env` against AWS and prints a colored drift report (`+` missing locally, `~` mismatched, `-` never pushed). Changes nothing.

* **`npx deploy-stack doctor`**
  Scans your local environment and generated files to ensure all required dependencies (Docker, Terraform, AWS CLI) are installed and configured correctly.

* **`npx deploy-stack diagnose`** (alias: `wtf`)
  Troubleshoots a failing ECS deployment by reporting the most recent stopped task's `stoppedReason`, failing container (with exit code), and the last 50 CloudWatch log lines. Stateless: derives region/cluster context from `terraform/main.tf` (`AWS_REGION` takes precedence, default `us-east-2`; see ADR-0004), no local state file required. On expired AWS credentials it prints a recovery hint and exits with code 1.

* **`npx deploy-stack logs [service]`**
  Streams CloudWatch logs without opening the AWS console. Supports `--tail <n>`, `-f/--follow` for live tailing, `--error` to filter for failures, and `--since <duration>` (e.g. `5m`, `1h`).

* **`npx deploy-stack status`**
  Shows a color-coded health dashboard (ECS replicas, CloudWatch alarms). Exits cleanly when healthy; on degradation it runs `diagnose` automatically and exits 1. Pass `--json` for scripting.

* **`npx deploy-stack rollback [revision]`**
  Returns the live ECS service to a previous task definition revision. Pass a revision number, or pick from an interactive list showing each revision's image and date (defaults to the newest older revision with `--headless`/CI). Streams live provisioning progress, and every deploy registers an immutable new revision so there is always history to return to. Pass `--skip-wait` to trigger and exit immediately.

* **`npx deploy-stack exec`**
  Opens an interactive shell (`/bin/sh` by default, overridable via `--command`) inside a running ECS container — no AWS console needed. Finds the cluster, service, and task automatically; needs the AWS CLI plus the Session Manager plugin and a running container.

* **`npx deploy-stack db connect`**
  Opens a secure `localhost` tunnel to your private RDS PostgreSQL instance through a running container — point DBeaver, psql, or Prisma Studio at it with no public internet exposure. Prints a copy-pasteable connection string (password masked unless `--show-credentials`), supports `--port` and `--workspace` for PR-preview environments.

* **`npx deploy-stack gc`**
  Discovers orphaned AWS resources — untagged ECR images in `<project-name>-*` repos, `/ecs/<project-name>-*` log groups from deleted previews, and unattached Elastic IPs — prints a categorized dry-run summary, and deletes only after explicit interactive confirmation (no `--yes` flag, so it can never run destructively in CI).

* **`npx deploy-stack destroy`**
  Safely tears down your ECS cluster, Load Balancers, and networking resources to stop AWS billing. Includes an interactive prompt to optionally retain or delete your S3 remote state bucket.

* **`npx deploy-stack eject`**
  Strips all `deploy-stack` metadata and management tags from your project, leaving behind pure, standard Terraform and GitHub Actions files. You retain 100% ownership.

* **`npx deploy-stack --headless`**
  Bypasses the interactive wizard for fully programmatic execution. Perfect for CI/CD pipelines, custom scripts, or AI agent integration. Accepts flags like `--framework=static`, `--region=us-east-2`, and `--size=micro`.
  Pass `--preconfigured` when invoking via an external schematic or integration (e.g., `nest add nest-deploy-stack`) to suppress framework warnings for pre-validated configs.

* **`npx deploy-stack sync-ai`**
  Selectively generates architecture rules for AI coding assistants (Cursor, Copilot, Windsurf, Claude). Automatically extracts your AWS Region and Container Port to prevent Terraform hallucinations.

---

## 📁 Generated File Structure

Running the CLI seamlessly integrates a modular, DevSecOps-hardened architecture into your repository:

```text
your-project/
├── Dockerfile                  # Multi-stage container preset
├── .dockerignore               # Prevents secret leaks into container builds
├── .gitignore                  # Automatically updated to ignore tfstate and .bak files
├── .github/
│   └── workflows/
│       └── deploy.yml          # Keyless OIDC CI/CD deployment pipeline
└── terraform/
    ├── main.tf                 # ECR repository, ECS Cluster, and Fargate Task
    ├── network.tf              # VPC, Public Subnets, ALB, and Security Groups
    ├── cloudfront.tf           # CloudFront CDN edge distribution
    ├── oidc.tf                 # GitHub Actions keyless IAM OIDC Provider & Roles
    ├── secrets.tf              # AWS Secrets Manager integration
    ├── backend.tf              # S3 Remote State backend with native locking
    └── secret_keys.json        # Dynamic key map for injected environment variables
```

---

## 📦 Reference Implementations

* **[Next.js Fullstack App](https://github.com/anton-codes-iac/deploy-stack-nextjs-example):** A complete Next.js deployment showcasing the generated Terraform, CloudFront setup, and automated OIDC workflow.
* **[Docker Compose to AWS Migration](https://github.com/anton-codes-iac/deploy-stack-docker-compose-example):** Demonstrates automatic translation of local `docker-compose.yml` sidecars (like Redis) into a multi-container AWS ECS Task Definition communicating over `localhost`.
* **[Heroku to AWS Migration (Django)](https://github.com/anton-codes-iac/deploy-stack-heroku-django-example):** A classic Heroku-style monolith migrated via the Procfile Importer.
* **[Zero-Secret AWS Secrets Manager Injection](https://github.com/anton-codes-iac/deploy-stack-secrets-example):** A production-grade Node.js architecture demonstrating zero-plaintext secret injection. Encrypts local `.env` variables directly into AWS and maps them into ECS memory at container boot, verified against GitHub's API.

👉 **[View all 14+ reference implementations in our Examples Gallery](./apps/docs/src/content/docs/guides/examples.md)**

---

## 🤖 AI Context Management (Cursor, Roo Code, Trae, Copilot, Windsurf, Claude, Goose, Aider, Continue)

AI coding assistants are incredible, but they often hallucinate custom Terraform or raw AWS CLI commands that can break your infrastructure state. `deploy-stack` natively intercepts and guides AI agents directly in your IDE by providing strict deployment rules and project-specific context (like your exact AWS Region and Container Port).

**How it works:**
* **Quickstart Flow:** The CLI silently auto-detects if you are using AI tools in your repository and safely injects context.
* **Advanced Flow:** You are explicitly prompted to choose which AI assistants your team uses.
* **Standalone Command:** You can run `npx deploy-stack sync-ai` at any time to selectively generate these rules later.

**Safe & Non-Destructive:** We use isolated rule files (like `.cursor/rules/deploy-stack.mdc`) or strictly delimited blocks (``) to ensure your team's existing agent instructions, coding standards, and project prompts are **never overwritten**.

---

## 🛡️ Telemetry & Privacy
By default, `deploy-stack` collects anonymous, hashed usage data to help improve the CLI (e.g., framework presets used, deployment success rates). **No codebase files, AWS credentials, or personal data are ever collected.**

To opt out, simply append the flag:
```bash
npx deploy-stack --no-telemetry
```

---

## 🗺️ Roadmap

### Phase 10: Complete Day-0 to Day-N Lifecycle Mastery (Current)
**Goal:** Zero-Console Production Independence. Eliminate the final architectural, data, and operational triggers that force developers to open the AWS Management Console across the entire application lifecycle.
- [ ] **Custom Domains & Automated SSL:** `deploy-stack domain add <domain>`. Automate Route 53 Hosted Zone bindings or provide an interactive External DNS verification flow (Cloudflare, Namecheap) with automated ACM TLS certificate issuance (including `us-east-1` validation for edge/CloudFront) and ALB listener routing.
- [x] **Instant One-Command Rollback:** `deploy-stack rollback [revision]`. List the last 5 deployed task revisions and instantly revert the live ECS service to a prior healthy revision in under 15 seconds, bypassing lengthy rebuild cycles during production regressions.
- [x] **Self-Healing Deployment Circuit Breakers:** Enable native ECS deployment circuit breakers (`deployment_circuit_breaker { enable = true, rollback = true }`) in Terraform, automatically rolling back failed container rollouts and broken health checks without operator intervention.
- [ ] **Pre-Deploy Database Migration Gate:** Inject an isolated `aws ecs run-task` step into `.github/workflows/deploy.yml` to execute schema migrations (`prisma migrate deploy`, `alembic upgrade head`, `rails db:migrate`) against RDS inside the VPC before rolling out the new service revision, automatically halting the release if migrations fail.
- [ ] **On-Demand Database Snapshots & Restore:** `deploy-stack db backup` and `deploy-stack db restore`. Provide instantaneous CLI wrappers around RDS manual snapshots and point-in-time recovery so developers can create pre-migration safety checkpoints or restore instances directly from the terminal.
- [ ] **Transactional Email & DKIM Automation:** `deploy-stack add email:ses`. Provision Amazon SES Domain Identities, auto-inject the 3 required DKIM CNAME records into Route 53 (or output external DNS records), configure SPF/DMARC baselines, and attach least-privilege `ses:SendEmail` permissions to the ECS Task Role.
- [ ] **Application Object Storage:** `deploy-stack add storage:s3`. Provision secure, private S3 buckets for asset uploads configured with CloudFront Origin Access Control (OAC), CORS rules, and presigned URL IAM policies injected directly into the container runtime.
- [ ] **In-Memory Caching & Async Queues:** `deploy-stack add db:redis` (powered by cost-optimized AWS ElastiCache for Valkey/Redis) and `deploy-stack add queue:sqs`. Scaffold private in-memory cache clusters, SQS queues, EventBridge cron schedules, and scale-to-zero background worker Fargate services driven by queue depth auto-scaling (`ApproximateNumberOfMessagesVisible`).
- [ ] **Serverless NoSQL & Vector Databases:** `deploy-stack add db:dynamodb` and `deploy-stack db enable-vector`. Provision scale-to-zero DynamoDB (`PAY_PER_REQUEST`) tables with free VPC Gateway Endpoints and auto-wired IAM policies, plus one-command `pgvector` provisioning on RDS PostgreSQL for AI/RAG embeddings without expensive OpenSearch clusters.
- [ ] **Multi-Engine RDS & Aurora Scale-to-Zero:** Support PostgreSQL, MySQL, and Aurora Serverless v2 (`0 ACU` auto-pause) across `init`, `db connect`, `db backup`, and `db restore` with automatic URI formatting (`postgresql://` and `mysql://`).
- [ ] **On-Demand Remote Migration Runner:** `deploy-stack db migrate [--cmd <command>]`. Launch an ephemeral, one-off ECS Fargate task inside the private VPC to execute ad-hoc schema migrations or seed scripts (`prisma`, `alembic`, `rails db:seed`), streaming stdout/stderr live to the terminal.
- [ ] **Zero-Trust Database Ingestion:** `deploy-stack db import [--file <dump.sql> | --from <url>]`. Stream local SQL dumps or remote databases (Heroku, Supabase, Render, Railway) directly into the isolated private RDS instance via an automated background SSM tunnel.
- [ ] **GenAI & Serverless Compute Primitives:** `deploy-stack add ai:bedrock` and `deploy-stack --target lambda`. Configure least-privilege IAM policies for invoking AWS Bedrock foundation models and provide an alternate AWS Lambda + API Gateway deployment target for scale-to-zero web workloads.
- [ ] **Environment Hibernation & FinOps:** `deploy-stack sleep <env>` and `deploy-stack wake <env>`. Scale ECS task counts to zero, stop non-production RDS instances, guard against the AWS 7-day RDS auto-restart behavior, and display estimated hourly savings to eliminate idle staging costs.
- [ ] **Scheduled IaC Drift Detection:** Generate an automated GitHub Action that periodically executes `terraform plan -detailed-exitcode` against live AWS infrastructure, opening GitHub Issues or dispatching Slack notifications when out-of-band console changes occur.

👉 **[See the full project history and future plans in the roadmap](./apps/docs/src/content/docs/roadmap.md)**

---

## 📜 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.