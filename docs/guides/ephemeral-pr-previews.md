# 🚀 Ephemeral PR Previews

When enabled, `deploy-stack` automatically configures your GitHub Actions pipeline to spin up isolated, temporary AWS environments every time a developer opens a Pull Request.

A bot will comment on the PR with a live URL (e.g., `http://pr-123-your-app...`), allowing your team to test features, UI changes, and API updates before merging to `main`. When the PR is closed or merged, the environment is automatically destroyed.

### 🏗️ How it Works

Under the hood, `deploy-stack` utilizes **Terraform Workspaces**. 

When a PR is opened, Terraform creates a new workspace (e.g., `pr-12`). It provisions a completely isolated Application Load Balancer and ECS Fargate Task using the exact same infrastructure definitions as your production environment, ensuring 100% parity.

To save time and simplify architecture, PR environments **share** your production AWS Secrets Manager vault and ECR Image Repository.

### ⚖️ The Rule of Thumb: Should I enable this?

**✅ Enable PR Previews if:**
* You are working on a team of 2+ developers and require visual QA or UX sign-off before merging code.
* You are building a frontend application or full-stack monolith where seeing the live UI is critical.

**❌ Do NOT enable PR Previews if:**
* You are a solo developer (you can just test locally).
* You have a massive volume of PRs (e.g., automated Dependabot updates). Spinning up an AWS Load Balancer takes ~3 minutes, which will slow down rapid automated merges.

### 💰 AWS Cost Implications

Because PR previews provision a real Application Load Balancer (ALB) and ECS Fargate compute tasks, **they are not free.**

* **Compute:** You are charged standard AWS Fargate rates per minute while the PR environment is running.
* **Load Balancing:** AWS charges ~$16/month per active Load Balancer. If a PR is open for 2 days, you pay the prorated ALB cost for those 48 hours (~$1.00).

To keep costs low, ensure your team closes or merges Pull Requests promptly so the `teardown.yml` workflow can destroy the resources and stop the billing clock!