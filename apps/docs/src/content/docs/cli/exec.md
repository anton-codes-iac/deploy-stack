---
title: exec
description: Open an interactive shell inside your running ECS container.
---

Drop into a secure shell inside your live Fargate container to inspect files, check environment variables, or debug a running app — without opening the AWS console.

## What it does

- Finds a running container for the current project automatically and opens an interactive shell (`/bin/sh` by default) via ECS Exec.
- Resolves its inputs automatically: cluster (`<project-name>-cluster`, overridable via `ECS_CLUSTER`), service (`<project-name>-service`, overridable via `ECS_SERVICE`), container (`<project-name>-container`, overridable via `ECS_CONTAINER`), and region (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`).
- Checks that the AWS CLI is installed first; if missing, prints install links and exits 1 instead of failing cryptically.
- Checks that the Session Manager plugin is installed next; if missing, prints install instructions for your OS (`brew install session-manager-plugin` on Mac, download links on Windows/Linux) and exits 1.
- When no containers are running (e.g. scaled to zero or still booting), explains that a running container is required, points you to `status` and `apply`, and exits 1.
- On expired AWS credentials, points you to `aws sso login` / `aws configure` and exits 1 instead of throwing.
- Emits an `exec_run` telemetry event recording success and outcome.

## Usage

```bash
npx deploy-stack exec
npx deploy-stack exec --command /bin/bash
npx deploy-stack exec --service myapp-service --container myapp-container
```

Type `exit` to leave the shell.

## Flags

| Flag | Description |
| ---- | ----------- |
| `[service]` | Service to connect to. Defaults to the project service. |
| `--service <name>` | Explicit service name override. |
| `--cluster <name>` | Explicit cluster name override. |
| `--container <name>` | Explicit container name override. |
| `--command <cmd>` | Shell to open (default `/bin/sh`). |
| `--region <region>` | Explicit AWS region override. |

## Prerequisites

- Run `npx deploy-stack apply` first: ECS Exec access (`enable_execute_command` plus the container's session permissions) is provisioned with your infrastructure. If the connection is refused on an older deployment, re-run `apply` to enable it.
- Install the AWS CLI and the Session Manager plugin (`brew install session-manager-plugin` on Mac; the command prints the right instructions for your OS when it's missing). On expired credentials, refresh with `aws sso login` or `aws configure`. See the [AWS credentials guide](/deploy-stack/guides/aws-credentials/).

## See also

- [status](/deploy-stack/cli/status/)
- [logs](/deploy-stack/cli/logs/)
- [diagnose](/deploy-stack/cli/diagnose/)
