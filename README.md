# create-cloud-stack ☁️🚀

> The zero-lock-in cloud scaffolder. Eject your containerized web app from expensive PaaS providers to raw, production-ready AWS Terraform in 60 seconds.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## The Problem

You love the speed of managed platforms like Vercel, Heroku, or Render to get your web app off the ground. But as your project scales, the pricing per seat and bandwidth overages become unsustainable. 

The alternative? Migrating to your own AWS account. But writing raw Terraform, setting up ECS clusters, configuring load balancers, and building secure CI/CD pipelines requires writing hundreds of lines of complex boilerplate infrastructure code from scratch.

## The Solution

**`create-cloud-stack`** is an interactive CLI tool that bridges the gap. It interviews you about your project and instantly scaffolds **clean, readable, and completely ejectable Terraform and GitHub Actions workflows** directly into your repository. 

You don't rent your infrastructure through a black-box SaaS platform—**you own the code.**

---

## ✨ Features

*   **Zero Vendor Lock-In:** Generates standard, highly readable `.tf` files. Modify them, extend them, or throw us away—the code is 100% yours.
*   **Framework Agnostic:** Whether you're running a Next.js standalone container, an Express API, or a Python FastAPI service, if it runs in Docker, it runs here.
*   **Production-Grade Defaults:** Automatically provisions an Amazon ECS Fargate cluster behind a public Application Load Balancer (ALB), spread across multiple availability zones.
*   **Secure CI/CD Ready:** Scaffolds a complete GitHub Actions workflow to build your Docker image, push it to AWS ECR, and automatically trigger zero-downtime ECS deployments.
*   **Built-in Secrets Syncing:** Features a custom CLI command to securely sync your local `.env` variables directly into AWS Secrets Manager and map them into your containers at runtime.
*   **Non-Destructive:** Run it safely in existing projects. It detects existing Dockerfiles and Terraform configurations and asks for permission before overwriting.

---

## 🚀 Quick Start

Run the scaffolder directly in your existing project directory:

```bash
npx create-cloud-stack
```

The interactive CLI will guide you through a few simple prompts:
1. **Project Name:** (Type `.` to inject directly into your current directory)
2. **AWS Region:** (e.g., `us-east-2`)
3. **Target Port:** (e.g., `3000` or `8080`)
4. **Framework / Runtime:** (Selects the optimized `Dockerfile` preset)

### 🔑 Securely Managing Secrets

Never commit your `.env` file! Once your infrastructure is scaffolded, you can securely push your local environment variables to AWS:

```bash
npx create-cloud-stack secrets push .env.production
```
*This command encrypts your keys in AWS Secrets Manager and dynamically updates your local `terraform/secret_keys.json` file so ECS knows to inject them into your container on the next boot.*

### Next Steps After Scaffolding

1. **Deploy your Infrastructure:**
   ```bash
   cd terraform
   terraform init
   terraform apply
   ```
2. **Push to GitHub:**
   ```bash
   git add .
   git commit -m "feat: add AWS infrastructure and deployment pipeline"
   git push origin main
   ```
3. **Watch it Deploy:** Add your `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` to your GitHub Repository Secrets. Your automated GitHub Actions workflow will handle the rest!

---

## 📐 Architecture Overview

### Generated File Structure
When you run the CLI, it generates the following files tailored to your project:

```text
your-project/
├── Dockerfile                  # Optimized container preset
├── .github/
│   └── workflows/
│       └── deploy.yml          # Automated CI/CD pipeline
└── terraform/
    ├── main.tf                 # ECR, ECS Cluster, and Fargate Service
    ├── network.tf              # VPC, Public Subnets, and Security Groups
    ├── secrets.tf              # AWS Secrets Manager provisioning
    └── secret_keys.json        # Dynamic map of injected environment variables
```

---

## 🗺️ Roadmap

- [x] **POC:** Interactive CLI, ECS Fargate + ALB Terraform generation, Github Actions pipeline, and Secrets Syncing.
- [ ] **MVP:** CloudFront edge caching, Remote Terraform State (S3 backend).
- [ ] **v1.0 (Pro):** Automated RDS PostgreSQL scaffolding, custom domain Route53/ACM SSL setup, and multi-environment workspaces (`staging` vs `prod`).
- [ ] **v2.0 (Enterprise/DevSecOps):** Private-only VPC subnets, AWS WAF integration, and automated compliance drift scanning via Checkov.

---

## 📜 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.