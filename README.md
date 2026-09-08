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
* **Framework Agnostic:** Tailored container presets for Next.js, Express.js, FastAPI, Go, Django, Rails, Nuxt 3, and Static Sites (React, Vue, SvelteKit, Astro).
* **Smart Discovery:** Automatically detects build output directories and generates highly optimized, multi-stage Dockerfiles.
* **Migration Engines:** Natively parses Heroku `Procfile` configurations, `vercel.json` routing rules, and `docker-compose.yml` sidecar architectures to automatically translate them into standard AWS Fargate and Application Load Balancer topologies.
* **Database Scaffolding:** Automatically provisions fully isolated, zero-trust AWS RDS PostgreSQL databases for backend monoliths.

**🛡️ DevSecOps & Security**
* **Automated Trivy Scanning:** Integrated IaC and container vulnerability scanning on every GitHub Actions run.
* **Hardened Containers:** Explicitly drops root privileges using `nginx-unprivileged` and distroless bases for strict Fargate security compliance.
* **Zero-Secret CI/CD:** Utilizes AWS IAM OpenID Connect (OIDC) for automated deployments—no long-lived AWS keys in GitHub.
* **Built-in Secrets Manager:** Push local `.env` variables directly into encrypted AWS Secrets Manager vaults with a single CLI command.

**☁️ AWS Native Architecture**
* **Production Defaults:** Provisions an Amazon ECS Fargate cluster fronted by an Application Load Balancer across multiple availability zones.
* **Global Edge Acceleration:** Integrated AWS CloudFront CDN distribution with SSL termination and edge caching.
* **Cost & Observability:** Prevents runaway AWS bills with explicit 14-day CloudWatch log retention and auto-generates 5XX error alerting.

**🛠️ Developer Experience**
* **Zero Vendor Lock-In:** Generates standard, readable Terraform (`.tf`) files. You own the infrastructure.
* **Native S3 State Locking:** Automatically creates an encrypted S3 state bucket utilizing modern Terraform concurrency locking.
* **Safe Iteration:** Idempotent CLI safely backs up existing configurations to `.bak` files to guarantee zero data loss.
* **Ephemeral PR Previews (Opt-In):** Automatically spins up completely isolated AWS Fargate environments for every Pull Request and posts the live preview URL to GitHub, accelerating team code reviews.
* **🤖 IDE AI Integration:** Automatically generates contextual rules for Cursor, Windsurf, Copilot, and Claude to prevent Terraform hallucinations.

---

## 📚 Documentation & Guides
Transitioning from PaaS to AWS involves a few architectural shifts. We've written concise guides to help you understand how `deploy-stack` handles the heavy lifting:
* [Migrating from Heroku to AWS (Procfile Support)](./docs/migrations/heroku-procfile-to-aws.md)
* [Managing Secrets & Environment Variables](./docs/guides/secrets-management.md)
* [Zero-Trust Database Connections](./docs/guides/database-connections.md)
* [Migrating Next.js from Vercel](./docs/migrations/nextjs-vercel-to-aws.md)
* [Ephemeral PR Previews & AWS Costs](./docs/guides/ephemeral-pr-previews.md)

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
  Wraps Terraform execution in a beautiful, terminal-friendly UI. Automatically provisions your AWS infrastructure and outputs your live CDN and Load Balancer URLs.
  *Tip: Append `--dry-run` to preview the architecture topology and estimated cost without provisioning anything.*
  
* **`npx deploy-stack secrets push <file>`**
  Securely encrypts your local environment variables (e.g., `.env.production`) into AWS Secrets Manager and maps them to your ECS container at runtime.

* **`npx deploy-stack doctor`**
  Scans your local environment and generated files to ensure all required dependencies (Docker, Terraform, AWS CLI) are installed and configured correctly.

* **`npx deploy-stack destroy`**
  Safely tears down your ECS cluster, Load Balancers, and networking resources to stop AWS billing. Includes an interactive prompt to optionally retain or delete your S3 remote state bucket.

* **`npx deploy-stack eject`**
  Strips all `deploy-stack` metadata and management tags from your project, leaving behind pure, standard Terraform and GitHub Actions files. You retain 100% ownership.

* **`npx deploy-stack --headless`**
  Bypasses the interactive wizard for fully programmatic execution. Perfect for CI/CD pipelines, custom scripts, or AI agent integration. Accepts flags like `--framework=static`, `--region=us-east-2`, and `--size=micro`.

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

👉 **[View all 14+ reference implementations in our Examples Gallery](./docs/examples.md)**

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

### Current Focus (Phase 7: Team Workflows & Ecosystem Integrations)
- [x] **Ephemeral PR Previews:** Generate GitHub Actions workflows that spin up temporary ECS Fargate tasks and post live preview URLs directly in pull request comments to streamline team code reviews.
- [x] **AI Context Synchronization:** Implement `deploy-stack sync-ai` to automatically generate `.cursorrules` and AI context files, ensuring coding assistants generate accurate deployment commands tailored to the project.
- [ ] **Native Ecosystem Integrations:** Publish seamless, push-button plugins across major frameworks. Targets include a `svelte-adapter-deploy-stack`, an official `create-next-app` AWS template, a `vite-plugin-deploy-stack`, a NestJS schematic, and a Django Cookiecutter template.
- [ ] **Automated Troubleshooting:** Build `deploy-stack diagnose` (alias: `wtf`) to automatically analyze and troubleshoot common day-2 AWS operational issues (e.g., Fargate OOM kills, ALB 502s) directly from the terminal.

👉 **[See the full project history and future plans in ROADMAP.md](./ROADMAP.md)**

---

## 📜 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.