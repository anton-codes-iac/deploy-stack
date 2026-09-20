---
title: CI/CD Pipeline & First Deploy
description: How the generated GitHub Actions workflow builds, scans, and deploys your app with zero stored AWS keys.
sidebar:
  order: 1
---

Every `npx deploy-stack` run generates `.github/workflows/deploy.yml`. This page explains what that pipeline does, when it runs, and why your site returns `503` until the first push completes.

## When it runs

The workflow triggers on two events (`templates/github/deploy.yml`):

- A `push` to your deploy branch (`{{DEPLOY_BRANCH}}`, chosen during setup).
- A weekly Sunday cron (`0 0 * * 0`) that re-applies the Terraform configuration, so drift and base-image updates converge automatically.

The region, ECR repository, ECS cluster, and ECS service names are baked in at generation time as `<project>-repo`, `<project>-cluster`, and `<project>-service`.

## No stored AWS keys

Authentication uses GitHub OIDC, not long-lived credentials. The workflow declares:

```yaml
permissions:
  id-token: write
  contents: read
```

and assumes the `{{PROJECT_NAME}}-github-actions-role` IAM role created by `terraform/oidc.tf`. There is nothing to rotate and no secret to leak. (If your AWS account already has a GitHub OIDC provider, set `create_oidc_provider = false` in `terraform/oidc.tf` — see [apply](/cli/apply/).)

## The five stages

1. **IaC security scan.** Trivy scans `terraform/` for vulnerabilities, secrets, and misconfigurations (`CRITICAL,HIGH`). It is informational only (`exit-code: '0'`), so it never blocks the build; results land in the GitHub step summary.
2. **Infrastructure sync.** The `anton-codes-iac/deploy-stack-action@v1` step runs Terraform against `terraform/`, so infrastructure changes committed alongside code are applied before the new image rolls out.
3. **Build & push.** The workflow logs in to Amazon ECR, runs `docker build` on your generated `Dockerfile`, and tags the result `latest`.
4. **Container scan.** Trivy scans the built image (`os,library`, `ignore-unfixed: true`), again informational only with results in the step summary.
5. **Deploy.** The image is pushed to ECR and the workflow forces a new ECS deployment (`aws ecs update-service --force-new-deployment`), which rolls the new image across your tasks behind the ALB.

## Why you see a 503 first

`npx deploy-stack apply` provisions the ALB, cluster, and service, but no container image exists until this workflow runs once. Pushing to your deploy branch (`git add . && git commit -m "ci: infra" && git push`) builds and deploys the first image, clearing the `503`. If the service stays unhealthy after that, run `npx deploy-stack diagnose` — usually the container failed its ALB health check (see [Dockerfiles](/guides/dockerfiles/)).

## Related workflows

- `preview.yml` / `teardown.yml` exist only when ephemeral PR previews are enabled. See [Ephemeral PR Previews](/guides/ephemeral-pr-previews/).
- Secrets are injected at deploy time from AWS Secrets Manager, never from the repo. See [Secrets Management](/guides/secrets-management/).
