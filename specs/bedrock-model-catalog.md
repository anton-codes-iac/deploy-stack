# Spec: Multi-Provider Bedrock Model Catalog, Interactive Selector & Day-2 Switching

## Overview
Upgrade `deploy-stack add ai:bedrock` from a single hardcoded model constant into a multi-provider model catalog and Day-2 model switcher:
1. **Bundled Multi-Provider Catalog (`src/data/bedrock-models.json`):** A structured catalog covering major Bedrock providers (Anthropic, OpenAI, DeepSeek, Meta, Amazon, Google, Mistral AI, xAI, Moonshot AI, Cohere) loaded via `fs.readFileSync` for Node 18 compatibility with a deterministic fallback catalog.
2. **Maintainer Sync Script & Optional Live Refresh (`scripts/sync-bedrock-models.js`, `--refresh`):** A maintainer script (`npm run sync:bedrock-models` with `pruneMissing: true`), an OIDC-gated weekly GitHub Actions workflow that opens/updates a PR, and an optional `--refresh` CLI flag (`pruneMissing: false`) that merges live AWS Bedrock models into `~/.deploy-stack/bedrock-models-cache.json`.
3. **Two-Step Interactive Model Selector & `--list-models` (`src/commands/add.js`):** When run interactively on a TTY without an explicit model, guide the user through a two-step Clack selector (`Provider` -> `Model`, plus `Custom model ID...`). Support `--list-models` to print the catalog offline even outside a Terraform project.
4. **Scoped Day-2 Model Switching (`src/commands/add.js`):** Allow `injectContainerEnvVars` to upsert specific opt-in keys (`upsertKeys: ['BEDROCK_MODEL_ID']`) via a 4th `options` parameter while preserving skip-existing behavior and the 3rd `taskDefinitionName` parameter for all other addons, and allow switching Bedrock models without `--force`.

---

## Part 1: Catalog Schema, Loader & Live Refresh (`src/data/bedrock-models.json`, `src/utils/bedrock-catalog.js`)

### 1. Bundled Catalog & Exact Minimal Fallback
* Define `export const FALLBACK_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-6'` in `src/utils/bedrock-catalog.js`.
* Load `src/data/bedrock-models.json` using `fs.readFileSync` and `JSON.parse` (avoiding JSON import attributes so Node 18 support is preserved).
* **Exact In-Memory Minimal Fallback Catalog (`FALLBACK_CATALOG`):** If reading or parsing `src/data/bedrock-models.json` fails or fails `isValidCatalog`, return:
  * `updatedAt: '2026-01-01'`
  * `defaultModelId: FALLBACK_BEDROCK_MODEL`
  * `providers: [{ provider: 'Anthropic', models: [{ id: FALLBACK_BEDROCK_MODEL, name: 'Claude Sonnet 4.6', hint: 'Recommended — balanced coding & reasoning', recommended: true }] }]`
* Re-export `DEFAULT_BEDROCK_MODEL` from `src/commands/add.js` set to `loadBedrockCatalog().defaultModelId || FALLBACK_BEDROCK_MODEL`.
* **Catalog JSON Schema (`src/data/bedrock-models.json`):**
  * `updatedAt`: ISO date string (`YYYY-MM-DD`, e.g., `'2026-09-27'`).
  * `defaultModelId`: `'us.anthropic.claude-sonnet-4-6'`.
  * `providers`: Ordered array of provider objects (`Anthropic`, `OpenAI`, `DeepSeek`, `Meta`, `Amazon`, `Google`, `Mistral AI`, `xAI`, `Moonshot AI`, `Cohere`), each with:
    * `provider`: Non-empty provider display name string.
    * `models`: Non-empty array of model objects, each with `id` (short Bedrock inference profile ID or foundation model ID matching `MODEL_ID_RE`, i.e., `^[a-zA-Z0-9._:-]+$`), `name` (human-readable display name, including current models such as `Claude Sonnet 5`, `Claude Sonnet 4.6`, `Claude Opus 4.7`, `Claude Haiku 4.5`, `GPT-5.5`, `DeepSeek V3.2`, `Llama 4 Maverick`, `Amazon Nova Pro`, `Gemma 4`, `Mistral Large`, `Grok 4.6`, `Kimi K3`), `hint` (concise tier/cost hint string), and optional `recommended: true`.

