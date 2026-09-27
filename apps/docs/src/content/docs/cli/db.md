---
title: db
description: Tunnel to, migrate, back up, and restore your managed RDS database.
---

Run migrations, create safety checkpoints, and restore your managed RDS PostgreSQL database — all from the terminal, without ever exposing the database to the public internet.

## Commands

```bash
npx deploy-stack db connect                  # Open a secure local tunnel
npx deploy-stack db migrate --cmd "<command>" # Run migrations inside your VPC
npx deploy-stack db backup                   # Create a snapshot checkpoint
npx deploy-stack db restore <snapshot-id>    # Restore from a snapshot
```

## db connect

Connect your local tools (psql, DBeaver, DataGrip) or a local `.env` file directly to your isolated RDS instance. The command tunnels through a running ECS container as a jump host.

- Finds your RDS instance (`<project-name>-db`, or `<project-name>-<workspace>-db` for PR-preview environments) and reads its endpoint and managed credentials from Secrets Manager.
- Prints the local host, port, database name, username, and a copy-pasteable `postgresql://` connection string. The password stays masked as `********` unless you pass `--show-credentials`.
- Finds a running container for the current project automatically and opens the tunnel via the Session Manager port-forwarding session. Press Ctrl+C to close it.
- Resolves its inputs automatically: cluster, service, and region (same order as `exec`: explicit flag → environment variable → `terraform/main.tf` → default).
- When no database is provisioned, or no containers are running, explains what to do (`init`/`apply`/`status`) and exits 1 instead of failing cryptically.
- On expired AWS credentials, points you to `aws sso login` / `aws configure` and exits 1 instead of throwing.
- Emits a `db_connect_run` telemetry event recording success and outcome. Credentials are never included in telemetry.

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

| Flag | Description |
| ---- | ----------- |
| `--port <port>` | Local port for the tunnel (default `5432`). Must be a number between 1 and 65535. |
| `--show-credentials` | Reveal the decrypted password in the terminal output. Masked by default. |
| `--workspace <name>` | Target a PR-preview environment (e.g. `--workspace pr-123`). Falls back to the workspace in `.terraform/environment`. |
| `--cluster <name>` | Explicit cluster name override. |
| `--service <name>` | Explicit service name override. |
| `--region <region>` | Explicit AWS region override. |

## db migrate

Run schema migrations or seed scripts (Prisma, Drizzle, Alembic, Django, Rails, or anything custom) inside your VPC as a short-lived ECS task — no tunnel, no local database access needed. Logs stream live to your terminal, and the command exits with your migration's own exit code.

When you omit `--cmd`, the project is inspected for a known migration setup (`db:migrate` / `migrate` npm scripts, Prisma, Drizzle, Alembic, Django, Rails) and the detected command is used (in CI) or offered for confirmation (interactively).

```bash
npx deploy-stack db migrate --cmd "npx prisma migrate deploy"
npx deploy-stack db migrate                     # auto-detect the command
npx deploy-stack db migrate --cmd "npm run db:seed" --timeout 1200
```

| Flag | Description |
| ---- | ----------- |
| `--cmd <command>` | Migration command to run. Auto-detected when omitted. |
| `--task-def <task-def>` | Task definition (ARN or `family:revision`) to run. Defaults to the live service revision. |
| `--timeout <seconds>` | Give up after this long (default `600`). The task is stopped automatically. |
| `--setup-ci` | Install the pre-deploy migration gate into `.github/workflows/deploy.yml` instead of running. |
| `--project-name <name>` | Explicit project name override. |
| `--workspace <name>` | Target a PR-preview environment. |
| `--cluster <name>` | Explicit cluster name override. |
| `--service <name>` | Explicit service name override. |
| `--container <name>` | Explicit container name override. |
| `--region <region>` | Explicit AWS region override. |

### Pre-deploy migration gate

`db migrate --setup-ci` adds a step to your deploy workflow that runs migrations against the newly built image **before** the ECS service updates — a failing migration halts the release automatically:

```bash
npx deploy-stack db migrate --cmd "npx prisma migrate deploy" --setup-ci
```

The step is re-installed cleanly on every run, so re-running the command updates the wired migration command in place.

## db backup

Create a point-in-time safety checkpoint of your database before risky operations like migrations or restores. The command waits until the snapshot is ready, then prints the restore command for it.

```bash
npx deploy-stack db backup
npx deploy-stack db backup --id pre-migration-checkpoint
npx deploy-stack db backup --no-wait          # return immediately
```

| Flag | Description |
| ---- | ----------- |
| `--id <snapshot-id>` | Custom snapshot id. Defaults to `<db>-manual-YYYYMMDD-HHmmss`. |
| `--timeout <seconds>` | Give up waiting after this long (default `900`). Creation continues in the background. |
| `--no-wait` | Return immediately without waiting for the snapshot to become available. |
| `--project-name <name>` | Explicit project name override. |
| `--workspace <name>` | Target a PR-preview environment. |
| `--db-identifier <id>` | Explicit RDS instance identifier override. |
| `--region <region>` | Explicit AWS region override. |

## db restore

Restore your database from a manual or automated snapshot. Omit the snapshot id to pick from a list of available checkpoints, newest first.

Restoring works through Terraform: the command pins the snapshot in `terraform/database.tf` (`snapshot_identifier`), so the VPC wiring, security groups, and Secrets Manager integration stay intact and future applies stay clean. Run `npx deploy-stack apply` afterwards to perform the restore.

```bash
npx deploy-stack db restore                  # pick a snapshot interactively
npx deploy-stack db restore my-snapshot-id
npx deploy-stack db restore my-snapshot-id --yes   # skip confirmation (for CI)
```

> **Restoring replaces your current data.** Everything written after the snapshot is permanently discarded. Create a safety checkpoint with `npx deploy-stack db backup` first if you might need the current data.

| Flag | Description |
| ---- | ----------- |
| `<snapshot-id>` | Snapshot to restore (positional). Omit to choose interactively. |
| `--yes` | Skip the confirmation prompt. Required in non-interactive environments. |
| `--project-name <name>` | Explicit project name override. |
| `--workspace <name>` | Target a PR-preview environment. |
| `--db-identifier <id>` | Explicit RDS instance identifier override. |
| `--region <region>` | Explicit AWS region override. |

After `apply` completes, leave `snapshot_identifier` in `terraform/database.tf` — it keeps subsequent applies drift-free.

## Prerequisites

- Run `npx deploy-stack apply` first with a managed database provisioned (answer "Yes" to the database prompt during `init`).
- `db connect` additionally needs the AWS CLI and the Session Manager plugin (`brew install session-manager-plugin` on Mac; the command prints the right instructions for your OS when it's missing). On expired credentials, refresh with `aws sso login` or `aws configure`. See the [AWS credentials guide](/deploy-stack/guides/aws-credentials/).

## See also

- [Managed Database Connections](/deploy-stack/guides/database-connections/)
- [exec](/deploy-stack/cli/exec/)
- [status](/deploy-stack/cli/status/)
