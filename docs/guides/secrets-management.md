# Secrets Management in deploy-stack

Managing `.env` files across a team and syncing them to the cloud is a notorious pain point. `deploy-stack` solves this by natively integrating with **AWS Secrets Manager**, ensuring zero plaintext secrets ever touch your GitHub repository or CI/CD pipelines.

## Pushing Secrets to AWS

Instead of manually clicking through the AWS Console, use the built-in secrets command:

```bash
npx deploy-stack secrets push .env.production
```

### What happens under the hood?
1. The CLI reads your local `.env.production` file.
2. It encrypts the key-value pairs and pushes them securely into AWS Secrets Manager under your project's namespace (e.g., `my-project-secrets`).
3. It generates a local `terraform/secret_keys.json` file containing *only the names* of your keys (e.g., `["API_KEY", "STRIPE_SECRET"]`), **not the values**.

## How Secrets Reach Your App

When you commit `terraform/secret_keys.json` and push to GitHub, your CI/CD pipeline runs Terraform. 

Terraform reads the JSON array of key names and dynamically maps them to your ECS Task Definition. When your AWS Fargate container boots up, it automatically injects those secrets directly into your application's environment as standard environment variables (e.g., `process.env.STRIPE_SECRET` or `os.getenv("API_KEY")`).

*Note: Because Terraform maps the secrets at runtime, updating a secret value in AWS and running an empty GitHub deployment will instantly cycle your containers with the new keys!*