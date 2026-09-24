---
title: eject
description: Decouple your project from deploy-stack into vanilla Terraform.
---

Take permanent, sole ownership of your infrastructure files when you no longer want the CLI managing them, while keeping everything running in AWS.

## What it does

- Asks for explicit confirmation (defaulting to "No"); declining cancels with no changes.
- Strips deploy-stack metadata from your local files: removes the `# deploy-stack generated infrastructure` header and the `default_tags { tags = { ManagedBy = "deploy-stack" } }` block from `terraform/main.tf`, and removes the `# deploy-stack backups` block from `.gitignore`.
- Recursively deletes every `*.bak.*` backup file in the project (skipping `node_modules` and `.git`).
- Leaves your infrastructure fully operational as raw, standalone Terraform. As a final step, run `terraform apply` inside `terraform/` so AWS syncs state and removes the live `ManagedBy` tags.
- Emits a `project_ejected` telemetry event. This cannot be undone.

## Usage

```bash
npx deploy-stack eject
```

## Flags

This command accepts no CLI flags. The confirmation prompt is interactive.

## See also

- [apply](/deploy-stack/cli/apply/)
- [destroy](/deploy-stack/cli/destroy/)
