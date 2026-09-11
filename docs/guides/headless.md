# Headless Mode & Automation Guide

The `deploy-stack` CLI is designed to be fully automatable for CI/CD pipelines, custom scripts, Cookiecutters, and framework plugins (like `vite-plugin-deploy-stack`). 

By passing the `--headless` flag, you bypass all interactive terminal prompts.

## Required Flags
To use headless mode, simply include the `--headless` flag. 

If `deploy-stack` cannot auto-detect your framework, you should also provide the `--framework` flag to ensure the correct infrastructure is generated.

* **Valid `--framework` options:** `node`, `nextjs`, `nuxt`, `python`, `django`, `rails`, `go`, `static`

## Optional Configuration Flags

You can append any of these flags to customize the generated architecture. These map exactly to the options available in the interactive setup:

| Flag | Description | Default |
|---|---|---|
| `--region=<region>` | The AWS region to deploy to (e.g., `us-east-1`, `eu-west-1`). | `us-east-2` |
| `--size=<size>` | The Fargate compute size (`micro` or `small`). | `micro` |
| `--port=<number>` | The internal port your container exposes. | Framework dependent (`3000`, `8080`, `8000`) |
| `--healthCheckPath=<path>`| The ALB health check endpoint path. | `/` |
| `--desiredCount=<number>` | Number of container replicas to run (`1` or `2`). | `1` |
| `--branch=<name>` | The primary Git deployment branch for CI/CD. | `main` |
| `--dir=<path>` | The directory to generate files into (use `.` for current).| `.` |
| `--needsDatabase` | Provisions a managed AWS RDS PostgreSQL database alongside Fargate. | `false` |
| `--enablePrPreviews` | Generates workflows for Ephemeral PR Previews. | `false` |
| `--yes` | Automatically bypasses confirmation prompts during apply/destroy. | `false` |
| `--no-telemetry` | Disables anonymous usage analytics. | `false` |

*(Note: Boolean flags like `--needsDatabase` and `--enablePrPreviews` can be passed alone or as `--flag=true`).*

## Example Usage

**Standard Static Site Automation (e.g., Vite/React):**
```bash
npx deploy-stack --headless --framework=static --region=eu-west-1 --size=micro
```

**Next.js High-Availability CI/CD Generation:**
```bash
npx deploy-stack --headless --framework=nextjs --size=small --desiredCount=2 --yes
```

**Django Setup with Managed RDS Database:**
```bash
npx deploy-stack --headless --framework=django --needsDatabase
```