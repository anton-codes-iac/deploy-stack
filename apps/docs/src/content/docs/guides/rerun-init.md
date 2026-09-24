---
title: Re-running Init Safely
description: What happens when setup finds existing files — backups, regeneration, and how to recover.
sidebar:
  order: 10
---

Re-running `npx deploy-stack` to change region, size, or framework is safe and predictable: setup never merges with your existing generated files. It backs them up, regenerates from scratch, and tells you exactly what moved.

## The conflict prompt

When setup finds any of `terraform/`, `Dockerfile`, or `.github/workflows/deploy.yml` in the target directory (`src/utils/backup.js`), it lists the conflicts and offers two choices:

- **Backup & Regenerate** — each conflicting path is renamed with a timestamp suffix (e.g. `terraform.bak.1726771200000`), then fresh files are generated.
- **Cancel** — exits immediately with no changes.

In `--headless` mode there is no prompt: existing files are backed up automatically. Either way, nothing is ever merged or partially overwritten.

## Backups stay local

After backing up, setup appends a `# deploy-stack backups` block (`*.bak.*`) to `.gitignore` (creating the file if needed), so backup clutter never reaches GitHub. To recover a previous configuration, compare with `diff -r terraform.bak.<timestamp> terraform/` and copy back what you need — then delete the `.bak.*` directory when you are satisfied. (`npx deploy-stack eject` removes all `*.bak.*` files as part of decoupling.)

## What regeneration touches

`src/utils/generator.js` writes a fixed file set and handles pre-existing files explicitly:

- `terraform/*.tf`, `Dockerfile`, `.github/workflows/deploy.yml`, plus `preview.yml`/`teardown.yml` only when PR previews are enabled.
- `terraform/secret_keys.json` is reset to `[]` — re-push secrets afterward with `npx deploy-stack secrets push`.
- If your repo already has a `README.md`, it is kept and gets a short Deployment pointer appended; the generated guide goes to `DEPLOYMENT.md` instead.
- Existing `.gitignore` / `.dockerignore` files are preserved with only the deploy-stack entries appended (Terraform state paths, `.env`); missing ones are created with framework-appropriate presets.
- **Rails only:** if `ci.yml` or `dependabot.yml` exist, setup asks whether to disable them by renaming to `.bak` (default CI usually crashes without a database service); in headless mode they are disabled automatically.

## Suggested workflow

1. Commit your work before re-running, so `git status` shows exactly what regeneration changed.
2. Re-run, review the diff (`git diff`, plus `diff -r` against the `.bak` copies for untracked files like `terraform/` internals).
3. Run `npx deploy-stack apply` to converge AWS with the new configuration.
4. Delete the `.bak.<timestamp>` copies once the new infrastructure is verified.

## See also

- [apply](/deploy-stack/cli/apply/) for converging AWS after regeneration.
- [eject](/deploy-stack/cli/eject/) for what happens to backups on decoupling.
