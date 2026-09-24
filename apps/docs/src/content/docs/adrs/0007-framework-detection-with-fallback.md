---
title: "Framework Auto-Detection with Graceful Fallback"
description: "Detect the framework from repo signals and fall back to static instead of failing."
---

* **Status:** Accepted
* **Date:** 2026-09-24 (Retroactive)

## Context and Problem Statement

Setup must preselect the right framework preset without interrogating the user about files they may not understand — but repository signals are unreliable: `package.json` may be malformed, `vercel.json` may be empty, and unknown stacks must still produce a working project.

We needed detection rules that are helpful when signals exist and harmless when they do not.

## Decision Drivers

* **Never block generation:** A strange repo must still scaffold; a wrong guess the user can override beats a fatal error.
* **Deterministic precedence:** Overlapping signals (e.g. `express` inside a NestJS app) must resolve the same way every run.
* **Advance warning:** Framework-specific runtime requirements (bind address, build output, adapter) should surface before infrastructure exists, not after the first 502.

## Considered Options

1. **Interactive-only selection.** (Rejected: slow, and headless/CI generation needs a non-interactive path.)
2. **Strict detection, fail on ambiguity.** (Rejected: malformed or partial configs would block scaffolding entirely.)
3. **Precedence-ordered detection with silent ignore + static fallback.** Checks run top-down (`src/utils/detector.js`); malformed configs are treated as absent, never fatal; anything unmatched falls back to `static`. Post-detection checks (`src/utils/warnings.js`) flag fixable issues with copy-paste remedies.

## Decision Outcome

**Chosen Option:** Precedence-ordered detection with graceful fallback. Both `dependencies` and `devDependencies` are searched; empty or malformed signal files are ignored; headless mode without `--framework` resolves the same way.

### Positive Consequences
* `npx deploy-stack` succeeds on repos the tool has never seen, producing a deployable static project the user can refine.
* Warnings arrive with exact fixes at setup time, when they are cheapest to apply.

### Negative Consequences
* A wrong-but-plausible guess (e.g. Express detected inside a larger framework) silently generates the wrong preset until the user notices.
* Detection rules must be maintained alongside the ecosystem or they rot into misdetection.