### 2. Cache Validation, Pagination, Normalization & Merge/Prune Semantics (`src/utils/bedrock-catalog.js`)
* **Validation Rule (`isValidCatalog(data)`):** A catalog object is valid iff it is a non-null plain object with a non-empty string `updatedAt` matching `/^\d{4}-\d{2}-\d{2}$/`, a non-empty string `defaultModelId`, and a non-empty array `providers` where every item has a non-empty string `provider` and a non-empty array `models` of objects containing non-empty string `id` and `name`.
* **Unified Provider Normalization (`normalizeProviderName(raw)`):** Route both inference profile prefixes/ARNs and foundation model `providerName` values through a single case-insensitive lookup table so duplicate groups (such as `'Mistral'` vs `'Mistral AI'`) are never created:
  * `'anthropic'` -> `'Anthropic'`
  * `'openai'` -> `'OpenAI'`
  * `'deepseek'` -> `'DeepSeek'`
  * `'meta'` -> `'Meta'`
  * `'amazon'` -> `'Amazon'`
  * `'google'` -> `'Google'`
  * `'mistral'` or `'mistral ai'` -> `'Mistral AI'`
  * `'xai'` -> `'xAI'`
  * `'moonshot'` or `'moonshot ai'` -> `'Moonshot AI'`
  * `'cohere'` -> `'Cohere'`
  * Any other non-empty string -> trimmed string (or `'Other'` if empty).
* **`loadBedrockCatalog(options = {})`:**
  * Resolve the cache path from `options.cachePath || process.env.DEPLOY_STACK_BEDROCK_CACHE_PATH || path.join(os.homedir(), '.deploy-stack', 'bedrock-models-cache.json')`.
  * When running in a test environment (`VITEST` or `NODE_ENV === 'test'`) **and** neither `options.cachePath` nor `process.env.DEPLOY_STACK_BEDROCK_CACHE_PATH` is explicitly set, skip reading the home directory cache and return the bundled catalog.
  * Otherwise, if a readable file exists at the resolved cache path, passes `isValidCatalog(cached)`, and satisfies `cached.updatedAt >= bundled.updatedAt`, return `cached`; otherwise return the bundled catalog.
* **`refreshBedrockCatalog(options = {})`:**
  * Add `@aws-sdk/client-bedrock` (`BedrockClient`, `ListInferenceProfilesCommand`, `ListFoundationModelsCommand`) to `package.json` dependencies. Accept optional `options.bedrockClient`, `options.region` (defaulting to `process.env.AWS_REGION || 'us-east-2'`), `options.cachePath`, and `options.pruneMissing = false`.
  * **Pagination:** Loop `ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', nextToken })` until `response.nextToken` is falsy so all pages of system-defined inference profiles are collected. Call `ListFoundationModelsCommand({ byInferenceType: 'ON_DEMAND' })` (and loop `nextToken` if present).
  * **Merge & Optional Prune Semantics:**
    * Start from a deep clone of the bundled catalog.
    * Collect all active live entries (`status === 'ACTIVE'` for inference profiles; `modelLifecycle?.status === 'ACTIVE'` for foundation models) whose `id` matches `^[a-zA-Z0-9._:-]+$`, normalizing each provider via `normalizeProviderName`.
    * Build a `Set` of existing model `id` strings in the clone. For any live entry whose `id` is not in the clone, append `{ id, name, hint: 'Live AWS Bedrock model' }` to the matching normalized `provider` group (creating the group if absent).
    * **Pruning (`options.pruneMissing === true`):** When `pruneMissing: true` is passed (used by the maintainer sync script) and the live AWS query returned at least one valid model, filter each provider's `models` array to retain only models present in the live `id` Set **or** equal to `merged.defaultModelId`, and drop any provider group whose `models` array becomes empty. When `pruneMissing` is `false` (default for CLI `--refresh`), never drop bundled models.
    * Set `merged.updatedAt = new Date().toISOString().slice(0, 10)`, write `merged` to the resolved cache path (creating parent directories with `recursive: true`), and return `merged`.
  * **Failure Fallback:** If the AWS SDK calls or cache write throw any error, log a non-fatal Clack `log.warn` message and return the bundled catalog without failing the command.

