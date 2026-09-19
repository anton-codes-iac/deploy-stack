# deploy-stack Testing Strategy

To ensure zero regressions in infrastructure generation and safe local execution, `deploy-stack` relies on a multi-layered testing strategy split between fast local snapshots and rigid CI/CD validation.

## 1. Unit & Argument Testing
We use pure Node.js unit tests (via Vitest) to validate the CLI argument parser (`src/core/parser.js`). This ensures that flags (like `--headless` or `--no-telemetry`) are routed correctly and never hijack positional arguments like file paths.

## 1.5. Ecosystem Integration Contracts
Because `deploy-stack` acts as the underlying engine for ecosystem wrappers (e.g., `nest-deploy-stack`, `cookiecutter-fastapi`), we strictly test execution flags that bypass interactive prompts:
* **Headless Validation:** Vitest specifically asserts that when `--headless` and `--preconfigured` are passed, the CLI never initializes the `inquirer` prompt module and never throws interactive warnings. This guarantees stability for automated ecosystem integrations.

## 2. Infrastructure Snapshot Harness (The Static Contract)
Because `deploy-stack` generates highly dynamic Terraform (`.tf`), GitHub Actions (`.yml`), and `Dockerfile` configurations, we use **Vitest Snapshots** to lock in the expected text outputs. 
* **The Matrix:** The test suite generates dummy projects across 11 architectural topologies (including Django, Rails, Go, Nuxt, Next.js, SvelteKit, and Vercel/Heroku migrations).
* **Negative Testing:** The suite explicitly checks for the *absence* of files (e.g., ensuring `database.tf` or `worker.tf` are not generated for static sites).
* **Updating Snapshots:** If a template change is intentional, developers must run `npm run test:update` to overwrite the baseline `__snapshots__`.

## 3. External API Mocking
To ensure tests run sub-second and deterministically without requiring real AWS credentials, we intercept network boundaries:
* **AWS Secrets Manager:** `tests/secrets.test.js` uses Vitest's `vi.hoisted()` and `vi.mock()` to intercept `@aws-sdk/client-secrets-manager`. This verifies the CLI correctly formats payloads and handles network exceptions (like `ResourceNotFoundException`) completely offline.
* **Telemetry:** PostHog tracking is mocked to prevent test executions from polluting production analytics.

## 4. Continuous Integration & Execution Validation (CI)
While Vitest proves the CLI generates the *correct* files, GitHub Actions proves those files *actually work*. Unit and snapshot tests are gated via `.github/workflows/test.yml`; live template compilation is gated via `.github/workflows/iac-validation.yml`.
* **Phase 1 (Generation):** Vitest runs unit and snapshot tests to verify the CLI contract.
* **Phase 2 (Static Application Security Testing - SAST):** CI runs `trivy config` against the generated `Dockerfile` and Terraform snapshots to guarantee they remain compliant with strict security policies.
* **Phase 3 (IaC Validation):** The `iac-validation` matrix workflow scaffolds all 10 supported frameworks headlessly (`--headless --preconfigured`), then runs `terraform init -backend=false` + `terraform validate`, `tflint`, and a Trivy filesystem scan (fails on HIGH/CRITICAL) — fully offline with no AWS credentials.