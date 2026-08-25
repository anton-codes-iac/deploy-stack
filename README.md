# deploy-stack ☁️🚀

> The zero-lock-in cloud generator. Eject your containerized web app from expensive PaaS platforms to production-ready, highly available AWS infrastructure in 60 seconds.

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

* **Zero Vendor Lock-In:** Generates standard, clean `.tf` files. Modify, expand, or decouple them at any time.
* **Framework Agnostic:** Tailored container presets for Next.js, Express.js, FastAPI, and **Zero-Config Static Sites** (React, Vue, SvelteKit, Astro, Vite).
* **Smart Git Integration:** Automatically detects your working branch (`main`, `master`, `develop`) and binds it directly to the generated GitHub Actions pipeline.
* **Production-Grade Defaults:** Automatically provisions an Amazon ECS Fargate cluster fronted by an Application Load Balancer across multiple availability zones.
* **Global Edge Acceleration:** Includes an integrated AWS CloudFront CDN distribution with SSL termination and optimized caching.
* **Keyless, Zero-Secret CI/CD:** Uses AWS IAM OpenID Connect (OIDC) for automated GitHub Actions deployments—no long-lived AWS keys stored in GitHub Secrets.
* **Remote State with Native S3 Locking:** Automatically creates an encrypted S3 state bucket utilizing modern native S3 concurrency locking.
* **Built-in Secrets Sync:** Provides a dedicated CLI workflow to securely push local `.env` variables into AWS Secrets Manager and map them directly into containers at runtime.
* **Non-Destructive:** Safely analyzes existing directories and prompts for confirmation before updating any files.

---

## 🚀 Quick Start

Run the CLI directly in your project root:

```bash
npx deploy-stack
```

The interactive CLI will guide you through the setup:
1. **Target Directory / Name:** (Type `.` to bootstrap your current directory)
2. **Setup Mode:** (Choose **Quickstart** for sensible defaults, or **Advanced** for custom scaling and branch names)
3. **Zero-Config Detection:** The CLI automatically scans your project to detect your framework. For static sites, it intelligently discovers your build output directory (`dist`, `build`, `.output`, etc.) and dynamically configures the hardened Nginx container.
4. **AWS Region & Compute Tier:** (Select your target region and Fargate size with live cost estimates)

---

## 🔑 Securely Managing Secrets

Avoid committing sensitive environment files to version control. Push local variables directly to AWS:

```bash
npx deploy-stack secrets push .env.production
```
*This command encrypts your values in AWS Secrets Manager and updates `terraform/secret_keys.json` to expose those variables inside your ECS tasks at boot.*

---

## 🛠️ Next Steps After Generation

1. **Provision Infrastructure:**
   ```bash
   cd terraform
   terraform init
   terraform apply
   ```
2. **Push to GitHub:**
   ```bash
   git add .
   git commit -m "feat: infrastructure and deployment pipeline"
   git push origin main
   ```
3. **Automated Deployment:** GitHub Actions securely authenticates via OIDC, builds your container, pushes to Amazon ECR, and executes a zero-downtime rolling deployment to ECS.

---

## 📁 Generated File Structure

Running the CLI generates a modular architecture tailored to your service:

```text
your-project/
├── Dockerfile                  # Multi-stage container preset
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
---

## 🛡️ Telemetry & Privacy
By default, `deploy-stack` collects anonymous, hashed usage data to help improve the CLI (e.g., framework presets used, deployment success rates). **No codebase files, AWS credentials, or personal data are ever collected.**

To opt out, simply append the flag:
\`\`\`bash
npx deploy-stack --no-telemetry
\`\`\`

---

## 🗺️ Roadmap

- [x] **Core MVP:** Interactive CLI, ECS Fargate + ALB Terraform generation, CI/CD, and Secrets sync.
- [x] **Production Readiness:** CloudFront distribution, S3 State locking, and OIDC security.
- [x] **Smart Experience:** Zero-config framework auto-discovery for Next.js, Express, and FastAPI.
- [ ] **State & Storage:** Automated RDS PostgreSQL provisioning and persistent volumes.
- [ ] **Advanced Networking:** Custom domains (Route 53), ACM SSL configuration, and environment workspaces (staging/prod).
- [ ] **Security Hardening:** Private VPC subnets with NAT gateways, and AWS WAF integration.

---

## 📜 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.