# Spec: End-to-End Cost Transparency (`addons.js`, `visualizer.js`, `init`, `add`, `apply`, & Docs)

## Overview
Resolve all cost-transparency gaps across `src/utils/addons.js`, `src/utils/visualizer.js`, `src/commands/init.js`, `src/commands/add.js`, `src/commands/apply.js`, `src/utils/generator.js`, and documentation so users always see accurate fixed-baseline vs. usage-based cost breakdowns at `init`, `add`, and `apply` time.

---

## Part 1: Shared `src/utils/addons.js` Registry & Visualizer Upgrade (`src/utils/visualizer.js`)

### 1. Extract `ADDON_REGISTRY` to `src/utils/addons.js` (No Import Cycle)
Move `ADDON_REGISTRY` into `src/utils/addons.js` (and re-export it from `src/commands/add.js` so existing imports continue to work). Extend each capability entry with `label` and `cost` metadata:
* **`'storage:s3'`:**
  * `file`: `'s3.tf'`
  * `template`: `'s3.tf'`
  * `label`: `'S3 + CloudFront OAC'`
  * `cost`:
    * `model`: `'usage-based'`
    * `monthlyFixed`: `0`
    * `summary`: `'$0/mo fixed baseline; billed per GB stored ($0.023/GB-mo), S3 PUT/GET requests, and CloudFront egress'`
* **`'db:dynamodb'`:**
  * `file`: `'dynamodb.tf'`
  * `template`: `'dynamodb.tf'`
  * `label`: `'DynamoDB (On-Demand + PITR)'`
  * `cost`:
    * `model`: `'usage-based'`
    * `monthlyFixed`: `0`
    * `summary`: `'$0/mo fixed instance baseline (VPC Gateway Endpoint is free); billed per read/write request, table storage ($0.25/GB-mo), and PITR continuous backups ($0.20/GB-mo once data is written)'`

### 2. Concrete Shape & `main.tf` CPU/Memory Parsing in `parseTerraformConfig(terraformDir)`
In `src/utils/visualizer.js`:
* Keep existing detection for `main.tf`, `hasDb` (`rds.tf` / `database.tf`), and `hasWorker` (`worker.tf`).
* **Read rendered `cpu` and `memory` from `main.tf`:** In `main.tf` (within `resource "aws_ecs_task_definition" "app"`), parse `cpu\s*=\s*"(\d+)"` and `memory\s*=\s*"(\d+)"` as integers before checking `terraform.tfvars` (allowing `terraform.tfvars` to override if present, and falling back to `256` / `512` defaults only when neither specifies them). This ensures non-micro sizes chosen at `init` are preserved during `apply` previews and README cost syncs.
* **Pure file existence for `hasSecrets`:** Set `hasSecrets = fs.existsSync(path.join(terraformDir, 'secrets.tf'))`.
* **Registry-driven `addons` array:** Iterate over `Object.entries(ADDON_REGISTRY)` and populate `config.addons` as a concrete array of capability keys whose target `.tf` file exists in `terraformDir` (e.g., `addons: ['storage:s3', 'db:dynamodb']`).

### 3. Per-Secret Billing & Return Object Shape in `estimateMonthlyCost(config)`
* Keep the existing `us-east-2` pricing table constants for Fargate, ALB (`~$22.27/mo` base + LCU), and RDS (`~$13.98/mo` compute + storage) unchanged.
* **Secrets Manager Fixed Cost (`$0.40/secret/mo`):**
  * Add `SECRETS_MANAGER_PER_SECRET = 0.40` to the pricing constants.
  * Count `secretCount = (config.hasSecrets ? 1 : 0) + (config.hasDb ? 1 : 0)` (1 for the base `secrets.tf` JSON secret, plus 1 when `hasDb` is true for RDS `manage_master_user_password = true`).
  * Compute `secretsCost = secretCount * 0.40`.
  * If any installed addon in `config.addons || []` defines `cost.monthlyFixed > 0`, add `addon.cost.monthlyFixed` to the total.
* **Preserve Object Return Shape:** Return `{ fargateMonthly, albMonthly, dbMonthly, secretsMonthly, totalMonthly }` where each value is a two-decimal numeric string (`'XX.XX'`), adding `secretsMonthly: secretsCost.toFixed(2)` alongside the existing fields.

