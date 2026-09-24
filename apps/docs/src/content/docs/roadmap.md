---
title: Roadmap
description: Where deploy-stack has been and what comes next — completed phases and the current milestone.
---

### Phase 1–3: The Core Engine (Completed)
- [x] **Core MVP:** Interactive CLI, ECS Fargate + ALB generation, CI/CD, and Secrets sync.
- [x] **Production Readiness:** CloudFront CDN edge distribution, native S3 state locking, and secure OIDC integration.
- [x] **Smart Experience:** Zero-config framework auto-discovery for static output directories.
- [x] **Trust & Observability:** DevSecOps Trivy scanning, automated 5XX alarms, 14-day log retention, and safe local overwrite protections.

### Phase 4: Trust Anchors & TAM Expansion (Completed)
- [x] **Ecosystem Distribution:** Native GitHub Marketplace Action for rapid discovery.
- [x] **Cost Transparency:** Pre-flight AWS cost estimator injected directly into the CLI wizard.
- [x] **Zero Vendor Lock-In:** Explicit `npx deploy-stack eject` command to safely strip `ManagedBy` tags and CLI metadata, leaving behind pure IaC.
- [x] **Heavy Backend Monoliths:** Hardened, unprivileged container adapters for Go, Nuxt.js, Django, and Rails, complete with automated zero-trust RDS PostgreSQL provisioning.

### Phase 5: The Activation Engine (Completed)
- [x] **Local Execution Wrapper:** Native `deploy-stack apply` command with terminal-optimized streaming to eliminate Terraform context switching.
- [x] **Ecosystem Integrations:** Official plugins published to the Astro Integrations directory (`astro-deploy-stack`) and Nuxt module registry (`nuxt-deploy-stack`).

### Phase 6: Migration & Trust Engine (Completed)
- [x] **Dry-Run Visualization:** Interactive pre-flight terminal UI with ASCII topology maps and precise, dynamic AWS cost estimation.
- [x] **PaaS Importers:** Auto-parse `vercel.json` and Heroku `Procfile` configurations to map routing rules, web commands, and background workers automatically.
- [x] **Docker Compose to ECS Translator:** Automatically converting a familiar local `docker-compose.yml` into production ECS task definitions.
- [x] **AI Agent Rulesets:** Publishing `.cursorrules` and Copilot instructions that teach AI assistants exactly how to utilize the CLI on the user's behalf.

### Phase 7: Team Workflows & Ecosystem Integrations (Completed)
*Focus: Enhance collaborative development and expand native support across major framework ecosystems.*
- [x] **Ephemeral PR Previews:** Generate GitHub Actions workflows that spin up temporary ECS Fargate tasks and post live preview URLs directly in pull request comments to streamline team code reviews.
- [x] **AI Context Synchronization:** Implement `deploy-stack sync-ai` to automatically generate `.cursorrules` and AI context files, ensuring coding assistants generate accurate deployment commands tailored to the project.
- [x] **Native Ecosystem Integrations:** Publish seamless, push-button plugins across major frameworks.
  - [x] `vite-plugin-deploy-stack` (Live on NPM)
  - [x] `svelte-adapter-deploy-stack` (SvelteKit adapter integration)
  - [x] `cookiecutter-django-deploy-stack` (Listed on Django Packages)
  - [x] `cookiecutter-fastapi-deploy-stack` (Cookiecutter for modern async Python)
  - [x] `nest-deploy-stack` (Native `nest add` schematic for NestJS)
  - [x] `rails-template-deploy-stack` (Zero-click Ruby on Rails application template)
- [x] **Automated Troubleshooting:** `deploy-stack diagnose` (alias: `wtf`) automatically analyzes common day-2 AWS operational issues (e.g., Fargate OOM kills, ALB 502s) directly from the terminal.

### Phase 8: Platform Hardening & Developer Experience (Completed)
*Focus: Solidify the core engine's reliability, prove security compliance, and establish documentation hub before introducing Day-2 operational commands.*
- [x] **Documentation Hub:** Launch a dedicated Astro Starlight documentation site featuring interactive architecture diagrams, core concept deep-dives, and detailed CLI references.
- [x] **Continuous Infrastructure Validation:** Implement a GitHub Actions matrix pipeline that automatically generates, compiles, and validates Terraform syntax (`terraform validate`, `tflint`) against all supported frameworks on every commit.
- [x] **Automated Security & Compliance Proving:** Integrate DevSecOps infrastructure scanning (`trivy` or `tfsec`) directly into the CI pipeline to mathematically guarantee zero-CVE, secure-by-default AWS provisioning.
- [x] **Integration Stability Suite:** Expand Vitest coverage to enforce strict contracts for headless execution flags (`--preconfigured`, `--headless`), ensuring seamless interoperability with third-party scaffolding tools.

### Phase 9: Day-2 Operations & Developer Retention (Completed)
*Focus: Uninterrupted Developer Flow. Deliver a seamless Day-2 environment where users maintain full infrastructure control without leaving the command line to troubleshoot.*
- [x] **Context-Aware Log Streaming:** `deploy-stack logs <service> --tail --error`. Implement a live stream using the CloudWatch Logs API to merge API/frontend logs in a color-coded terminal view, eliminating the need to navigate the AWS web console.
- [x] **1-Click Container Access:** `deploy-stack exec <service>`. Automatically drop the user into a secure bash shell inside a running Fargate container using AWS Systems Manager (SSM) Session Manager, abstracting away complex IAM trust policies and local agent requirements.
- [x] **Secure Secrets Sync & Rolling Restarts:** `deploy-stack secrets pull/audit`. Fetch vault payloads to a local `.env`, compare local vs. remote keys, and trigger rolling ECS restarts for value-only rotations.
- [x] **Secure Database Tunneling:** `deploy-stack db connect`. Utilize SSM Port Forwarding to open a secure `localhost` tunnel directly to your private RDS PostgreSQL instance, allowing tools like DBeaver or Prisma Studio to query production data without public internet exposure.
- [x] **Health & Alarm Dashboard:** `deploy-stack status`. Query the ECS Service status (Desired vs. Running tasks) and CloudWatch Alarms (e.g., ALB 5XX errors), printing a clear green/red operational status matrix directly in the terminal.
- [x] **Orphaned Resource Garbage Collection:** `deploy-stack gc`. Scan the AWS account for unattached Elastic IPs, abandoned ECR image layers, and lingering CloudWatch log groups left behind by PR previews or manual deletions, safely removing them to protect the user's AWS bill.

### Phase 10: Complete Day-0 to Day-N Lifecycle Mastery (Current)
**Goal:** Zero-Console Production Independence. Eliminate the final architectural, data, and operational triggers that force developers to open the AWS Management Console across the entire application lifecycle.

- [ ] **Custom Domains & Automated SSL:** `deploy-stack domain add <domain>`. Automate Route 53 Hosted Zone bindings or provide an interactive External DNS verification flow (Cloudflare, Namecheap) with automated ACM TLS certificate issuance (including `us-east-1` validation for edge/CloudFront) and ALB listener routing.
- [ ] **Instant One-Command Rollback:** `deploy-stack rollback [revision]`. List the last 5 deployed task revisions and instantly revert the live ECS service to a prior healthy revision in under 15 seconds, bypassing lengthy rebuild cycles during production regressions.
- [ ] **Self-Healing Deployment Circuit Breakers:** Enable native ECS deployment circuit breakers (`deployment_circuit_breaker { enable = true, rollback = true }`) in Terraform, automatically rolling back failed container rollouts and broken health checks without operator intervention.
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
