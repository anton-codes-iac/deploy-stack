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
* **PaaS Migration Engine:** Natively parses Heroku `Procfile` configurations to automatically translate web and background worker processes (like Celery or Sidekiq) into multi-container AWS Fargate architectures.
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
* **[Express.js API](https://github.com/anton-codes-iac/deploy-stack-express-example):** A standard Node.js backend setup.
* **[Python FastAPI](https://github.com/anton-codes-iac/deploy-stack-fastapi-example):** A Python API demonstrating unprivileged port mapping.
* **[Vite / React SPA](https://github.com/anton-codes-iac/deploy-stack-vite-example):** Demonstrates SPA routing and `dist/` auto-detection.
* **[Create React App](https://github.com/anton-codes-iac/deploy-stack-cra-example):** Validates backward compatibility with legacy Webpack pipelines and `build/` auto-detection.
* **[Astro Static Site](https://github.com/anton-codes-iac/deploy-stack-astro-example):** Demonstrates modern static site generation (SSG).
* **[SvelteKit Application](https://github.com/anton-codes-iac/deploy-stack-svelte-example):** Demonstrates static adapter integration and custom output folder detection.
* **[Ruby on Rails](https://github.com/anton-codes-iac/deploy-stack-rails-example):** A production Rails 7+ setup featuring an auto-provisioned PostgreSQL database and secure `.auto.tfvars` Master Key injection.
* **[Nuxt 3 (SSR)](https://github.com/anton-codes-iac/deploy-stack-nuxt-example):** Demonstrates a fully server-side rendered Nuxt application using Nitro's optimized Node output.
* **[Django / Python](https://github.com/anton-codes-iac/deploy-stack-django-example):** A secure Gunicorn/WSGI implementation with PostgreSQL and unprivileged container adapters.
* **[Heroku to AWS Migration (Django)](https://github.com/anton-codes-iac/deploy-stack-heroku-django-example):** A classic Heroku-style monolith migrated via the Procfile Importer, demonstrating a multi-container Web and Celery Worker architecture deployed from a single codebase.
* **[Go / Fiber](https://github.com/anton-codes-iac/deploy-stack-go-example):** A distroless, compiled Go binary deployment demonstrating ultra-low memory footprints and instant boot times.
---

## 🛡️ Telemetry & Privacy
By default, `deploy-stack` collects anonymous, hashed usage data to help improve the CLI (e.g., framework presets used, deployment success rates). **No codebase files, AWS credentials, or personal data are ever collected.**

To opt out, simply append the flag:
```bash
npx deploy-stack --no-telemetry
```

---

## 🗺️ Roadmap

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

### Phase 6: Migration & Trust Engine (Current)
- [x] **Dry-Run Visualization:** Interactive pre-flight terminal UI with ASCII topology maps and precise, dynamic AWS cost estimation.
- [ ] **PaaS Importers:** Auto-parse `vercel.json` or Heroku `Procfile` configurations to map build commands and environment variables automatically.
- [ ] **Docker Compose to ECS Translator:** Automatically converting a familiar local `docker-compose.yml` into production ECS task definitions.
- [ ] **AI Agent Rulesets:** Publishing `.cursorrules` and Copilot instructions that teach AI assistants exactly how to utilize the CLI on the user's behalf.

---

## 📜 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.