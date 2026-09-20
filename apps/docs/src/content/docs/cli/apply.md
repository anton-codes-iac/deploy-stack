---
title: apply
description: Provision or update your AWS infrastructure with Terraform.
---

Run the Terraform plan/apply flow against the generated configuration.

## What it does

- Verifies you are in a deploy-stack project (`terraform/main.tf` must exist), exiting otherwise, so `apply` never runs against the wrong directory.
- Renders an infrastructure preview from your Terraform config and framework detection. With `--dry-run` it stops there and provisions nothing.
- Otherwise runs `terraform init -upgrade` followed by `terraform apply -auto-approve` in `terraform/`, streaming progress, then prints the live URLs from the Terraform outputs (`cloudfront_url` and `alb_direct_url`) plus the `git push` command that deploys your app and clears the initial 503.
- On the known GitHub OIDC provider conflict (`EntityAlreadyExists` for `token.actions.githubusercontent.com`), tells you to set `create_oidc_provider = false` in `terraform/oidc.tf` and re-run; other failures print the Terraform error and the manual `cd terraform && terraform apply` fallback.
- Emits an `infrastructure_applied` telemetry event recording success or the error code.

## Usage

```bash
npx deploy-stack apply
npx deploy-stack apply --dry-run
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--dry-run` | Render a preview of the planned changes without applying them. |

`apply` shells out to the `terraform` binary in your generated `terraform/` directory and streams progress while it runs.
