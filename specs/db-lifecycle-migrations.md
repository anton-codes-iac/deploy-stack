# Spec: Database Lifecycle & Migration Suite (`db migrate`, `db backup`, `db restore`, & Pre-Deploy Migration Gate)

## Overview
Deliver end-to-end Day-2 relational database lifecycle management for `deploy-stack` in two clean phases:
* **Phase A (Pre-Refactor & Shared Utilities):** Split `src/commands/db.js` into modular subcommand files under `src/commands/db/` (with `src/commands/db.js` acting as the dispatcher and re-export barrel), recurse in `tests/commands-import.test.js`, and extract shared helpers across `src/utils/rds.js`, `src/utils/ecs.js`, `src/utils/detector.js`, `src/utils/resolvers.js`, `src/utils/system.js`, and `src/commands/logs.js`.
* **Phase B (Feature Implementation):**
  1. **On-Demand Remote Migration Runner (`deploy-stack db migrate`):** Launch an ephemeral one-off ECS Fargate task in the service's VPC subnets using the active service task definition (or an explicit `--task-def` revision in CI), stream CloudWatch logs via `FilterLogEventsCommand` with event deduplication, and exit with the container's exit code via `failCommand`.
  2. **Pre-Deploy Database Migration Gate (`deploy-stack db migrate --setup-ci`):** Idempotently inject a migration gate step into `.github/workflows/deploy.yml` after the task definition registration step (using `actions/setup-node@v4` and `--task-def`) so migrations from the **newly built image** execute before the ECS service updates.
  3. **On-Demand Database Snapshots (`deploy-stack db backup`):** Create tagged manual RDS snapshots (`CreateDBSnapshotCommand`) and poll with `pollUntil` until `available` (or return immediately with `--no-wait`).
  4. **Database Snapshot Restore (`deploy-stack db restore`):** List snapshots via `DescribeDBSnapshotsCommand` (with pagination), warn explicitly about data replacement (`skip_final_snapshot = true`), and idempotently upsert `snapshot_identifier` inside `resource "aws_db_instance" "postgres"` in `terraform/database.tf`.

---

## Part 1: Pre-Refactor & Shared Utilities

1. **Modular `db` Directory + Recursive Import Guard:**
   * Move the existing `connect` implementation into `src/commands/db/connect.js` and add `src/commands/db/migrate.js`, `src/commands/db/backup.js`, and `src/commands/db/restore.js`.
   * Keep `src/commands/db.js` as the `runDb` dispatcher and re-export barrel (`runDb`, `runDbConnect`, `parseDbArgs`, `runDbMigrate`, `parseDbMigrateArgs`, `runDbBackup`, `parseDbBackupArgs`, `runDbRestore`, `parseDbRestoreArgs`, `detectMigrationCommand`) so existing imports in `bin/cli.js` and `tests/db.test.js` remain unbroken.
   * Update `tests/commands-import.test.js` to recursively scan `src/commands/**/*.js` so all subcommand modules in `src/commands/db/` are checked by the telemetry-import guard.
2. **`src/utils/rds.js` (New):**
   * `findDbInstance(rdsClient, dbIdentifier)`: wraps `DescribeDBInstancesCommand({ DBInstanceIdentifier: dbIdentifier })` and returns the instance object, or returns `null` when `DBInstanceNotFound` / `DBInstanceNotFoundFault` is thrown (re-throwing unexpected errors).
   * `generateSnapshotId(dbIdentifier, now = new Date())`: formats `${dbIdentifier}-manual-YYYYMMDD-HHmmss` in UTC (lowercased, RDS-safe).
   * `isValidSnapshotId(id)`: validates against RDS snapshot identifier rules (`^[a-zA-Z][a-zA-Z0-9-]{0,254}$`, no `--`, no trailing `-`).
3. **`src/utils/detector.js`:**
   * Implement and export `detectMigrationCommand(cwd)` here (and re-export from `src/commands/db.js`), reusing the existing `package.json`, `Gemfile`, and `manage.py` inspection patterns in priority order:
     1. `package.json` scripts: `scripts["db:migrate"]` -> `'npm run db:migrate'`, `scripts["migrate"]` -> `'npm run migrate'`.
     2. `prisma/schema.prisma` or `prisma` in dependencies/devDependencies -> `'npx prisma migrate deploy'`.
     3. `drizzle.config.ts` / `.js` / `.mjs` -> `'npx drizzle-kit migrate'`.
     4. `alembic.ini` -> `'alembic upgrade head'`.
     5. `manage.py` -> `'python manage.py migrate --noinput'`.
     6. `bin/rails` or `Gemfile` with `rails` -> `'bundle exec rails db:migrate'`.
     7. Otherwise `null`.
