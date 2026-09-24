---
title: Quickstart (5 minutes)
description: Go from empty repo to live AWS deployment in five minutes with deploy-stack.
sidebar:
  order: 0
---

Deploy your first app to AWS in about five minutes. This is the fastest path; follow the links for details at each step.

## Prerequisites

- Node.js 18+, an AWS account, and AWS credentials in your terminal (`aws sso login` or `aws configure`).
- A git repository with your app. Stuck on auth? See [Troubleshooting AWS Credentials](/deploy-stack/guides/aws-credentials/).

## Step 1 — Scaffold

```bash
npx deploy-stack
```

The wizard auto-detects your framework, `Procfile`, `vercel.json`, and `docker-compose.yml`, then writes Terraform, a `Dockerfile`, and `.github/workflows/deploy.yml`. Not sure your stack is supported? Check [Supported Frameworks](/deploy-stack/guides/frameworks/).

## Step 2 — Provision

```bash
npx deploy-stack apply
```

This creates the ALB, ECS cluster, and service. Your URL returns `503` until the first image is pushed — that is expected.

## Step 3 — Ship

```bash
git add .
git commit -m "ci: infra"
git push
```

Pushing to your deploy branch triggers the pipeline: Terraform sync, Docker build, image scan, ECS rollout. How it works is explained in [CI/CD Pipeline & First Deploy](/deploy-stack/guides/cicd-pipeline/).

## Step 4 — Verify

- Open the ALB URL from the `apply` output.
- Still seeing `503` or `502` after the workflow finishes? Run `npx deploy-stack diagnose` — usually the container failed its health check. See [Dockerfiles & the Container Contract](/deploy-stack/guides/dockerfiles/).
- Need env vars? Continue with [Secrets Management](/deploy-stack/guides/secrets-management/).

## Next steps

- [Supported Frameworks](/deploy-stack/guides/frameworks/) — framework requirements and detection rules.
- [Reference Implementations & Examples](/deploy-stack/guides/examples/) — working repos per framework.
- [Headless Mode & Automation](/deploy-stack/guides/headless/) — non-interactive `npx deploy-stack --headless` for CI.
- Migrating? Start with [Vercel (Next.js)](/deploy-stack/migrations/nextjs-vercel-to-aws/), [Vercel (Astro)](/deploy-stack/migrations/astro-vercel-to-aws/), [Vercel (SvelteKit)](/deploy-stack/migrations/sveltekit-vercel-to-aws/), or [Heroku (Procfile)](/deploy-stack/migrations/heroku-procfile-to-aws/).
