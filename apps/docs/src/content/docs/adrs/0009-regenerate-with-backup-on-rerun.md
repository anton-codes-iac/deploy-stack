---
title: "Regenerate from Scratch with Backup on Re-Run"
description: "Re-running init backs up generated files and regenerates instead of merging."
---

* **Status:** Accepted
* **Date:** 2026-09-24 (Retroactive)

## Context and Problem Statement

Users re-run `npx deploy-stack` to change region, size, or framework — but by then the target directory contains previously generated `terraform/`, `Dockerfile`, and workflow files, possibly hand-edited. Merging new output into edited files risks silent half-applied configurations that are worse than either version.

We needed re-runs to be safe, predictable, and recoverable.

## Decision Drivers

* **Predictability:** Post-run state must equal what generation produces for the new inputs — no merge ghosts.
* **Recoverability:** Hand edits and previous outputs must never be destroyed without a way back.
* **Explicitness:** The user must always know exactly what moved and what to do next.

## Considered Options

1. **Three-way merge with user files.** (Rejected: generated IaC has no stable merge grammar; conflicts would be resolved by guessing.)
2. **Refuse to overwrite.** (Rejected: makes legitimate reconfiguration (region, size, framework) a manual file-deletion chore.)
3. **Backup and regenerate.** On conflict (`src/utils/backup.js`), offer Backup & Regenerate: move existing outputs to `.bak` files (additionally git-ignored so clutter never reaches GitHub), regenerate from scratch, and print the exact next steps.

## Decision Outcome

**Chosen Option:** Backup and regenerate. Setup never merges; it backs up, regenerates, and reports.

### Positive Consequences
* Re-runs are idempotent in effect: same inputs always yield the same tree.
* No user file is ever destroyed; recovery is a file copy away.

### Negative Consequences
* Hand edits to generated files are silently forked into `.bak` copies the user must reconcile manually.
* Repeated re-runs accumulate `.bak` clutter locally (mitigated by git-ignoring the pattern).
