# Spec: Dependency-Aware Smart `init` & Multi-Capability Composition

## Overview
Upgrade `deploy-stack init` (`mainStack` in `src/commands/init.js`) from a framework-only scaffolder into a dependency-aware stack composer that inspects project manifests, local Docker Compose topologies, and environment variable templates to pre-select infrastructure capabilities and scaffold Day-0 + Day-2 addons in a single pass—while keeping `init --headless` deterministic when `--with` is omitted.

### Core Principles
1. **Zero Duplicate Template Logic:** `src/commands/init.js` must never duplicate HCL manipulation or addon rendering. Extract a quiet `scaffoldAddon()` helper in `src/commands/add.js` (paired with the existing `resolveAddonOptions`) and reuse `injectMigrationGate` from `src/commands/db/migrate.js`.
2. **Evidence-Based Pre-Selection:** Every pre-checked option in interactive mode displays the exact manifest or file signal that triggered it (`detected: ioredis, docker-compose redis`).
3. **Deterministic Headless Mode:** Running `deploy-stack init --headless` without `--with` preserves existing behavior and stdout (no surprise addon `.tf` files). Passing `--with <cap1,cap2,...>` explicitly scaffolds the requested addons in headless or interactive mode.
4. **Fail-Fast Validation Before Side Effects:** All `--with` and addon-flag validations run immediately after target directory resolution—before interactive prompts, AWS state-bucket provisioning, or `handleExistingFiles` backup creation.

---

## Part 1: Project Capability Scanner (`src/utils/capabilities.js` & `src/utils/detector.js`)

### 1. New Module Placement & Export
Create `src/utils/capabilities.js` exporting `detectProjectCapabilities(cwd)` and re-export it from `src/utils/detector.js`.

### 2. Return Shape
* `relationalDb`: `{ detected: boolean, evidence: string[] }` (PostgreSQL-compatible RDS signals only)
* `worker`: `{ detected: boolean, suggestedCommand: string | null, evidence: string[] }`
* `migration`: `{ detected: boolean, command: string | null }` (delegates to `detectMigrationCommand(cwd)` from `src/commands/db/migrate.js`)
* `addons`: Map keyed by `ADDON_REGISTRY` capability ID (`db:redis`, `queue:sqs`, `storage:s3`, `db:dynamodb`, `ai:bedrock`, `email:ses`), each `{ detected: boolean, evidence: string[] }`
* `upcomingHints`: `{ vector: boolean, cron: boolean, mysql: boolean }`

### 3. Manifest & Config Scanning Rules (Read-Only, Fault-Tolerant, Tokenized)
Wrap all file reads in `try/catch` (reusing `readFileSafe` where helpful) so malformed files never crash `init`.
* **Tokenized Matching (No Substring Hazards):**
  * `package.json`: match exact keys in merged `dependencies`, `devDependencies`, and `peerDependencies`.
  * `requirements.txt`, `pyproject.toml`, `Pipfile`: extract normalized package names per line/entry via regex (`^[a-zA-Z0-9._-]+`, lowercased, with `_` normalized to `-` for comparison) without adding a TOML dependency.
  * `go.mod`: match exact module paths per line.
  * `Gemfile`: match exact gem names via `/^\s*gem\s+['"]([^'"]+)['"]/m`.