### 3. Maintainer Sync Script & Credentialless-Safe Weekly Workflow
* Add `scripts/sync-bedrock-models.js` (and `"sync:bedrock-models": "node scripts/sync-bedrock-models.js"` in `package.json`) that runs `refreshBedrockCatalog({ cachePath: path.resolve('src/data/bedrock-models.json'), pruneMissing: true })` using local/CI AWS credentials to update and prune the bundled file in place.
* Create `.github/workflows/sync-bedrock-models.yml` triggered on `schedule` (`0 6 * * 1`) and `workflow_dispatch`:
  * Set top-level `permissions: { id-token: write, contents: write, pull-requests: write }`.
  * When `vars.AWS_ROLE_ARN == ''`, write an informational notice to `$GITHUB_STEP_SUMMARY` and exit 0.
  * When `vars.AWS_ROLE_ARN != ''`, configure AWS credentials via `aws-actions/configure-aws-credentials@v4` (assuming `vars.AWS_ROLE_ARN` in `vars.AWS_REGION || 'us-east-2'`), run `npm ci` and `npm run sync:bedrock-models`, and publish any changes to `src/data/bedrock-models.json` via `peter-evans/create-pull-request@v7` (branch `chore/sync-bedrock-models`, commit message `chore(bedrock): sync model catalog`, title `chore(bedrock): sync AWS Bedrock model catalog`).

---

## Part 2: CLI Flags, Guard Ordering & Two-Step Interactive Selector (`src/commands/add.js`, `bin/cli.js`)

### 1. Argument Parsing (`parseAddArgs`)
* Extend `parseAddArgs(args)` in `src/commands/add.js` to parse:
  * `--list-models` -> `listModels: true` (default `false`)
  * `--refresh` -> `refresh: true` (default `false`)
  * `--headless` / `--headless=true` -> `isHeadless: true`; `--headless=false` -> `isHeadless: false` (default `false`, mirroring `--force` parsing)
* **Explicit Model Tracking:** Keep `model` defaulting to `DEFAULT_BEDROCK_MODEL` in `parseAddArgs` and return `modelProvided: true` whenever `--model <id>` or `--model=<id>` was explicitly passed in `args` (`false` otherwise).
* In `bin/cli.js`, update `HELP_TEXT` to document `--list-models` and `--refresh`.

### 2. Guard & Execution Ordering in `runAdd(options = {})`
At the very top of `runAdd(options = {})` (before defaulting `options.model`), capture:
* `const explicitModel = options.modelProvided === true || (options.model !== undefined && options.modelProvided !== false);`

Execute in this exact sequence:
1. **`UNSUPPORTED_CAPABILITY` Guard:** Verify `capability` is in `ADDON_REGISTRY`.
2. **Flag Validation Guards (`INVALID_PARTITION_KEY` / `INVALID_MODEL_ID`):**
   * Keep the existing `MODEL_ID_RE` (`^[a-zA-Z0-9._:-]+$`; short inference profile IDs and foundation model IDs only; ARNs with `/` are rejected).
   * When `capability === 'ai:bedrock'`, validate `model` with `MODEL_ID_RE` before `--refresh` / `--list-models`, so passing an invalid `--model` alongside `--list-models` immediately fails with `INVALID_MODEL_ID`.
   * When `capability !== 'ai:bedrock'`, silently ignore `--model`, `--list-models`, and `--refresh`.
