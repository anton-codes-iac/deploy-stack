---
title: secrets push
description: Push local environment variables to AWS Secrets Manager.
---

Upload your `.env` file to the Secrets Manager vault provisioned for this project, so your deployed app can read the values at runtime.

## What it does

- Reads and parses a local env file (defaults to `.env`) and pushes every key as a single JSON secret string to the `<project-name>-secrets` vault via `UpdateSecretCommand`. This is the value of the command: no manual AWS console edits, and your app picks up the values on the next deployment.
- Resolves the AWS region from the `region` setting in `terraform/main.tf`, falling back to `AWS_REGION` or your AWS profile default.
- Writes the pushed key names to `terraform/secret_keys.json` so the Terraform configuration and CI redeploy know which variables exist. Commit this file and push to trigger a deployment with the new variables.
- Emits a `secrets_pushed` telemetry event. Exits non-zero on failure.

## Usage

```bash
npx deploy-stack secrets push
npx deploy-stack secrets push .env.production
```

The optional positional argument is the path of the env file to push (resolved relative to the project root). It defaults to `.env` when omitted or blank.

## Flags

This command accepts no CLI flags.

## Prerequisites

- Run `npx deploy-stack apply` first: the `<project-name>-secrets` vault is created during provisioning. If it does not exist yet, the command points you back to `apply`.
- Valid AWS credentials. On expired credentials, refresh with `aws sso login` or `aws configure`. See the [AWS credentials guide](/guides/aws-credentials/).

## See also

- [Secrets management guide](/guides/secrets-management/)
- [apply](/cli/apply/)