### 4. Honest Labeling & Addon Rendering in `renderDryRunPreview(config, isDryRun = false)`
In `src/utils/visualizer.js`:
* Compute `secretCount = (config.hasSecrets ? 1 : 0) + (config.hasDb ? 1 : 0)`:
  * When `secretCount > 0`, render `[Secrets Manager (${secretCount === 1 ? '1 secret' : `${secretCount} secrets`})]` in the architecture diagram; when `secretCount === 0` (`hasSecrets === false` and `!hasDb`), omit the `[Secrets Manager]` node.
* For each capability key in `config.addons || []`, look up its `ADDON_REGISTRY[key]` entry and render `[${entry.label}]` in the architecture diagram.
* Replace the `"Est. Monthly Cost"` label with:
  `Est. Fixed Baseline: ~$${costs.totalMonthly}/mo (us-east-2 reference rates; usage, requests & data transfer billed per use)`
* In the dim parenthetical breakdown line (`Fargate: $${costs.fargateMonthly}, ALB: $${costs.albMonthly}...`), append `, Secrets: $${costs.secretsMonthly}` whenever `Number(costs.secretsMonthly) > 0`.
* When `config.addons` is non-empty, render a `Usage-Based Addons:` section directly below the baseline breakdown using `ADDON_REGISTRY[key].cost.summary`, formatted with a single space after the colon:
  ```text
  Usage-Based Addons:
    • storage:s3 (S3 + CloudFront OAC): $0/mo fixed baseline; billed per GB stored ($0.023/GB-mo), S3 PUT/GET requests, and CloudFront egress
  ```

---

## Part 2: `init.js` Contract Alignment, Cost Notice & Doc Sync (`src/commands/init.js`, `src/commands/add.js`, `src/utils/generator.js`)

### 1. Align `init.js` and `templates/README.md` on `{{ESTIMATED_COST}}`
* Export `COST_ESTIMATE_MARKER = 'Estimated Fixed Monthly Baseline:'` and `LEGACY_COST_ESTIMATE_MARKER = 'Estimated Monthly Cost:'` from `src/utils/generator.js` (or `src/utils/visualizer.js`).
* Update `templates/README.md` (line 19) so the template owns all surrounding wording and `{{ESTIMATED_COST}}` is purely the numeric string (`costs.totalMonthly`):
  `* **Estimated Fixed Monthly Baseline:** ~${{ESTIMATED_COST}}/month (us-east-2 reference rates; excludes variable traffic, ECR/CloudWatch storage, and usage-based addons)`
* Update `src/commands/init.js` (around line 110) so it computes `estimateMonthlyCost({ cpu, memory, hasDb, hasWorker, hasSecrets: true, addons: [] })` (or passes the numeric total directly) and sets `ESTIMATED_COST: costs.totalMonthly` (a plain numeric string like `'36.18'` without `~$` or `/ month (...)`).

### 2. Print Cost Impact in `runAdd`
* Whenever `deploy-stack add <capability>` succeeds, log the cost line from `ADDON_REGISTRY[capability].cost.summary` before `outro`:
  * `💰 Cost Impact: ${addon.cost.summary}`

### 3. Implement `syncDocCostEstimate(cwd)`
* Called by `runAdd` after writing the addon `.tf` file:
  * Check `DEPLOYMENT.md` first and then `README.md` in `cwd`.
  * If a file containing either `COST_ESTIMATE_MARKER` or `LEGACY_COST_ESTIMATE_MARKER` is found, recompute `parseTerraformConfig` + `estimateMonthlyCost` from `path.join(cwd, 'terraform')`, replace the marker bullet line with:
    `* **Estimated Fixed Monthly Baseline:** ~$${costs.totalMonthly}/month (us-east-2 reference rates; excludes variable traffic, ECR/CloudWatch storage, and usage-based addons)`
    and render/replace an `### Active Addons (Usage-Based)` bullet list immediately beneath the cost bullet list using `ADDON_REGISTRY[key].cost.summary` for each key in `config.addons`.
  * If neither file exists or the user deleted the cost marker, no-op gracefully without throwing.