* **Environment Template Keys Only:** Scan `.env.example`, `.env.sample`, `.env.template`, and `.env` strictly for **variable key names** (`^[A-Z0-9_]+(?==)`). Never read, parse, or log variable values.
* **Docker Compose (`src/utils/dockerCompose.js`):** Extend `parseDockerCompose` additively to check `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, and `compose.yaml`.
* **Signal Matrix:**
  1. **`relationalDb` (PostgreSQL RDS Pre-Select):**
     * Node: `pg`, `postgres`, `typeorm`, `sequelize`, `knex`, `mikro-orm`, `drizzle-orm`, `drizzle-kit`, `@prisma/client`, `prisma` (unless `prisma/schema.prisma` explicitly specifies `provider = "mysql"`, `"sqlite"`, or `"mongodb"`).
     * Python: `psycopg2`, `psycopg2-binary`, `psycopg`, `asyncpg`, `sqlalchemy`, `sqlmodel`, `alembic`, `django`.
     * Go: `github.com/lib/pq`, `github.com/jackc/pgx`, `gorm.io/driver/postgres`.
     * Ruby: `pg`, `rails`.
     * Files / Compose / Env Keys: `drizzle.config.ts|js|mjs`, `alembic.ini`, `manage.py`, `bin/rails`, `prisma/schema.prisma` with `provider = "postgresql" | "postgres" | "cockroachdb"`, Docker Compose `postgres` / `postgis/postgis` image, or env keys `DATABASE_URL`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `PGHOST`.
  2. **MySQL Signals (`upcomingHints.mysql` Only — Never Pre-Select PostgreSQL RDS):**
     * Node: `mysql2`, `mysql`; Python: `pymysql`, `mysqlclient`, `aiomysql`; Go: `github.com/go-sql-driver/mysql`, `gorm.io/driver/mysql`; Ruby: `mysql2`; `prisma/schema.prisma` with `provider = "mysql"`; Docker Compose `mysql` / `mariadb` image; env keys `MYSQL_URL`, `MYSQL_HOST`.
     * When only MySQL signals are present (and no PostgreSQL signals), set `relationalDb.detected = false` and `upcomingHints.mysql = true`. If both PostgreSQL and MySQL signals are present, both `relationalDb.detected` and `upcomingHints.mysql` are `true`.
  3. **`db:redis`:**
     * Node: `ioredis`, `redis`, `@upstash/redis`, `bull`, `bullmq`; Python: `redis`, `aioredis`, `rq`, or `celery` + `redis` co-presence; Go: `github.com/redis/go-redis`, `github.com/gomodule/redigo`; Ruby: `redis`, `sidekiq`, `connection_pool`.
     * Compose: `redis`, `valkey/valkey`, `bitnami/redis`, `redis/redis-stack`.
     * Env keys: `REDIS_URL`, `VALKEY_URL`, `REDIS_HOST`, `CELERY_BROKER_URL`.
  4. **`queue:sqs`:**
     * Node: `@aws-sdk/client-sqs`, `sqs-consumer`; Python: `kombu` or env key; Go: `github.com/aws/aws-sdk-go-v2/service/sqs`; Ruby: `aws-sdk-sqs`, `shoryuken`.
     * Compose: `localstack/localstack` (with `sqs` in `SERVICES` if present) or `roribio16/alpine-sqs`.
     * Env keys: `SQS_QUEUE_URL`, `SQS_DLQ_URL`, `AWS_SQS_QUEUE_URL`.
  5. **`storage:s3`:**
     * Node: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `multer-s3`; Python: `django-storages`, `s3fs`; Go: `github.com/aws/aws-sdk-go-v2/service/s3`; Ruby: `aws-sdk-s3`, `shrine`, `carrierwave`.
     * Compose: `minio/minio`.
     * Env keys: `S3_BUCKET_NAME`, `S3_BUCKET`, `AWS_S3_BUCKET`, `S3_CDN_URL`.
  6. **`db:dynamodb`:**
     * Node: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `dynamoose`; Python: `pynamodb`, `aioboto3`; Go: `github.com/aws/aws-sdk-go-v2/service/dynamodb`; Ruby: `aws-sdk-dynamodb`.
     * Compose: `amazon/dynamodb-local`.
     * Env keys: `DYNAMODB_TABLE_NAME`, `DYNAMODB_TABLE`.
  7. **`ai:bedrock`:**
     * Node: `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-bedrock`, `@ai-sdk/amazon-bedrock`, `@langchain/aws`; Python: `langchain-aws`; Go: `github.com/aws/aws-sdk-go-v2/service/bedrockruntime`; Ruby: `aws-sdk-bedrockruntime`.
     * Env keys: `BEDROCK_MODEL_ID`, `AWS_BEDROCK_MODEL_ID`.
  8. **`email:ses`:**
     * Node: `@aws-sdk/client-ses`, `@aws-sdk/client-sesv2`; Python: `django-ses`; Go: `github.com/aws/aws-sdk-go-v2/service/ses`, `github.com/aws/aws-sdk-go-v2/service/sesv2`; Ruby: `aws-sdk-ses`, `aws-sdk-sesv2`.
     * Env keys: `SES_FROM_EMAIL`, `SES_REGION`, `AWS_SES_REGION`.
  9. **`worker`:**
     * `package.json` scripts containing `worker`, `queue:work`, or `bull` -> `suggestedCommand: "npm run <script>"`; Node `bullmq`/`bull`/`sqs-consumer`; Python `celery`/`rq`/`dramatiq`; Ruby `sidekiq`/`shoryuken`/`good_job`; or non-web worker service in `Procfile` / Docker Compose.
  10. **`upcomingHints.vector` & `upcomingHints.cron`:**
      * `vector`: `pgvector` package (Node/Python/Ruby/Go), `prisma/schema.prisma` containing `vector`, or `ankane/pgvector` / `pgvector/pgvector` image in Docker Compose.
      * `cron`: `node-cron`, `cron`, `agenda`, `APScheduler`, `celery-beat`, `robfig/cron`, `whenever`, `sidekiq-cron`, `sidekiq-scheduler`, or a non-empty `crons` array in `vercel.json`.
* **Evidence Formatting:** Format every evidence entry concisely as `<item>` (e.g., `'ioredis'`, `'docker-compose redis'`, `'REDIS_URL'`), deduplicated per capability and rendered in prompt hints as `detected: <item1>, <item2>`.

---

## Part 2: CLI Parser, `projectName` Sanitization & Fail-Fast Validation

### 1. `sanitizeProjectName` in `src/utils/prompts.js`
* Export `sanitizeProjectName(rawName)`:
  * Coerce to string, trim, lowercase, replace any sequence of characters outside `[a-z0-9-]` (including dots `.` and underscores `_`) with a single hyphen `-`, strip leading and trailing hyphens, and fall back to `'app'` if the result is empty.
* In `getTargetDirectory` (`src/utils/prompts.js`), apply `sanitizeProjectName` to `actualProjectName` (never to `targetDir`). If the sanitized name differs from the raw basename/input, log a dim note (`Project name sanitized to "<actualProjectName>" for AWS resource compatibility.`).

### 2. Parser & Entry-Point Plumbing (`src/utils/parser.js`, `bin/cli.js`, `src/commands/init.js`)
* In `parseCliArgs` (`src/utils/parser.js`):
  * Extract `isPreconfigured: args.includes('--preconfigured')`.
  * Always populate an `initOptions` object (in both interactive and headless modes):
    * `with`: array of capability strings parsed from all `--with <csv>` and `--with=<csv>` occurrences, split on commas, trimmed, filtered for non-empty strings, and deduplicated in order.
    * `model`: string or `null` (`--model` / `--model=`).
    * `domain`: string or `null` (`--domain` / `--domain=`).
    * `zoneId`: string or `null` (`--zone-id` / `--zone-id=`).
    * `fromEmail`: string or `null` (`--from-email` / `--from-email=`).
    * `setupCiMigrate`: boolean (`args.includes('--setup-ci-migrate')`).
* In `bin/cli.js` and `mainStack` (`src/commands/init.js`):
  * Pass `{ isHeadless, isPreconfigured, headlessOptions, initOptions }` into `mainStack`. Keep the function name `mainStack` unchanged.

### 3. Up-Front Validation (Before Prompts, AWS Calls, or File Backups)
Immediately after `getTargetDirectory` in `mainStack`:
1. If `initOptions.with.length > 0`:
   * Verify every entry exists in `ADDON_REGISTRY`. If any entry is unknown, fail immediately with `reason: 'UNSUPPORTED_CAPABILITY'`, listing valid `Object.keys(ADDON_REGISTRY)` keys.
2. Validate addon-specific flags for capabilities present in `initOptions.with` (silently ignoring `--model` when `ai:bedrock` is not selected, and silently ignoring `--domain`/`--zone-id`/`--from-email` when `email:ses` is not selected):
   * If `ai:bedrock` is in `initOptions.with` and `initOptions.model` is provided, validate it with the existing Bedrock model validator (`INVALID_MODEL_ID`).
   * If `email:ses` is in `initOptions.with`:
     * Validate `initOptions.domain` (`INVALID_DOMAIN`), `initOptions.zoneId` (`INVALID_ZONE_ID`), and `initOptions.fromEmail` (`INVALID_FROM_EMAIL`) if provided.
     * In headless/preconfigured mode (`isHeadless || isPreconfigured`), if `initOptions.domain` is missing and no existing `terraform/domain.tf` in `targetDir` provides a domain, fail immediately with `reason: 'MISSING_SES_DOMAIN'`.

---

## Part 3: Interactive Prompts & Shared Addon Scaffolding

### 1. Quiet `scaffoldAddon` Core in `src/commands/add.js`
Refactor `src/commands/add.js` so `runAdd` and `mainStack` share the exact same scaffolding pipeline:
* Extract `scaffoldAddon(capability, resolvedOpts, { cwd, region })` which renders the addon `.tf` file, writes it to `terraform/<file>`, injects environment variables into `terraform/main.tf` and `terraform/worker.tf` (if present), applies the `queue:sqs` worker `ignore_changes` lifecycle rule when `worker.tf` exists, and calls `syncReadmeCost(cwd)`—returning `{ file, envVars, costImpact }` without calling Clack `intro`/`outro`, `trackEvent('add_run')`, or `process.exit`.
* `runAdd` continues to call `resolveAddonOptions` + `scaffoldAddon` wrapped in its existing banners and `add_run` telemetry.

### 2. Interactive Flow (`!isHeadless && !isPreconfigured`)
Run `const capabilities = detectProjectCapabilities(targetDir)` before `getProjectConfig`:
1. **Database Prompt (`src/utils/prompts.js`):**
   * Pass `{ capabilities }` (optional 5th parameter) to `getProjectConfig`.
   * If `capabilities.relationalDb.detected` is `true`, set `initialValue: true` on the PostgreSQL RDS `confirm` prompt and append `(detected: ${capabilities.relationalDb.evidence.join(', ')})` to the prompt message.
   * If `capabilities.worker.detected` is `true` and `capabilities.worker.suggestedCommand` is non-null, pre-fill the worker command text prompt's `initialValue` / placeholder.
2. **Pre-Deploy Migration Gate Prompt (`src/commands/init.js`):**
   * If `config.hasDb` is `true` and `capabilities.migration.detected` is `true`:
     * If `initOptions.setupCiMigrate` was passed, enable the migration gate automatically without prompting.
     * Otherwise prompt with Clack `confirm`:
       * `message: 'Enable pre-deploy database migration gate in GitHub Actions? (detected: ' + capabilities.migration.command + ')'`
       * `initialValue: true`
3. **Addons `multiselect` Prompt (`src/commands/init.js`):**
   * Skip for static sites (`isStaticSite === true`).
   * Build `options` in canonical order (`storage:s3`, `db:dynamodb`, `db:redis`, `queue:sqs`, `ai:bedrock`, `email:ses`), setting `hint` to `detected: <evidence> · <costLabel>` when detected (or `<costLabel>` otherwise).
   * Pre-check (`initialValues`) the union of `initOptions.with` and capabilities where `capabilities.addons[cap].detected === true`.
   * Prompt with `multiselect({ message: 'Select cloud addons to scaffold (Space to toggle, Enter to confirm):', options, initialValues, required: false })`.
4. **Follow-Up Prompts for Selected Addons (`ai:bedrock` & `email:ses`):**
   * For `ai:bedrock`: if `initOptions.model` is set, resolve with that model. Otherwise prompt with `confirm({ message: 'Use recommended Bedrock model (' + defaultModelId + ')?', initialValue: true })`. If confirmed, resolve with the default model; if declined, call `resolveAddonOptions('ai:bedrock', {}, { cwd: targetDir, region, isInteractive: true })` to launch the two-step provider/model picker.
   * For `email:ses`: call `resolveAddonOptions('email:ses', { domain: initOptions.domain, zoneId: initOptions.zoneId, fromEmail: initOptions.fromEmail }, { cwd: targetDir, region, isInteractive: true })`.
   * For all other selected addons: call `resolveAddonOptions(cap, {}, { cwd: targetDir, region, isInteractive: false })`.

---

## Part 4: Generation Ordering, Visualizer Preview, Hints & Telemetry

### 1. Generation Sequence in `mainStack` (`src/commands/init.js`)
Execute in this exact order after prompts and `handleExistingFiles`:
1. **Base Templates:** Compute `ESTIMATED_COST` including `selectedAddons` (`estimateMonthlyCost({ ...config, addons: selectedAddons })`) and call `generateTemplates(targetDir, ...)` so `main.tf`, `worker.tf`, `database.tf`, `README.md`, and `.github/workflows/deploy.yml` are written first.
2. **Addon Scaffolding:** Iterate through `selectedAddons` in canonical registry order, calling `scaffoldAddon(cap, resolvedOptsByCap[cap], { cwd: targetDir, region })` and logging a concise per-addon confirmation line (`✅ Scaffolded terraform/<file> (<cap>)`).
3. **Pre-Deploy Migration Gate:** If enabled (via interactive confirmation or `--setup-ci-migrate`), read `.github/workflows/deploy.yml`, transform it via `injectMigrationGate(content, migrationCmd)`, and write it back. If `--setup-ci-migrate` was passed in headless mode but `!config.hasDb` or `!capabilities.migration.command`, log a `log.warn` note and continue without failing.
4. **Print-Only Visualizer Preview (When Addons Are Scaffolded):** If `selectedAddons.length > 0`, call `parseTerraformConfig(path.join(targetDir, 'terraform'))`, attach `framework`, and call `renderDryRunPreview(parsedConfig, true)` (print-only mode) so the user sees their full stack topology and cost breakdown without altering default no-addon headless stdout.
5. **Post-Init Capability Hints:** In the outro area, if `capabilities.upcomingHints.vector`, `capabilities.upcomingHints.cron`, or `capabilities.upcomingHints.mysql` is `true`, print concise one-line informational hints (e.g., noting `pgvector`, scheduled tasks, or that RDS currently provisions PostgreSQL when MySQL dependencies were detected).

### 2. Telemetry (`project_provisioned`)
Enrich the existing `project_provisioned` event in `src/commands/init.js` with:
* `selected_addons`: string array of scaffolded capability IDs (e.g. `['db:redis', 'queue:sqs']`, or `[]`).
* `detected_addons`: string array of auto-detected capability IDs from `capabilities.addons`.
* `migration_gate_enabled`: boolean.

---

## Part 5: CI Validation, Documentation & Unit Tests

### 1. CI Workflow (`.github/workflows/iac-validation.yml`)
Add a validation step that initializes a backend project with `--headless --with storage:s3,db:dynamodb,db:redis,queue:sqs,ai:bedrock,email:ses --domain example.com --setup-ci-migrate` (with `CI_MOCK_AWS=true`) and runs `terraform init -backend=false && terraform validate`.

### 2. Documentation (`apps/docs/src/content/docs/cli/init.md` & `README.md`)
Document smart dependency detection, the interactive addon `multiselect`, and the new flags (`--with`, `--model`, `--domain`, `--zone-id`, `--from-email`, `--setup-ci-migrate`).

### 3. Unit Tests (`tests/capabilities.test.js`, `tests/headless.test.js`, `tests/parser.test.js`)
* **`tests/capabilities.test.js` (new):**
  * Test tokenized detection across `package.json`, `requirements.txt`, `pyproject.toml`, `Pipfile`, `go.mod`, `Gemfile`, `prisma/schema.prisma` (Postgres vs MySQL vs SQLite), `docker-compose.yml` / `compose.yaml`, `vercel.json` crons, and `.env.example` key names (verifying `.env` values are never read and substring false-positives do not fire).
  * Verify Drizzle, Alembic, Django, and Rails trigger `relationalDb.detected === true`, while MySQL-only projects set `relationalDb.detected === false` and `upcomingHints.mysql === true`.
* **`tests/parser.test.js`:**
  * Test `initOptions` parsing: repeatable and comma-separated `--with` deduplication, `--model`, `--domain`, `--zone-id`, `--from-email`, `--setup-ci-migrate`, and `isPreconfigured`.
* **`tests/headless.test.js`:**
  * Verify `sanitizeProjectName` converts dots and underscores (`my.app_v2` -> `my-app-v2`) without changing `targetDir`.
  * Verify default `init --headless` (without `--with`) writes no addon `.tf` files (`redis.tf`, `ses.tf`, etc.) even when dependencies exist in `package.json`.
  * Verify `init --headless --with db:redis,queue:sqs,ai:bedrock` scaffolds `redis.tf`, `sqs.tf`, and `bedrock.tf`, injects all env vars into `main.tf` (and `worker.tf` with `ignore_changes`), and emits `selected_addons` on `project_provisioned`.
  * Verify fail-fast guards (`UNSUPPORTED_CAPABILITY`, `MISSING_SES_DOMAIN`, `INVALID_MODEL_ID`) trigger before `provisionStateBucket` or `handleExistingFiles` backup runs.
  * Update any telemetry module mock in `tests/headless.test.js` if needed to preserve named exports.