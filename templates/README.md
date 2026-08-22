# {{PROJECT_NAME}} - Cloud Infrastructure

This project was provisioned by `create-cloud-stack`. It contains a production-ready AWS ECS Fargate architecture and a GitHub Actions deployment pipeline.

## 💰 Cost Estimate & Disclaimer

This infrastructure provisions a highly available Application Load Balancer (ALB) and an ECS Fargate container (Size: **{{COMPUTE_TIER}}**).
    
* **Estimated Monthly Cost:** {{ESTIMATED_COST}}
* *Note: AWS bills by the hour. If you destroy this stack after a few hours of testing, it will cost less than $0.20.*

> **⚠️ DISCLAIMER:** This cost is a rough estimate. AWS pricing changes and varies by region. **You are solely responsible for all AWS charges incurred by deploying this infrastructure.** The creators of `create-cloud-stack` are not liable for unexpected cloud costs, compromised credentials, or runaway billing. Always monitor your AWS Billing Dashboard and set up budget alerts.

## 🚀 Deployment Guide

1. **Initial Provisioning:**
   ```bash
   cd terraform
   terraform init
   terraform apply
   ```

2. **Push Secrets (Optional):**
   If your application requires environment variables, create a local `.env` file and sync it directly to AWS Secrets Manager:
   ```bash
   npx create-cloud-stack secrets push .env
   ```

3. **Automated CI/CD (Keyless via OIDC):**
   Push this repository to GitHub. Your deployment pipeline uses AWS IAM OpenID Connect (OIDC) to authenticate securely with temporary credentials—**no long-lived AWS secret keys are required in GitHub Secrets**. Every push to `main` will automatically build, package, and deploy your application.

### ⚠️ Troubleshooting: OIDC Provider Already Exists
AWS only permits one GitHub Actions OIDC provider per AWS account. If `terraform apply` fails with an `EntityAlreadyExists` error regarding the OIDC provider, it indicates GitHub Actions was previously configured in this account.

**The Fix:**
Open `terraform/oidc.tf` and update the default value of `create_oidc_provider` to `false`:
```hcl
variable "create_oidc_provider" {
  type    = bool
  default = false # <--- Change this from true to false
}
```
Re-run `terraform apply` to link directly to your existing provider.

## 🛑 Safe Teardown (Destroying the Stack)

If you are done testing and want to stop all AWS billing, you must destroy the infrastructure. 

Because our Terraform configuration is set to force-delete the ECR image repository (even if images are present), teardown is a single, clean command:

```bash
cd terraform
terraform destroy
```
*Type `yes` when prompted. This will permanently delete the Load Balancer, ECS cluster, log groups, and associated networking components.*

## ⚠️ Critical Application Prerequisites

Before you push your code to GitHub, ensure your application is configured to run inside a Docker container and respond to AWS Load Balancer health checks.

### 1. The Health Check Route (All Frameworks)

AWS constantly pings your container to ensure it is alive. If you configured a custom health check path (e.g., `/api/health`) during the CLI setup, **you must create that route in your application**. If AWS receives a `404 Not Found`, it will assume your app is broken and terminate the container.

Make sure your app returns a `200 OK` at your configured path:

* **Next.js (App Router):** Create `app/api/health/route.ts` returning a 200 response.
* **Express.js:** Add `app.get('/api/health', (req, res) => res.sendStatus(200));`
* **FastAPI/Python:** Add `@app.get("/api/health")` returning a 200 status.

### 2. Enable Standalone Output (Next.js ONLY)

Next.js must be configured in "standalone" mode so it can bundle a minimal Node.js server. Without this, your GitHub Actions Docker build will crash.
    
Open `next.config.js` or `next.config.ts` in your root directory and add `output: 'standalone'`:

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone', // <--- Add this exact line
};

export default nextConfig;
```