3. **Optional Live Refresh (`--refresh` on `ai:bedrock`):** If `capability === 'ai:bedrock'` and `options.refresh` is true, call `await refreshBedrockCatalog({ bedrockClient: options.bedrockClient, cachePath: options.cachePath, region: options.region })` inside a Clack spinner (`Refreshing Bedrock model catalog from AWS...`) and hold the returned catalog for step 4 / step 6 (otherwise load via `loadBedrockCatalog({ cachePath: options.cachePath })`).
4. **Catalog Listing (`--list-models` on `ai:bedrock`):** If `capability === 'ai:bedrock'` and `options.listModels` is true:
   * **Viewport Exemption & Compact Format:** `--list-models` is explicitly exempt from the 14-line command viewport cap. Format the output compactly with one `log.info` line per provider (`<Provider> (<N>): <model1.id> (<model1.name>), ...`) followed by `outro`.
   * Emit `trackEvent('add_run', { projectName, capability, action: 'list_models', success: true })`, flush telemetry, and return `{ ok: true, action: 'list-models', models }` before checking for `terraform/main.tf`.
5. **`TERRAFORM_NOT_INITIALIZED` Guard:** Verify `terraform/main.tf` exists in `cwd`.
6. **Interactive Two-Step Model Selection (`ai:bedrock` only):**
   * Import and reuse `isActiveEnvValue` from `src/core/telemetry.js` to evaluate `CI` and `VITEST`.
   * Compute `const isInteractive = options.interactive ?? (!options.isHeadless && !isActiveEnvValue(process.env.CI) && !isActiveEnvValue(process.env.VITEST) && process.env.NODE_ENV !== 'test' && Boolean(process.stdout?.isTTY));`.
   * Trigger the interactive selector when `capability === 'ai:bedrock'`, `isInteractive` is `true`, and `explicitModel` is `false`.
   * **Step 1 (`select`):** Prompt the user to choose a provider from `catalog.providers` (`label: provider.provider`, `hint: provider.models.map(m => m.name).slice(0, 3).join(', ')`) or `Custom model ID...` (`value: '__custom__'`).
   * **Step 2 (`select` or `text`):**
     * If a provider was selected, prompt with a `select` of that provider's models (`label: "${m.name} (${m.id})"`, `hint: m.hint`, `value: m.id`) plus `Custom model ID...` (`value: '__custom__'`).
     * If `'__custom__'` was chosen at Step 1 or Step 2, prompt with Clack `text` for the model ID and validate the trimmed result with `MODEL_ID_RE` (`^[a-zA-Z0-9._:-]+$`). If invalid, trigger the standard `INVALID_MODEL_ID` error path.
   * **Cancellation (`isCancel`):** If the user cancels at any prompt, call `cancel('Model selection cancelled.')`, emit `trackEvent('add_run', { projectName, capability, success: false, reason: 'cancelled' })`, flush telemetry, and return `{ ok: false, reason: 'cancelled' }` without calling `process.exit(1)`.

---

## Part 3: Scoped Day-2 Model Switching & Opt-In Env Upsert (`src/commands/add.js`)

