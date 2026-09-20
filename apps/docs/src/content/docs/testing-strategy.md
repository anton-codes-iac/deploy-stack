---
title: Testing Strategy
description: How deploy-stack prevents regressions — unit tests, snapshot harness, API mocking, and CI validation.
---

To ensure zero regressions in infrastructure generation and safe local execution, `deploy-stack` relies on a multi-layered testing strategy split between fast local snapshots and rigid CI/CD validation.

## 1. Unit & argument testing
We use pure Node.js unit tests (via Vitest) to validate the CLI argument parser (`src/core/parser.js`). This ensures that flags (like `--headless` or `--no-telemetry`) are routed correctly and never hijack positional arguments like file paths.

## 1.5. Ecosystem integration contracts
Because `deploy-stack` acts as the underlying engine for ecosystem wrappers (e.g., `nest-deploy-stack`, `cookiecutter-fastapi`), we strictly test execution flags that bypass interactive prompts:
* **Headless Validation:** Vitest specifically asserts that when `--headless` and `--preconfigured` are passed, the CLI never initializes the `inquirer` prompt module and never throws interactive warnings. This guarantees stability for automated ecosystem integrations.

## 2. Infrastructure snapshot harness (the static contract)
Because `deploy-stack` generates highly dynamic Terraform (`.tf`), GitHub Actions (`.yml`), and `Dockerfile` configurations, we use **Vitest Snapshots** to lock in the expected text outputs.
* **The Matrix:** The test suite generates dummy projects across 11 architectural topologies (including Django, Rails, Go, Nuxt, Next.js, SvelteKit, and Vercel/Heroku migrations).
* **Negative Testing:** The suite explicitly checks for the *absence* of files (e.g., ensuring `database.tf` or `worker.tf` are not generated for static sites).
* **Updating Snapshots:** If a template change is intentional, developers must run `npm run test:update` to overwrite the baseline `__snapshots__`.

## 3. External API mocking
To ensure tests run sub-second and deterministically without requiring real AWS credentials, we intercept network boundaries:
* **AWS Secrets Manager:** `tests/secrets.test.js` uses Vitest's `vi.hoisted()` and `vi.mock()` to intercept `@aws-sdk/client-secrets-manager`. This verifies the CLI correctly formats payloads and handles network exceptions (like `ResourceNotFoundException`) completely offline.
* **Telemetry:** PostHog tracking is mocked to prevent test executions from polluting production analytics.

## 4. Continuous integration & execution validation (CI)
While Vitest proves the CLI generates the *correct* files, GitHub Actions proves those files *actually work*. Unit and snapshot tests are gated via `.github/workflows/test.yml`; live template compilation is gated via `.github/workflows/iac-validation.yml`.
* **Phase 1 (Generation):** Vitest runs unit and snapshot tests to verify the CLI contract.
* **Phase 2 (Static Application Security Testing - SAST):** CI runs a pinned Trivy filesystem scan (`aquasecurity/trivy-action` by SHA) against each generated project directory, writing advisory `trivy-fs-results.txt` reports (`HIGH,CRITICAL`, `exit-code: 0`) instead of failing the build.
* **Phase 3 (IaC Validation):** The `iac-validation` matrix workflow scaffolds all 10 supported frameworks headlessly (`--headless --preconfigured`), then runs `terraform init -backend=false` + `terraform validate`, `tflint`, the advisory filesystem scan, a stripped-Dockerfile `docker build`, and an advisory container-image scan (`trivy-image-results.txt`).
* **Phase 4 (Release gate):** `.github/workflows/publish.yml` reuses `iac-validation.yml` via `workflow_call` as a `validate` job; `build-and-publish` has `needs: [validate]`, so NPM publishing on release is blocked until the full matrix passes.
