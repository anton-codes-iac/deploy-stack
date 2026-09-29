---
title: Stack Architecture
description: How the generated VPC, load balancer, cluster, CDN, data stores, and CI pipeline fit together.
---

Every deploy-stack project generates the same shape: a public-subnet VPC, an ALB-fronted Fargate cluster, CloudFront at the edge, and a keyless CI pipeline that ships images while Terraform owns the infrastructure. This page is the map; each piece links to its reference.

## Request path

Internet → **CloudFront** → **ALB** → **ECS tasks**. The distribution's origin is the load balancer (`cloudfront.tf`), so web traffic enters through the CDN with SSL terminated at the edge; the `Direct URL` printed by `apply` bypasses it for debugging.

Tasks run with `awsvpc` networking in **public subnets** spread across availability zones (`10.0.0.0/16` VPC, one subnet per AZ, internet gateway attached). There is intentionally **no NAT gateway** — tasks get public IPs and talk out directly, which saves ~$33/mo versus a conventional private-subnet layout. Isolation comes from security groups: the ALB accepts public internet traffic, tasks accept traffic only from the ALB, and outbound access stays open for image pulls and external APIs.

## Compute and images

One ECS cluster holds the `app` service, plus an optional private `worker` service with no load balancer (see [Background Workers](/deploy-stack/guides/background-workers/)). Both run the same ECR image: the pipeline builds once per push and tags it with the commit SHA (the immutable deploy artifact) and `latest`.

Two IAM roles split concerns: the **execution role** pulls images and reads secrets at boot, while the **task role** carries workload permissions — every [`add`](/deploy-stack/cli/add/) addon attaches its least-privilege policy here, so application code uses the AWS SDK with no keys.

Deploys never rebuild infrastructure: the pipeline registers a new task-definition revision per push and updates the service to it, while Terraform ignores the service's `task_definition` so the next `apply` never reverts a code deploy. An ECS deployment circuit breaker rolls back failed rollouts automatically, and every revision stays registered so [`rollback`](/deploy-stack/cli/rollback/) always has history. See [CI/CD Pipeline & First Deploy](/deploy-stack/guides/cicd-pipeline/).

## Data and secrets

- **Database** (when enabled) runs on RDS in **isolated subnets** with its own subnet group — no route to the internet. Pick the engine at scaffold time (`postgres`, `mysql`, or scale-to-zero `aurora-postgresql` via `--db-engine`). Reach it from your laptop via [`db connect`](/deploy-stack/cli/db/), and run migrations inside the VPC with [`db migrate`](/deploy-stack/cli/db/).
- **Secrets** live in Secrets Manager as one app secret, injected as environment variables at container boot from the key map in `terraform/secret_keys.json`. See [Secrets Management](/deploy-stack/guides/secrets-management/).
- **State** lives in an encrypted S3 bucket using native S3 locking (`use_lockfile`), so concurrent applies are safe without a lock table.

## CDN, domain, and email

CloudFront serves the app globally from the ALB origin. [`domain add`](/deploy-stack/cli/domain/) attaches your own hostname with an automated `us-east-1` ACM certificate; [`add email:ses`](/deploy-stack/cli/add/) provisions SES sending on the same domain with DKIM/SPF/DMARC. Both are optional day-2 steps over the base stack.

## Observability

One CloudWatch log group per project (`/ecs/<project>`, 14-day retention) collects web and worker streams; an alarm fires when the ALB serves more than ten 5XX errors in two minutes. [`status`](/deploy-stack/cli/status/) renders the health dashboard, [`diagnose`](/deploy-stack/cli/diagnose/) explains crashed tasks, and [`logs`](/deploy-stack/cli/logs/) streams without the console.

## Preview workspaces

Each open pull request gets a Terraform workspace (`preview.yml`) running the same files renamed by `app_name` plus an environment suffix — a full copy of the stack that `teardown.yml` destroys on close. A few resources are deliberately shared instead of copied (the ECR repository, Secrets Manager lookups), and account-wide singletons — the custom-domain ACM certificate and aliases, the SES domain identity/DKIM/DNS — are scoped to the production (`default`) workspace via `count` guards, so previews neither duplicate them nor delete them on teardown; previews serve over their own `*.cloudfront.net` URL and inherit SES sending permission. See [Ephemeral PR Previews](/deploy-stack/guides/ephemeral-pr-previews/).

## See also

- [Quickstart (5 minutes)](/deploy-stack/guides/quickstart/) for the fastest path through this stack.
- [Understanding Your AWS Bill](/deploy-stack/guides/understanding-your-bill/) for what each piece costs.
