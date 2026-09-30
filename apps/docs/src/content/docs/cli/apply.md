---
title: apply
description: Provision or update your AWS infrastructure with Terraform.
---

Run the Terraform plan/apply flow against the generated configuration.

## What it does

- Verifies you are in a deploy-stack project (`terraform/main.tf` must exist), exiting otherwise, so `apply` never runs against the wrong directory.
- Renders an infrastructure preview from your Terraform config and framework detection: a `Fixed Baseline` monthly figure with per-service breakdown, one topology entry per provisioned [`add`](/deploy-stack/cli/add/) addon (collapsing to a single `Addons (N)` line when three or more are active), and a one-line `Usage-based (N addons)` summary of metered billing drivers (shown only when usage-billed addons are present). With `--dry-run` it stops there and provisions nothing.
- Otherwise runs `terraform init -upgrade` followed by `terraform apply -auto-approve` in `terraform/`, streaming progress, then prints the live URLs from the Terraform outputs (`cloudfront_url` and `alb_direct_url`) plus the `git push` command that deploys your app and clears the initial 503.
- Asks for confirmation after the preview; declining aborts without provisioning anything.
- If the S3 state bucket is missing (e.g. deleted manually), offers to recreate it and resume automatically instead of failing.
- If the environment is asleep (a `.deploy-stack/sleep-state.json` entry exists), warns you to run [`wake`](/deploy-stack/cli/sleep/) first — applying would start tasks against a stopped database.
- On the known GitHub OIDC provider conflict (`EntityAlreadyExists` for `token.actions.githubusercontent.com`), tells you to set `create_oidc_provider = false` in `terraform/oidc.tf` and re-run; other failures print the Terraform error and the manual `cd terraform && terraform apply` fallback.

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
