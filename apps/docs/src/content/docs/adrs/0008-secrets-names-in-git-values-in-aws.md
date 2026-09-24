---
title: "Secrets Contract: Names in Git, Values in AWS"
description: "Commit secret key names to Terraform while values live only in Secrets Manager."
---

* **Status:** Accepted
* **Date:** 2026-09-24 (Retroactive)

## Context and Problem Statement

Deployed containers need environment secrets, but committing `.env` contents would leak credentials into git history, and baking values into CI configuration would spread them across logs and workflow files. At the same time, Terraform must know *which* variables exist to wire them into the ECS task definition.

We needed a split that keeps values out of version control while keeping the variable set declarative and reviewable.

## Decision Drivers

* **Zero plaintext in git:** No secret value may ever be committed, including in history-friendly JSON files.
* **Declarative wiring:** The task definition must be built from a committed, diffable source so secret rotation is a normal code review.
* **Day-2 ergonomics:** Adding a variable vs. changing a value must have obviously different, safe procedures.

## Considered Options

1. **Commit `.env` and inject at build time.** (Rejected: values enter git history permanently and leak into image layers and CI logs.)
2. **Names-only contract.** `secrets push` uploads values to the `<project>-secrets` vault and writes only key *names* to `terraform/secret_keys.json`, which is committed. Terraform maps each name into the task definition; ECS resolves values from Secrets Manager at runtime.
3. **Fully external management.** (Rejected: forces users onto out-of-band secret workflows on day one instead of the guided push/pull/audit loop.)

## Decision Outcome

**Chosen Option:** Names-only contract. Key-set changes require committing `secret_keys.json` and redeploying (the task definition is rebuilt); value-only changes take a rolling ECS restart with no redeploy.

### Positive Consequences
* `secret_keys.json` diffs in pull requests show exactly which variables were added or removed, with zero leak risk.
* `secrets pull` / `secrets audit` close the onboarding and rotation loops without ever printing values into CI.

### Negative Consequences
* Forgetting to commit `secret_keys.json` after adding a variable produces a deploy that silently lacks it — a failure mode users must learn once.
* Secret values remain invisible to code review by design, so a wrong value can only be caught at runtime.
