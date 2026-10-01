# Specification: E2E Lifecycle Testing Harness

## 1. Overview
Implement a deterministic, two-tiered End-to-End (E2E) testing harness that executes the actual `bin/cli.js` entrypoint via `child_process`.
This spec includes a "Phase 0" to wire minimal headless bypasses into the CLI so automated lifecycle commands do not hang on interactive prompts.

## 2. Boundaries & Constraints
- **ISOLATION:** The main unit test suite must remain blazing fast. You MUST add `exclude: ['tests/e2e/**']` to the root `vitest.config.js`.
- **NO UNIT MOCKS:** The E2E harness must execute the real binary against the real filesystem.
- **HEADLESS PURITY:** All E2E `execFileSync` calls must use `stdio: ['ignore', 'inherit', 'inherit']` (closing stdin). If a command attempts to prompt, it must crash loudly rather than hanging the test.
- **ENVIRONMENT:** All E2E tests must run with `DO_NOT_TRACK=1` and `TF_PLUGIN_CACHE_DIR`. Tier 0 explicitly sets `CI_MOCK_AWS=true`. Tier 1 explicitly requires real AWS credentials and does NOT set the mock flag.

## 3. Phase 0: Minimal Headless Wiring (Production)
Do not write new flag parsers; `--headless` is already parsed globally as `isHeadless` in `bin/cli.js`. Implement a shared bypass helper (e.g., using `resolveHeadless()`) to handle the `--headless`, `--auto-approve`, and `--yes` precedence seamlessly:
- **Apply:** Bypass the `renderDryRunPreview` confirm prompt AND the `NoSuchBucket` recovery prompt if `--auto-approve` or `--headless` is true.
- **Destroy:** Bypass both confirm prompts if `--yes` or `--headless` is true.
- **Eject:** Bypass the confirm prompt if `--yes` or `--headless` is true.

## 4. Phase 1: Tier 0 E2E (Fast, PR-Friendly, Mock AWS)
Create `tests/e2e/tier0.e2e.test.js` and `vitest.e2e.tier0.config.js` (with a `300s` test timeout). Add `"test:e2e:tier0": "vitest run -c vitest.e2e.tier0.config.js"` to `package.json`. Ensure `CI_MOCK_AWS=true` is set.
**Targets:**
1. **ECS Scaffold:** In a single shared tmpdir, run `node bin/cli.js init --target ecs --headless` -> `node bin/cli.js add queue:sqs --headless`.
   - *Assertions:* Exit 0. Verify `README.md` (the primary doc destination), `main.tf`, and addon files exist. Run `terraform init -backend=false && terraform validate`.
1b. **Addon Matrix:** For each remaining capability (`storage:s3`, `db:dynamodb`, `db:redis`, `ai:bedrock`, `email:ses` with `--domain example.com`, `cron`): fresh tmpdir, `init --target ecs --headless`, `add <capability> --headless`, assert exit 0 and the capability `.tf` file exists, then init + validate. Plus one `init --target ecs --with queue:sqs,db:redis --headless` composition asserting both `.tf` files exist, then init + validate.
2. **Lambda Scaffold:** `node bin/cli.js init --target lambda --headless`.
   - *Assertions:* Exit 0. Validate Terraform.
3. **Local Checks:** 
   - `eject --headless`: In a *fresh* isolated tmpdir, run `init` first, then run `eject`. Behaviorally verify metadata is stripped from files.
   - `doctor`: Assert exit 0.
4. **Failure Paths (Contract Pinning):** 
   - `apply --headless` outside a project directory.
   - `init --target fake-target`.
   - *Assertions:* Must exit 1 cleanly with expected error shape (no stack traces).

## 5. Phase 2: Tier 1 E2E (Real AWS, Nightly/Manual)
Create `tests/e2e/tier1.live.e2e.test.js` and `vitest.e2e.tier1.config.js` (with a `15+` minute timeout). Add `"test:e2e:tier1": "vitest run -c vitest.e2e.tier1.config.js"`.
- **Skip Logic:** Use `test.skipIf(!process.env.AWS_ACCESS_KEY_ID)` so this suite gracefully skips if run locally without credentials.
- **The Lifecycle:** Run `init --target ecs --headless` -> `apply --auto-approve` -> `status` -> `destroy --yes` in sequence.
- **Assertions:** Exit code 0 for all steps. *Critical:* For `status`, implement a retry-until-healthy loop (e.g., check every 15s for up to 3 mins) since ECS tasks take time to boot after `apply`. Post-destroy, assert the state bucket was successfully deleted.

## 6. GitHub Actions Integration
Create `.github/workflows/e2e.yml`:
- **Job 1 (Tier 0):** Runs on `pull_request` and `push`. Steps: checkout, setup-node (v24), `npm ci`, `hashicorp/setup-terraform`, and `npm run test:e2e:tier0`. Upload the workspace as an artifact on failure.
- **Job 2 (Tier 1 Live):** Runs on `workflow_dispatch` and a nightly `schedule` (`cron: '0 2 * * *'`). Steps: checkout, setup-node, `npm ci`, setup-terraform. Configure AWS credentials using `aws-actions/configure-aws-credentials@v4` with `role-to-assume: ${{ vars.AWS_ROLE_ARN }}` (the role must have broad deploy permissions). Execute `npm run test:e2e:tier1`. Upload the workspace as an artifact on failure.

## 7. Acceptance Criteria
1. The standard unit test suite has the same count and status as the baseline (1,068 total; only the known loopback failure), with E2E files correctly excluded from the default run.
2. Tier 0 runs green locally and in PRs.
3. Tier 1 passes against real AWS (or correctly skips if `AWS_ACCESS_KEY_ID` is absent).
4. The Phase 0 bypass flags (`--headless`, `--auto-approve`, `--yes`) function correctly when invoked from a real terminal.