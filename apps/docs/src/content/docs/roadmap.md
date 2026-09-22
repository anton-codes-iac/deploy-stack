---
title: Roadmap
description: Where deploy-stack has been and what comes next — completed phases and the current platform-hardening milestone.
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

### Phase 9: Day-2 Operations & Developer Retention (Current)
*Focus: Uninterrupted Developer Flow. Deliver a seamless Day-2 environment where users maintain full infrastructure control without leaving the command line to troubleshoot.*
- [x] **Context-Aware Log Streaming:** `deploy-stack logs <service> --tail --error`. Implement a live stream using the CloudWatch Logs API to merge API/frontend logs in a color-coded terminal view, eliminating the need to navigate the AWS web console.
- [x] **1-Click Container Access:** `deploy-stack exec <service>`. Automatically drop the user into a secure bash shell inside a running Fargate container using AWS Systems Manager (SSM) Session Manager, abstracting away complex IAM trust policies and local agent requirements.
- [x] **Secure Secrets Sync & Rolling Restarts:** `deploy-stack secrets pull/audit`. Fetch vault payloads to a local `.env`, compare local vs. remote keys, and trigger rolling ECS restarts for value-only rotations.
- [ ] **Secure Database Tunneling:** `deploy-stack db connect`. Utilize SSM Port Forwarding to open a secure `localhost` tunnel directly to private RDS or ElastiCache instances, allowing tools like DBeaver or Prisma Studio to query production data without public internet exposure.
- [x] **Health & Alarm Dashboard:** `deploy-stack status`. Query the ECS Service status (Desired vs. Running tasks) and CloudWatch Alarms (e.g., ALB 5XX errors), printing a clear green/red operational status matrix directly in the terminal.
- [ ] **Orphaned Resource Garbage Collection:** `deploy-stack gc`. Scan the AWS account for unattached Elastic IPs, abandoned ECR image layers, and lingering CloudWatch log groups left behind by PR previews or manual deletions, safely removing them to protect the user's AWS bill.
