---
title: sync-ai
description: Regenerate AI assistant rules for an existing project.
---

Give your AI coding assistants up-to-date deploy-stack context after project settings change, so they generate correct Terraform and deployment instructions instead of hallucinating them.

## What it does

- Prompts you to choose which AI assistants to configure, then writes the matching rule files with your project's region (from `region` in `terraform/main.tf`) and container port (from `containerPort` in `terraform/main.tf`).
- Writes a full rule file for Cursor (`.cursor/rules/deploy-stack.mdc`), Roo (`.roo/rules/deploy-stack.md`), Trae (`.trae/rules/project_rules.md`), and Continue (`.prompts/deploy-stack.prompt`); injects a managed block into the existing config for Windsurf (`.windsurfrules`), Copilot (`.github/copilot-instructions.md`), Claude (`CLAUDE.md`), Goose (`.goosehints`), and Aider (`.aider.conf.yml`).
- Exits without writing anything when no assistants are selected.
- Emits a `sync_ai_executed` telemetry event listing the selected assistants.

## Usage

```bash
npx deploy-stack sync-ai
```

## Flags

This command accepts no CLI flags. Assistant selection is interactive.

## See also

- [npx deploy-stack (init)](/cli/init/)
