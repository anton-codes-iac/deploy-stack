---
title: "Managed Database Connections"
description: "Provision a managed AWS RDS PostgreSQL database for backend frameworks."
sidebar:
  order: 6
---

When you run `npx deploy-stack` for a backend framework (Node, Django, Rails, Go, etc.), the CLI prompts you to automatically provision a managed AWS RDS PostgreSQL database. The database adds a fixed monthly cost on top of the stack baseline — the `apply` preview itemizes it before you provision.

## Zero-Trust Architecture

If you select "Yes", `deploy-stack` builds a true zero-trust network topology:
1. The PostgreSQL instance is deployed into heavily restricted **Isolated Subnets**.
2. It is given a strict Security Group that *only* allows inbound traffic from your specific ECS Fargate containers on port `5432`.
3. The database is completely inaccessible from the public internet.

## Auto-Injected Environment Variables

You do not need to configure database connection strings manually. The generated Terraform automatically creates a secure, random master password in AWS Secrets Manager and injects the following environment variables directly into your running containers:

* `DB_HOST` (The internal AWS DNS endpoint)
* `DB_PORT` (5432)
* `DB_NAME` (Your deterministic database name, derived from your project name)
* `DB_USER` (Injected securely at runtime)
* `DB_PASSWORD` (Injected securely at runtime)

To connect your application, simply configure your ORM (Prisma, Django, TypeORM, Active Record) to read from these deploy-stack injected variables.

Most frameworks expect a single connection string (e.g., `DATABASE_URL`). Construct it from the injected variables at runtime:

```bash
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
```

If the password contains special characters (e.g., `@`, `[`, `/`), percent-encode it before placing it in the URI.

## Running Database Migrations

Because the database is in an isolated subnet, you cannot run schema migrations directly from your local laptop. 
The best practice is to configure your CI/CD pipeline or your Docker container's startup script to run your migrations (e.g., `npx prisma deploy` or `python manage.py migrate`) before starting the main web process.

## Inspecting Data Locally

For read-only inspection from your laptop (psql, DBeaver, Prisma Studio), open a secure tunnel with [`db connect`](/deploy-stack/cli/db/) instead of exposing the database — migrations should still run inside the VPC as described above.