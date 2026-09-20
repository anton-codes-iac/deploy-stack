---
title: doctor
description: Check that required tools are installed before provisioning.
---

Verify your machine is ready to provision and deploy, telling you exactly which dependency to install when something is missing.

## What it does

- Checks for the four required binaries — `terraform`, `aws` (AWS CLI), `docker`, and `git` — and prints a pass/fail line for each with a Homebrew install hint for anything missing.
- Makes no changes to your project or cloud resources; it is a read-only check.
- Prints a success message when everything is present, or a reminder to install the missing dependencies first.
- Emits a `doctor_run` telemetry event recording whether all checks passed.

## Usage

```bash
npx deploy-stack doctor
```

## Flags

This command accepts no CLI flags.

## See also

- [npx deploy-stack (init)](/cli/init/)
- [apply](/cli/apply/)