4. **`src/utils/resolvers.js`:**
   * Export `resolveHeadless(options = {}, env = process.env, stdin = process.stdin, stdout = process.stdout)`: returns `true` when `Boolean(options.isHeadless || options.headless || env.CI || env.VITEST || env.NODE_ENV === 'test' || !stdin?.isTTY || !stdout?.isTTY)` (with an explicit `options.isHeadless === false` override supported for unit tests that simulate interactive TTY prompts).
   * Export `resolveAppName(projectName, workspace, env = process.env)`: combines `projectName` with `resolveWorkspaceSuffix({ workspace }, env)` (`${projectName}${suffix}`).
5. **`src/utils/ecs.js`:**
   * Export `fetchActiveService(ecsClient, clusterName, serviceName)`: calls `DescribeServicesCommand({ cluster: clusterName, services: [serviceName] })` and returns the service if found with `status === 'ACTIVE'`, or `null` otherwise.
6. **`src/utils/system.js`:**
   * Export `pollUntil({ intervalMs, timeoutMs, sleepFn = sleep, nowFn = Date.now, onTick })`: executes `await onTick({ elapsedMs })` in a loop until it returns `{ done: true, value }` or `elapsedMs >= timeoutMs` (returning `{ timedOut: true }`), sleeping `intervalMs` between ticks.
7. **`src/commands/logs.js`:**
   * Export `isNotFoundError(err)` and `buildLogStreamName(containerName, taskId)` (returning `ecs/${containerName}/${taskId}`).

---

## Part 2: CLI Dispatcher, Parsers & Telemetry Conventions (`bin/cli.js` & `src/commands/db.js`)

1. **Dispatcher (`runDb`):**
   * `bin/cli.js` routes `case 'db':` to `await runDb(args.slice(1), { ...(isHeadless ? { isHeadless: true } : {}) })` and updates `HELP_TEXT` to list `db connect`, `db migrate`, `db backup`, and `db restore`.
   * If `subcommand` is missing or not one of `connect | migrate | backup | restore`, call `failCommand` with event `'db_run'`, `errorCode: 'UNKNOWN_DB_SUBCOMMAND'`, `reason: 'unknown-db-subcommand'`, and actionable usage output.
2. **Subcommand Argument Parsers (Backward-Compatible):**
   * Keep `parseDbArgs(rawArgs)` unchanged for `db connect`.
   * `parseDbMigrateArgs(rawArgs)`:
     * Boolean flags: `['setup-ci', 'headless']`
     * String flags: `[{ name: 'cmd', key: 'cmd' }, { name: 'task-def', key: 'taskDef' }, { name: 'timeout', key: 'timeout' }, { name: 'project-name', key: 'projectName' }, { name: 'region', key: 'region' }, { name: 'workspace', key: 'workspace' }, { name: 'cluster', key: 'cluster' }, { name: 'service', key: 'service' }, { name: 'container', key: 'container' }]`
     * Also capture `rest`: if `rest.length > 0`, fail fast in `runDbMigrate` with `errorCode: 'UNEXPECTED_POSITIONAL_ARGS'`, `reason: 'unexpected-positional-args'`, hinting to wrap multi-word `--cmd` values in quotes.
   * `parseDbBackupArgs(rawArgs)`:
     * Boolean flags: `['no-wait', 'headless']`
     * String flags: `[{ name: 'id', key: 'snapshotId' }, { name: 'timeout', key: 'timeout' }, { name: 'project-name', key: 'projectName' }, { name: 'region', key: 'region' }, { name: 'workspace', key: 'workspace' }, { name: 'db-identifier', key: 'dbIdentifier' }]`
   * `parseDbRestoreArgs(rawArgs)`:
     * Boolean flags: `['yes', 'headless']`
     * String flags: `[{ name: 'project-name', key: 'projectName' }, { name: 'region', key: 'region' }, { name: 'workspace', key: 'workspace' }, { name: 'db-identifier', key: 'dbIdentifier' }]`
     * Positional: `snapshotId = rest[0] || ''` (matching the `rollback.js` positional pattern).