1. **Preserve 3rd Parameter (`taskDefinitionName`) & Add 4th Parameter (`options = {}`) on `injectContainerEnvVars`:**
   * Update the signature to `injectContainerEnvVars(tfContent, envEntries = [], taskDefinitionName = 'app', options = {})` (and if `typeof taskDefinitionName === 'object' && taskDefinitionName !== null`, treat it as `options` with `taskDefinitionName = options.taskDefinitionName || 'app'`).
   * This preserves full backward compatibility for `'app'` and `'worker'` callers (`injectContainerEnvVars(workerContent, envVars, 'worker', { upsertKeys })`).
   * Add `const upsertKeys = new Set(options.upsertKeys || []);`.
   * For any env var **not** in `upsertKeys` (the default for all other addons), preserve the exact existing skip-if-already-present behavior so user edits to `S3_BUCKET_NAME`, `DYNAMODB_TABLE_NAME`, `REDIS_URL`, or `SQS_QUEUE_URL` are never clobbered on `--force` and existing `injectContainerEnvVars` unit tests remain completely valid.
   * For an env var whose `name` **is** in `upsertKeys` (`upsertKeys: ['BEDROCK_MODEL_ID']` for `ai:bedrock`) and already exists in the target container's (`'app'` or `'worker'`) `environment` block, update its `value` string in place to the new `entry.value` (leaving the file text unchanged if the value is already identical).
2. **Implicit Overwrite on `ai:bedrock` Model Switch:**
   * When `terraform/bedrock.tf` already exists and `--force` is not set:
     * If `capability === 'ai:bedrock'` and the user either passed an explicit model (`explicitModel === true`) or completed the interactive selector (`selectedInteractively === true`), proceed with writing `terraform/bedrock.tf` and upserting `BEDROCK_MODEL_ID` in `terraform/main.tf` (and `terraform/worker.tf` if present, passing `'worker'` as the 3rd arg and `{ upsertKeys: ['BEDROCK_MODEL_ID'] }` as the 4th arg) without requiring `--force`.
     * Otherwise, preserve the existing `ADDON_ALREADY_EXISTS` guard.

---

## Part 4: Docs & Unit Tests (`apps/docs/`, `tests/add.test.js`)

1. **Documentation (`apps/docs/src/content/docs/cli/add.md`):**
   * Update the default Bedrock model reference to `us.anthropic.claude-sonnet-4-6`.
   * Document the interactive provider/model selector, `--list-models`, `--refresh`, Day-2 model switching, and the one-time Anthropic First Time Use (FTU) form in the AWS Bedrock console.
2. **Unit Tests (`tests/add.test.js`):**
   * Extend the `@clack/prompts` mock in `tests/add.test.js` to include `intro`, `outro`, `select`, `text`, `spinner`, `log`, `cancel`, and `isCancel`.
   * Update existing `ai:bedrock` tests that assert the old `us.anthropic.claude-sonnet-4-20250514-v1:0` default so they assert `us.anthropic.claude-sonnet-4-6`.
   * Verify existing `injectContainerEnvVars` "skips keys that already exist" tests continue to pass unchanged, and add a new test verifying `injectContainerEnvVars(content, envVars, 'worker', { upsertKeys: ['BEDROCK_MODEL_ID'] })` replaces an existing `BEDROCK_MODEL_ID` value in place in both `'app'` (`main.tf`) and `'worker'` (`worker.tf`).
   * Verify `--list-models` succeeds in an empty directory without `terraform/main.tf`, and that passing an invalid `--model` with `--list-models` fails with `INVALID_MODEL_ID`.
   * Verify `--refresh` with a mocked paginated `bedrockClient` (`nextToken`), provider normalization (`'Mistral'` -> `'Mistral AI'`), and temp `DEPLOY_STACK_BEDROCK_CACHE_PATH` merges live models without dropping bundled entries when `pruneMissing` is `false`, prunes absent entries when `pruneMissing` is `true`, and falls back cleanly to the bundled catalog when the AWS client throws.
   * Verify the two-step interactive selector (`interactive: true`) with mocked Clack `select` / `text` prompts (provider -> model selection, custom model ID path, invalid custom ID error, and prompt cancellation).
   * Verify Day-2 switching: running `add ai:bedrock` with Model A and then running `add ai:bedrock --model <Model B>` without `--force` updates `bedrock.tf`, `main.tf`, and `worker.tf` in place.