---

## Part 3: Print-Only Preview When `autoApprove` Is True in `applyStack` (`src/commands/apply.js`)

* In `applyStack` (`src/commands/apply.js`):
  * In the `if (!autoApprove)` branch, keep `const confirmed = await renderDryRunPreview(detectedConfig, false);` and its cancellation check intact.
  * Add an `else` branch (when `autoApprove` is `true`) that calls `await renderDryRunPreview(detectedConfig, true);` so the Clack architecture/cost note box is still printed to the terminal without prompting the user for confirmation.
* Exposing new `--auto-approve` or `--headless` CLI flags on `apply` remains out of scope.

---

## Part 4: Clarify "Scale-to-Zero / Free" Wording in Templates & Docs

1. **Template Comments (`templates/terraform/addons/s3.tf` & `dynamodb.tf`):**
   * State clearly that the **VPC Gateway Endpoint** has no hourly/data-processing charge, while DynamoDB table storage (`$0.25/GB-mo`), read/write requests, and PITR continuous backups (`$0.20/GB-mo` once data is written) and S3 storage/requests/CloudFront transfer are usage-billed.
2. **CLI Add Reference (`apps/docs/src/content/docs/cli/add.md`):**
   * Replace unqualified "scale-to-zero" claims with "no fixed hourly instance cost (usage-billed)" and include a `## Cost & Billing Drivers` section summarizing the billing model for `storage:s3` and `db:dynamodb`.
3. **PR Preview Guide (`apps/docs/src/content/docs/guides/ephemeral-pr-previews.md`):**
   * Update the cost section (~line 30) to note that because `add` resources use `${local.app_name}`, each open PR preview workspace provisions its own isolated S3 bucket and/or DynamoDB table—accruing usage-based storage/request/PITR charges until the PR closes and the workspace is destroyed (whereas Secrets Manager secrets are shared via `data` source at no extra per-PR secret cost).

---

## Part 5: Unit Tests (`tests/visualizer.test.js`, `tests/add.test.js`, `tests/apply.test.js`, `tests/generator.test.js`)

1. **`tests/visualizer.test.js`:**
   * `parseTerraformConfig` extracts rendered `cpu` and `memory` from `main.tf` (and lets `terraform.tfvars` override if present), checks pure `secrets.tf` existence (`hasSecrets: true/false`), and populates `addons: ['storage:s3', 'db:dynamodb']` from `ADDON_REGISTRY`.
   * `estimateMonthlyCost` returns `{ fargateMonthly, albMonthly, dbMonthly, secretsMonthly, totalMonthly }` with `secretsMonthly: '0.40'` (`hasSecrets: true, hasDb: false`), `'0.80'` (`hasSecrets: true, hasDb: true`), and `'0.00'` (`hasSecrets: false, hasDb: false`).
   * `renderDryRunPreview` includes `Est. Fixed Baseline`, `, Secrets: $0.40` (or `$0.80`, and omits `[Secrets Manager]` when `0` secrets), and renders active addons' `[label]` and `Usage-Based Addons:` bullets (`• <key> (<label>): <summary>`).
   * Assert that `templates/README.md` literally contains `COST_ESTIMATE_MARKER` so the template and JS constant cannot drift.
2. **`tests/add.test.js`:**
   * `runAdd` prints `💰 Cost Impact:` with the registry summary.
   * `syncDocCostEstimate` updates the cost baseline (preserving non-default CPU/memory from `main.tf`) and `### Active Addons (Usage-Based)` section in `README.md` or `DEPLOYMENT.md` (matching both `COST_ESTIMATE_MARKER` and `LEGACY_COST_ESTIMATE_MARKER`), and gracefully no-ops when no marker is present.
3. **`tests/apply.test.js` & `tests/generator.test.js`:**
   * `applyStack` with `autoApprove: true` calls `await renderDryRunPreview(detectedConfig, true)` (print-only mode) before executing Terraform.
   * Update `ESTIMATED_COST` fixtures in `tests/generator.test.js` (e.g., `'30.00'` instead of `'~$30'`) and update snapshots to match the new `templates/README.md` cost wording.