3. **Telemetry Conventions:**
   * Event names: `'db_migrate_run'`, `'db_backup_run'`, `'db_restore_run'`.
   * Use `trackSuccess` and `failCommand` (with `errorCode: 'SCREAMING_SNAKE_CASE'` and `reason: 'kebab-case'`, plus `handleAuthErrorBranch` for AWS credential errors).
   * **Privacy:** Never include raw `--cmd` strings or snapshot ARNs in telemetry properties; for `db_migrate_run`, record `cmd_source: 'explicit' | 'detected' | 'prompted'` and `ci_setup: Boolean(setupCi)`.

---

## Part 3: On-Demand Remote Migration Runner (`src/commands/db/migrate.js`)

1. **Command Resolution & Timeout Validation:**
   * Validate `--timeout` if provided: must parse to a positive integer (seconds, default `600`); otherwise fail before AWS calls with `errorCode: 'INVALID_TIMEOUT'`, `reason: 'invalid-timeout'`.
   * Resolve migration command:
     * If `cmd` flag is provided and non-empty after `.trim()`, use it (`cmd_source = 'explicit'`).
     * Else call `detectMigrationCommand(cwd)`:
       * In interactive mode (`!resolveHeadless(options)`), prompt via Clack `text` (with `initialValue: detectedCmd || ''`, `placeholder: 'e.g. npx prisma migrate deploy'`). Handle `isCancel` cleanly. Set `cmd_source = 'prompted'`.
       * In headless mode, if `detectedCmd` exists, use it (`cmd_source = 'detected'`); otherwise fail with `errorCode: 'MISSING_MIGRATION_CMD'`, `reason: 'missing-migration-cmd'`.
2. **If `--setup-ci` Is Passed (Pre-Deploy Gate Injection):**
   * Do not make AWS API calls. Locate `.github/workflows/deploy.yml` in `cwd` (if missing, fail with `errorCode: 'WORKFLOW_NOT_FOUND'`, `reason: 'workflow-not-found'`).
   * Inject or replace a delimited block (`# deploy-stack:db-migrate-start` ... `# deploy-stack:db-migrate-end`) inside `.github/workflows/deploy.yml`:
     * Place the block **immediately after** the `Register new Task Definition` step (or immediately before `- name: Force ECS deployment` / service update step).
     * Ensure `actions/setup-node@v4` (with `node-version: '20'`) is included in the injected block (unless `actions/setup-node` already exists earlier in the job) so `npx` is available on `ubuntu-latest`.
     * Run `npx deploy-stack db migrate --cmd <shell-safe-quoted-cmd> --task-def "${{ steps.register-task-def.outputs.task-def-arn || env.NEW_TASK_DEF_ARN }}" --headless` (matching the task definition output/variable from `templates/github/deploy.yml` so migrations run using the **newly registered image revision** before the ECS service updates).
   * Write the updated workflow file, emit `trackSuccess('db_migrate_run', { cmd_source, ci_setup: true })`, and return.
3. **Live ECS Task Execution (`!setupCi`):**
   * Resolve `projectName`, `region`, `appName = resolveAppName(projectName, workspace)`, `clusterName = resolveCluster({ cluster }, appName)`, `serviceName = resolveService({ service }, appName)`.
   * Call `fetchActiveService(ecsClient, clusterName, serviceName)`:
     * If missing, fail with `errorCode: 'ECS_SERVICE_NOT_FOUND'`, `reason: 'ecs-service-not-found'`.
     * Extract `awsvpcConfiguration` (`subnets`, `securityGroups`, `assignPublicIp = 'ENABLED'`) from `service.networkConfiguration.awsvpcConfiguration`.
   * Determine `targetTaskDef = options.taskDef || service.taskDefinition`.
   * Call `DescribeTaskDefinitionCommand({ taskDefinition: targetTaskDef })` and resolve the target container via `resolveContainer({ container }, appName)` (or `pickRuntimeContainer`):
     * If the resolved container name does not exist in `taskDefinition.containerDefinitions`, fail before `RunTaskCommand` with `errorCode: 'CONTAINER_NOT_FOUND'`, `reason: 'container-not-found'`.
   * Launch the task via `RunTaskCommand`:
     * `cluster`: `clusterName`
     * `taskDefinition`: `targetTaskDef`
     * `launchType`: `'FARGATE'`
     * `networkConfiguration`: `{ awsvpcConfiguration: { subnets, securityGroups, assignPublicIp } }`
     * `startedBy`: `'deploy-stack-db-migrate'`
     * `overrides`: `{ containerOverrides: [{ name: containerName, command: ['sh', '-c', resolvedCmd] }] }`
     * If `failures?.length > 0` or `!tasks?.[0]?.taskArn`, fail with `errorCode: 'RUN_TASK_FAILED'`, `reason: 'run-task-failed'`.
