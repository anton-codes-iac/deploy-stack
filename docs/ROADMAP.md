# 🗺️ deploy-stack Roadmap

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

### Phase 7: Team Workflows & Ecosystem Integrations (Current)
*Focus: Enhance collaborative development and expand native support across major framework ecosystems.*
- [x] **Ephemeral PR Previews:** Generate GitHub Actions workflows that spin up temporary ECS Fargate tasks and post live URLs directly in PR comments to streamline team code reviews.
- [ ] **AI Context Synchronization:** Implement `deploy-stack sync-ai` to automatically generate `.cursorrules` and AI context files, ensuring IDE assistants understand the infrastructure.
- [ ] **Native Ecosystem Integrations:** Publish push-button plugins across major frameworks (e.g., `svelte-adapter-deploy-stack`, `create-next-app` AWS template, `vite-plugin-deploy-stack`, NestJS deployment schematic, Django Cookiecutter).
- [ ] **Automated Troubleshooting:** Build `deploy-stack diagnose` to auto-diagnose common day-2 AWS failures (e.g., Fargate OOM kills, ALB 502s) to establish immediate technical credibility and simplify maintenance.