---
title: db connect
description: Open a secure local tunnel to your managed RDS database.
---

Connect your local tools (psql, DBeaver, DataGrip) or a local `.env` file directly to your isolated RDS PostgreSQL instance — without ever exposing the database to the public internet. The command tunnels through a running ECS container as a jump host.

## What it does

- Finds your RDS instance (`<project-name>-db`, or `<project-name>-<workspace>-db` for PR-preview environments) and reads its endpoint and managed credentials from Secrets Manager.
- Prints the local host, port, database name, username, and a copy-pasteable `postgresql://` connection string. The password stays masked as `********` unless you pass `--show-credentials`.
- Finds a running container for the current project automatically and opens the tunnel via the Session Manager port-forwarding session. Press Ctrl+C to close it.
- Resolves its inputs automatically: cluster, service, and region (same order as `exec`: explicit flag → environment variable → `terraform/main.tf` → default).
- When no database is provisioned, or no containers are running, explains what to do (`init`/`apply`/`status`) and exits 1 instead of failing cryptically.
- On expired AWS credentials, points you to `aws sso login` / `aws configure` and exits 1 instead of throwing.
- Emits a `db_connect_run` telemetry event recording success and outcome. Credentials are never included in telemetry.

## Usage

```bash
npx deploy-stack db connect
npx deploy-stack db connect --port 5544
npx deploy-stack db connect --show-credentials
npx deploy-stack db connect --workspace pr-123
```

Paste the printed connection string into DBeaver, or export it locally:

```bash
export DATABASE_URL="postgresql://dbadmin:<password>@localhost:5432/<dbname>"
```

The printed connection string already percent-encodes special characters in the username and password (AWS-generated passwords often contain `@`, `[`, or `/`). The standalone `Password:` line is shown verbatim — encode it yourself if you build a URI by hand instead of copying ours.

## Flags

| Flag | Description |
| ---- | ----------- |
| `--port <port>` | Local port for the tunnel (default `5432`). Must be a number between 1 and 65535. |
| `--show-credentials` | Reveal the decrypted password in the terminal output. Masked by default. |
| `--workspace <name>` | Target a PR-preview environment (e.g. `--workspace pr-123`). Falls back to the workspace in `.terraform/environment`. |
| `--cluster <name>` | Explicit cluster name override. |
| `--service <name>` | Explicit service name override. |
| `--region <region>` | Explicit AWS region override. |

## Prerequisites

- Run `npx deploy-stack apply` first with a managed database provisioned (answer "Yes" to the database prompt during `init`).
- Install the AWS CLI and the Session Manager plugin (`brew install session-manager-plugin` on Mac; the command prints the right instructions for your OS when it's missing). On expired credentials, refresh with `aws sso login` or `aws configure`. See the [AWS credentials guide](/deploy-stack/guides/aws-credentials/).

## See also

- [Managed Database Connections](/deploy-stack/guides/database-connections/)
- [exec](/deploy-stack/cli/exec/)
- [status](/deploy-stack/cli/status/)