4. **CloudWatch Log Streaming, SIGINT & Exit Code Propagation:**
   * Register a `SIGINT` listener during polling that calls `StopTaskCommand({ cluster: clusterName, task: taskArn, reason: 'Cancelled by user via SIGINT' })` (best-effort) and cleans up the listener in `finally`.
   * Use `pollUntil` (polling interval `2000ms` default, configurable via `options.pollIntervalMs` for tests; timeout `timeoutSeconds * 1000`):
     * On each tick, call `FilterLogEventsCommand({ logGroupName: '/ecs/' + appName, logStreamNames: [buildLogStreamName(containerName, taskId)], startTime })` while deduplicating via a `seenEventIds = new Set()` (mirroring `src/commands/logs.js` and ignoring `isNotFoundError(err)` while the stream is initializing). Print new messages to stdout.
     * Call `DescribeTasksCommand({ cluster: clusterName, tasks: [taskArn] })`. When `task.lastStatus === 'STOPPED'`, sleep `settleDelayMs` (`500ms` default, `0ms` in tests), perform one final log fetch, and return `{ done: true, value: task }`.
   * If `pollUntil` times out, call `StopTaskCommand` (best-effort) and call `failCommand` with `errorCode: 'MIGRATION_TIMEOUT'`, `reason: 'migration-timeout'`.
   * Inspect the matching container in `task.containers`:
     * Prefer `container.reason` over `task.stoppedReason`.
     * If `container?.exitCode === 0`, call `trackSuccess('db_migrate_run', { cmd_source, ci_setup: false })` and return `{ success: true, exitCode: 0, taskArn }`.
     * Otherwise, compute `exitCode = (typeof container?.exitCode === 'number' && container.exitCode > 0) ? container.exitCode : 1` and call `failCommand` with event `'db_migrate_run'`, `errorCode: 'MIGRATION_TASK_FAILED'`, `reason: 'migration-task-failed'`, `exitCode`, and `extra: { exit_code: container?.exitCode ?? -1 }`.

---

## Part 4: On-Demand RDS Snapshots & Restore (`src/commands/db/backup.js` & `restore.js`)

1. **`deploy-stack db backup` (`src/commands/db/backup.js`):**
   * Validate `--id` (if provided) via `isValidSnapshotId(id)` before making AWS calls; if invalid, fail with `errorCode: 'INVALID_SNAPSHOT_ID'`, `reason: 'invalid-snapshot-id'`.
   * Validate `--timeout` (if provided, positive integer seconds, default `900`).
   * Resolve `appName = resolveAppName(projectName, workspace)` and `dbIdentifier = resolveDbIdentifier({ dbIdentifier }, appName)`.
   * Call `findDbInstance(rdsClient, dbIdentifier)`; if `null`, fail with `errorCode: 'RDS_INSTANCE_NOT_FOUND'`, `reason: 'rds-instance-not-found'`.
   * Generate `snapshotId = options.snapshotId || generateSnapshotId(dbIdentifier)`.
   * Call `CreateDBSnapshotCommand({ DBInstanceIdentifier: dbIdentifier, DBSnapshotIdentifier: snapshotId, Tags: [{ Key: 'ManagedBy', Value: 'deploy-stack' }, { Key: 'Project', Value: projectName }] })`.
   * If `--no-wait` is true, log the snapshot ID, emit `trackSuccess('db_backup_run', { waited: false })`, and return `{ snapshotId, status: 'creating' }`.
   * Otherwise poll `DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: snapshotId })` via `pollUntil` (interval `5000ms` default, configurable via `options.pollIntervalMs`; timeout `timeoutSeconds * 1000`):
     * Ignore transient `DBSnapshotNotFound` / `DBSnapshotNotFoundFault` on early ticks (eventual consistency right after `CreateDBSnapshot`).
     * When `snapshot.Status === 'available'`, log the snapshot ID and restore command hint (`npx deploy-stack db restore ${snapshotId}`), emit `trackSuccess('db_backup_run', { waited: true })`, and return `{ snapshotId, status: 'available' }`.
     * On timeout, fail with `errorCode: 'SNAPSHOT_TIMEOUT'`, `reason: 'snapshot-timeout'`.
2. **`deploy-stack db restore` (`src/commands/db/restore.js`):**
   * Check that `terraform/database.tf` exists in `cwd` (if missing, fail with `errorCode: 'DATABASE_TF_NOT_FOUND'`, `reason: 'database-tf-not-found'`).
   * Resolve `appName` and `dbIdentifier = resolveDbIdentifier({ dbIdentifier }, appName)`.
   * Paginate `DescribeDBSnapshotsCommand({ DBInstanceIdentifier: dbIdentifier })` using `Marker` (and if a specific positional `snapshotId` was passed and not found under `DBInstanceIdentifier`, fall back to `DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: snapshotId })` so snapshots from previously replaced/deleted instances can still be restored by ID).
   * Sort discovered snapshots by `SnapshotCreateTime` descending:
     * If no snapshots are found, fail with `errorCode: 'NO_SNAPSHOTS_FOUND'`, `reason: 'no-snapshots-found'`.
   * If positional `snapshotId` is omitted:
     * If `resolveHeadless(options)` is true, fail with `errorCode: 'MISSING_SNAPSHOT_ID'`, `reason: 'missing-snapshot-id'`.
     * Otherwise prompt with Clack `select` displaying each snapshot's identifier, UTC timestamp, storage size, and type.
   * Verify the selected snapshot has `Status === 'available'` (else fail with `errorCode: 'SNAPSHOT_NOT_AVAILABLE'`, `reason: 'snapshot-not-available'`).
   * **Destructive Data Replacement Warning & Confirmation:**
     * If `!options.yes`:
       * In headless mode, fail with `errorCode: 'CONFIRMATION_REQUIRED'`, `reason: 'confirmation-required'`.
       * In interactive mode, warn explicitly that setting `snapshot_identifier` on `aws_db_instance.postgres` will replace the current RDS instance on the next `apply` and (`skip_final_snapshot = true`) permanently discard any data written after the snapshot unless backed up first (recommending `npx deploy-stack db backup` first), then prompt `confirm`.
   * **Idempotent HCL Upsert in `terraform/database.tf`:**
     * Export a pure helper `upsertSnapshotIdentifier(hclContent, snapshotId)` scoped to `resource "aws_db_instance" "postgres"` (following the resource-scoped edit pattern in `src/commands/add.js`):
       * Replace an existing `snapshot_identifier = "..."` attribute inside `resource "aws_db_instance" "postgres"`, or insert `snapshot_identifier = "${snapshotId}"` inside the resource block.
       * Add or preserve a comment noting that `snapshot_identifier` should remain in `database.tf` after `apply` so subsequent applies stay no-op.
     * Write `terraform/database.tf`, log instructions to run `npx deploy-stack apply`, call `trackSuccess('db_restore_run', {})`, and return `{ snapshotId }`.

---

## Part 5: Documentation, Roadmap & Unit Tests

1. **Documentation & Roadmap:**
   * Update `apps/docs/src/content/docs/cli/db.md` to cover `db connect`, `db migrate` (`--cmd`, `--task-def`, `--setup-ci`, `--timeout`), `db backup` (`--id`, `--no-wait`, `--timeout`), and `db restore` (`<snapshot-id>`, `--yes`, and the `snapshot_identifier` lifecycle note).
   * Mark **Pre-Deploy Database Migration Gate**, **On-Demand Database Snapshots & Restore**, and **On-Demand Remote Migration Runner** as `[x]` in `README.md` and `apps/docs/src/content/docs/roadmap.md`.
2. **Unit Tests (`tests/db.test.js` & utility test files):**
   * Use `stripVTControlCharacters` from `node:util` on any `picocolors`-styled output assertions per `.muserules`.
   * Test `src/utils/rds.js` (`findDbInstance`, `generateSnapshotId`, `isValidSnapshotId`), `detectMigrationCommand(cwd)` in `src/utils/detector.js`, `resolveHeadless` in `src/utils/resolvers.js`, `fetchActiveService` in `src/utils/ecs.js`, `pollUntil` in `src/utils/system.js`, and `buildLogStreamName` / `isNotFoundError` in `src/commands/logs.js`.
   * Test `runDb` dispatcher (`UNKNOWN_DB_SUBCOMMAND`), `db migrate` (command resolution, unquoted positional guard, container validation against task definition, `--task-def` override, `FilterLogEventsCommand` deduplication + `ResourceNotFoundException` handling, exit code propagation via `failCommand`, timeout + `StopTaskCommand`, and `--setup-ci` idempotent injection into `.github/workflows/deploy.yml`), `db backup` (invalid `--id` fast failure, `--no-wait`, `DBSnapshotNotFound` eventual consistency during polling, quota/modifying error propagation), and `db restore` (pagination, fallback lookup by `DBSnapshotIdentifier`, headless guards, and idempotent `upsertSnapshotIdentifier` on `terraform/database.tf`).