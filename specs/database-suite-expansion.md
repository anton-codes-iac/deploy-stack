# Spec: Database Suite Completion (`db enable-vector`, `db import`, and Multi-Engine RDS / Aurora Scale-to-Zero)

## Overview
Complete the `deploy-stack db` lifecycle suite and relational database engine layer by delivering the final three database roadmap capabilities in Phase 10:
1. **Multi-Engine RDS & Aurora Serverless v2 Scale-to-Zero:** Support PostgreSQL (`postgres`), MySQL (`mysql`), and Aurora PostgreSQL Serverless v2 (`aurora-postgresql` with `min_capacity = 0` auto-pause) across `init`, `visualizer`, `db connect`, `db migrate`, `db backup`, and `db restore`.
2. **Vector Databases (`deploy-stack db enable-vector`):** One-command `pgvector` activation on PostgreSQL (`postgres` and `aurora-postgresql`) inside the isolated VPC without requiring `psql` inside the user's application container image.
3. **Zero-Trust Database Ingestion (`deploy-stack db import`):** Stream a local SQL/dump file (`--file <path>`) or a remote database (`--from <url>` from Heroku, Supabase, Render, Railway, or Neon) into the private VPC database over an ephemeral SSM Port Forwarding tunnel.

### Core Architectural Principles
1. **100% Backwards Compatibility for Default PostgreSQL:** Calling `init --headless --needsDatabase` without `--db-engine` must continue to generate the exact same `postgres` (`aws_db_instance.postgres`) configuration and keep existing snapshot contracts intact.
2. **Container-Runtime Agnostic VPC Execution:** `db enable-vector` must not assume the user's application container has the `psql` CLI installed. Execute the SQL lifecycle over a tiny zero-dependency Node.js/Python inline driver or raw PostgreSQL wire-protocol/TCP handshake inside the ephemeral ECS task, or fall back to an inline Node script using the runtime environment variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
3. **Unified RDS & Cluster Discovery:** Abstract single-instance RDS (`aws_db_instance`) and Aurora Cluster (`aws_rds_cluster` + `aws_rds_cluster_instance`) behind `src/utils/rds.js` so `db connect`, `db backup`, `db restore`, `db migrate`, `db enable-vector`, and `db import` work seamlessly across all three engines.

---

## Part 1: Multi-Engine RDS & Aurora Scale-to-Zero

### 1. Supported Database Engines (`--db-engine <engine>`)
Introduce three canonical engine identifiers across `src/core/parser.js`, `src/commands/init.js`, `src/utils/prompts.js`, and `src/utils/generator.js`:
* `postgres` (default): Standard RDS PostgreSQL 16 (`aws_db_instance.postgres`, `db.t4g.micro`, port `5432`, URI scheme `postgresql://`).
* `mysql`: Standard RDS MySQL 8.0 (`aws_db_instance.postgres` or canonical resource name `aws_db_instance.main` / `postgres` kept for HCL/reference continuity or cleanly parameterized, `db.t4g.micro`, port `3306`, default username `dbadmin`, URI scheme `mysql://`).
* `aurora-postgresql`: Amazon Aurora PostgreSQL Serverless v2 (`aws_rds_cluster.postgres` + `aws_rds_cluster_instance.postgres`, engine `aurora-postgresql`, no `engine_version` on the cluster so new databases take the regional AWS default (AWS retires pinned minors such as `16.4`), port `5432`, `serverlessv2_scaling_configuration { min_capacity = 0.0, max_capacity = 2.0 }`, `enable_http_endpoint = false`, `manage_master_user_password = true`, `storage_encrypted = true`).

### 2. Interactive & Headless `init` Integration
* **CLI Flag:** Parse `--db-engine <postgres|mysql|aurora-postgresql>` in `src/core/parser.js`. Fail fast with `INVALID_DB_ENGINE` if an unsupported value is passed.
* **Capability Detection Alignment:** In `src/utils/capabilities.js`, when `relationalDb.detected` is true, use the detected `relationalDb.engine` (`postgres` vs `mysql`) as the default initial value in the interactive engine selector prompt.
* **Interactive Prompt (`src/utils/prompts.js`):** When the user answers `Yes` to provisioning a managed database in interactive `init` (and `--db-engine` was not explicitly passed):
  * Present a `select` prompt to choose the database engine:
    1. `PostgreSQL 16 (RDS db.t4g.micro — ~$13.98/mo fixed)`
    2. `Aurora PostgreSQL Serverless v2 (Scale-to-Zero 0–2 ACU — $0/mo idle compute + storage)`
    3. `MySQL 8.0 (RDS db.t4g.micro — ~$13.98/mo fixed)`
* **Headless Default:** When `--headless` or `--preconfigured` is used with `--needsDatabase` and no `--db-engine` flag is passed, default to `postgres` so all existing tests and snapshots remain unchanged.

### 3. Terraform Templates & Container Environment Wiring
* **Template Strategy:**
  * Keep `templates/terraform/database.tf` as the single target output path (`terraform/database.tf`), rendered according to the chosen `dbEngine` (`postgres`, `mysql`, or `aurora-postgresql`).
  * Ensure security group ingress rules on `aws_security_group.rds` open port `5432` for `postgres` / `aurora-postgresql` and port `3306` for `mysql`, restricted strictly to `aws_security_group.ecs_tasks.id`.
  * For `aurora-postgresql`:
    * Provision `aws_rds_cluster.postgres` with `cluster_identifier = "${local.app_name}-db-cluster"`, `engine = "aurora-postgresql"`, `database_name = replace(local.app_name, "-", "_")`, `master_username = "dbadmin"`, `manage_master_user_password = true`, `db_subnet_group_name = aws_db_subnet_group.main.name`, `vpc_security_group_ids = [aws_security_group.rds.id]`, `skip_final_snapshot = true`, `storage_encrypted = true`, and `serverlessv2_scaling_configuration { min_capacity = 0, max_capacity = 2 }`.
    * Provision `aws_rds_cluster_instance.postgres` with `identifier = "${local.app_name}-db-instance-1"`, `cluster_identifier = aws_rds_cluster.postgres.id`, `instance_class = "db.serverless"`, `engine = aws_rds_cluster.postgres.engine`, `engine_version = aws_rds_cluster.postgres.engine_version`, `publicly_accessible = false`.
    * Wire `DB_HOST` to `aws_rds_cluster.postgres.endpoint`, `DB_NAME` to `aws_rds_cluster.postgres.database_name`, `DB_PORT` to `"5432"`, and `DB_USER` / `DB_PASSWORD` secrets to `aws_rds_cluster.postgres.master_user_secret[0].secret_arn`.
    * Also inject `{ "name": "DB_ENGINE", "value": "<engine>" }` (or detect the port/scheme in `migrate.js`) when `mysql` or `aurora-postgresql` is selected so runtime tools know whether to synthesize `mysql://` or `postgresql://`.
  * Ensure all generated HCL across all three engine modes is `terraform validate`-clean and `tflint`-clean (using bare HCL references rather than deprecated single-expression interpolations).

### 4. Visualizer & Cost Estimation (`src/utils/visualizer.js`)
* Inspect `terraform/database.tf` to detect the provisioned engine (`aws_rds_cluster` -> Aurora Serverless v2; `engine = "mysql"` -> RDS MySQL; default -> RDS PostgreSQL).
* Render accurate topology labels and cost math:
  * `postgres`: `🐘 Amazon RDS (PostgreSQL managed instance)` — `$13.98/mo` fixed baseline.
  * `mysql`: `🐬 Amazon RDS (MySQL managed instance)` — `$13.98/mo` fixed baseline.
  * `aurora-postgresql`: `✨ Amazon Aurora PostgreSQL (Serverless v2 · 0–2 ACU scale-to-zero)` — `$0/mo` idle compute baseline (`+$0.12/ACU-hr when active`).

### 5. Cross-Command Multi-Engine Support (`src/utils/rds.js`, `connect.js`, `migrate.js`, `backup.js`, `restore.js`)
* **Unified `findDbTarget(rdsClient, identifier, cwd)` in `src/utils/rds.js`:**
  * Detect whether the project uses a standard RDS instance (`aws_db_instance`) or an Aurora cluster (`aws_rds_cluster`) by inspecting `terraform/database.tf` (if present) or querying `DescribeDBInstancesCommand` (`${appName}-db`) with fallback to `DescribeDBClustersCommand` (`${appName}-db-cluster`).
  * Return a normalized descriptor: `{ kind: 'instance' | 'cluster', id, engine, status, endpoint, port, dbName, masterSecretArn, raw }`.
* **`db connect`:**
  * Use the normalized `endpoint` and `port` (`5432` or `3306`).
  * Default `--local-port` to the remote database port (`5432` for Postgres/Aurora, `3306` for MySQL) unless overridden by the user.
  * Format the printed connection URI using `mysql://` when `engine === 'mysql'` and `postgresql://` otherwise.
* **`db migrate`:**
  * Update `buildRuntimeMigrationCommand` in `src/commands/db/migrate.js` so that when synthesizing `DATABASE_URL` at runtime, it uses `mysql://` if `DB_PORT === '3306'` or `DB_ENGINE === 'mysql'`, and `postgresql://` otherwise.
* **`db backup` & `db restore`:**
  * When `kind === 'cluster'` (Aurora), use `CreateDBClusterSnapshotCommand` and `DescribeDBClusterSnapshotsCommand` in `backup.js` / `restore.js`, and pin `snapshot_identifier` inside the `resource "aws_rds_cluster" "postgres"` block in `terraform/database.tf`.
  * Maintain existing `CreateDBSnapshotCommand` / `DescribeDBSnapshotsCommand` behavior for `kind === 'instance'`.

---

## Part 2: Vector Databases (`deploy-stack db enable-vector`)

### 1. Command Interface & Routing
* Route `deploy-stack db enable-vector` through `src/commands/db.js` to a new module `src/commands/db/enable-vector.js` (`runDbEnableVector`).
* Supported flags: `--cluster <name>`, `--service <name>`, `--container <name>`, `--task-def <arn-or-family>`, `--project-name <name>`, `--workspace <name>`, `--region <region>`, `--headless` / `--yes`.
* Update `VALID_DB_SUBCOMMANDS` and `HELP_TEXT` in `src/commands/db.js` and `bin/cli.js`.

### 2. Engine & Prerequisite Guards
* Inspect `terraform/database.tf` (if present in `cwd`):
  * If `terraform/database.tf` exists and its engine is `mysql`, fail fast with error code `UNSUPPORTED_VECTOR_ENGINE` explaining that `pgvector` requires PostgreSQL or Aurora PostgreSQL.
  * If `terraform/database.tf` does not exist and no `--cluster`/`--service` overrides are passed, fail fast with `NO_DATABASE_CONFIGURED` and guide the user to enable PostgreSQL first.

### 3. Zero-Dependency Ephemeral Execution Inside the VPC
* Reuse the ephemeral Fargate task runner machinery from `src/commands/db/migrate.js` (extract shared task-launch + CloudWatch log-streaming + SIGINT cancellation into a reusable helper in `src/utils/ecs-runner.js` or `src/commands/db/migrate.js` so `migrate` and `enable-vector` do not duplicate the 150-line `RunTask` / `pollUntil` / `getLogEvents` lifecycle).
* **How the SQL is executed inside the container:**
  * Because user containers may be Node, Python, Go, or Ruby (and rarely have the `psql` CLI binary installed), construct a compact, self-contained shell command that tries:
    1. `psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"` if `psql` is on `PATH`.
    2. Otherwise, if `node` is on `PATH` and `pg` or `@prisma/client` is installed in `node_modules`, execute a one-liner via `pg` (`Client`) or `@prisma/client` (`$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector;')`) and verify via `SELECT extversion FROM pg_extension WHERE extname = 'vector';`.
    3. Otherwise, if `python3` / `python` is on `PATH` with `psycopg` / `psycopg2` / `asyncpg` / `django`, execute the equivalent 5-line Python snippet.
    4. If none of those drivers exist in the container image, exit with a clear diagnostic code so the CLI prints an actionable hint (e.g., install `pg` / `@prisma/client` / `psycopg` or `postgresql-client` in the image).
* **Local Project Marker & Prisma Hint:**
  * After the remote task succeeds (exit code `0`), if `prisma/schema.prisma` exists in `cwd` and does not yet mention `postgresqlExtensions`, print a helpful note showing how to enable `previewFeatures = ["postgresqlExtensions"]` and `extensions = [vector]` in `schema.prisma`.
  * Emit `trackSuccess('db_enable_vector', { duration_ms, engine })` on completion.

---

## Part 3: Zero-Trust Database Ingestion (`deploy-stack db import`)

### 1. Command Interface & Flags
* Route `deploy-stack db import` through `src/commands/db.js` to a new module `src/commands/db/import.js` (`runDbImport`).
* Supported flags:
  * `--file <path>`: Path to a local `.sql`, `.dump`, or `.sql.gz` file to import into the remote database.
  * `--from <source-url>`: Source `postgresql://...` or `mysql://...` connection URI (e.g., from Heroku, Supabase, Render, Railway, or Neon) to dump and stream directly into the remote AWS database.
  * `--yes` / `--force`: Skip the interactive confirmation prompt before importing into the remote database.
  * Standard target overrides: `--db-identifier <id>`, `--project-name <name>`, `--workspace <name>`, `--region <region>`, `--headless`.

### 2. Input Validation & Pre-Flight Checks
* Require **exactly one** of `--file <path>` or `--from <source-url>` (or prompt interactively when in a TTY if neither was provided). If both or neither are provided in headless mode, fail fast with `INVALID_IMPORT_SOURCE`.
* If `--file <path>` is used, verify the file exists and is readable on disk before making any AWS API calls (`IMPORT_FILE_NOT_FOUND`).
* If `--from <source-url>` is used, validate that the URI starts with `postgres://`, `postgresql://`, or `mysql://` (`INVALID_SOURCE_URI`), and never log or emit the raw password in terminal output or telemetry (`redactUri(url)`).
* Check local client tooling prerequisites before opening the SSM tunnel:
  * For PostgreSQL targets: verify `psql` (or `pg_restore` for custom-format `.dump` files, plus `pg_dump` when `--from` is used) is available on the host `PATH`.
  * For MySQL targets: verify `mysql` (plus `mysqldump` when `--from` is used) is available on the host `PATH`.
  * If missing, fail fast with `MISSING_DB_CLIENT_BINARY` and print exact `brew install libpq` / `brew install mysql-client` instructions.

### 3. Ephemeral Background SSM Tunnel + Password Retrieval
* Extract the SSM port-forwarding tunnel setup from `src/commands/db/connect.js` into a reusable helper (e.g., `withDatabaseTunnel(options, async ({ localPort, host, port, dbName, username, password, engine }) => { ... })`) so `connect.js` and `import.js` share the exact same bastion/ECS task selection, RDS discovery (`findDbTarget`), and SSM session lifecycle:
  * Automatically pick an ephemeral free local port (via `net.createServer().listen(0)` or a configurable port) so `db import` never collides with a local Postgres/MySQL instance running on `5432` / `3306`.
  * Fetch the RDS master user password at runtime from AWS Secrets Manager (`GetSecretValueCommand` against `masterSecretArn` from `findDbTarget`) in memory only—never write the password to disk or command-line arguments visible in `ps` (pass via `PGPASSWORD` or `MYSQL_PWD` environment variable to the child process).
  * Wait until the local SSM port-forwarding socket accepts TCP connections (polling `127.0.0.1:<localPort>` with `pollUntil`), then execute the import stream:
    * **`--file <path>.sql`:** Pipe the file stream into `psql` / `mysql` connected to `127.0.0.1:<localPort>`.
    * **`--file <path>.sql.gz`:** Pipe through `zlib.createGunzip()` into `psql` / `mysql`.
    * **`--file <path>.dump` (Postgres custom archive):** Run `pg_restore --no-owner --no-acl -h 127.0.0.1 -p <localPort> -U <username> -d <dbName> <path>`.
    * **`--from <source-url>`:** Spawn `pg_dump --no-owner --no-acl <source-url>` (or `mysqldump`) and pipe its `stdout` directly into `psql` (or `mysql`) connected to `127.0.0.1:<localPort>`, streaming stderr progress to the terminal.
  * In a `finally` block, always terminate the background SSM session child process cleanly even if the import fails or the user presses `Ctrl+C`.

---

## Part 4: Documentation, Roadmap & Testing Requirements

### 1. Documentation & Roadmap Updates
* Update `apps/docs/src/content/docs/cli/db.md` to document:
  * `deploy-stack db enable-vector`
  * `deploy-stack db import --file <path>` and `deploy-stack db import --from <url>`
  * Multi-engine support (`postgres`, `mysql`, `aurora-postgresql` scale-to-zero) across `db connect`, `db migrate`, `db backup`, and `db restore`.
* Update `apps/docs/src/content/docs/cli/init.md` and `apps/docs/src/content/docs/architecture/database-connections.md` with the `--db-engine` flag and Aurora Serverless v2 scale-to-zero (`0 ACU`) cost breakdown.
* Check off the 3 completed items in `apps/docs/src/content/docs/roadmap.md`:
  * `[x] Vector Databases`
  * `[x] Multi-Engine RDS & Aurora Scale-to-Zero`
  * `[x] Zero-Trust Database Ingestion`

### 2. Test Suite & IaC Validation Requirements
* **Existing Snapshots Preserved:** Default `init --headless --needsDatabase` (when `--db-engine` is omitted) must keep existing snapshots untouched.
* **New Unit & Integration Tests:**
  * `tests/rds-multi-engine.test.js` (or in `tests/db.test.js` & `tests/headless.test.js`):
    * Verify `init --headless --needsDatabase --db-engine mysql` generates valid MySQL 8.0 HCL (port `3306`, `mysql` engine) and injects `DB_PORT = "3306"`.
    * Verify `init --headless --needsDatabase --db-engine aurora-postgresql` generates `aws_rds_cluster.postgres` + `aws_rds_cluster_instance.postgres` with `min_capacity = 0` and `max_capacity = 2`.
    * Verify `visualizer.js` calculates `$0/mo` idle compute baseline for `aurora-postgresql` and `$13.98/mo` for `postgres` / `mysql`.
    * Verify `findDbTarget` resolves both `aws_db_instance` and `aws_rds_cluster`, and that `db backup` / `db restore` use `CreateDBClusterSnapshotCommand` / `DescribeDBClusterSnapshotsCommand` and update `resource "aws_rds_cluster" "postgres"` when running against an Aurora cluster.
  * `tests/db.test.js` additions for `enable-vector` and `import`:
    * Verify `db enable-vector` rejects `mysql` projects with `UNSUPPORTED_VECTOR_ENGINE`, launches the ephemeral task for `postgres` / `aurora-postgresql`, and prints the Prisma vector extension hint when `prisma/schema.prisma` is present.
    * Verify `db import` validates `--file` / `--from` exclusivity, redacts source URIs on error, checks for required local client binaries, passes `PGPASSWORD` / `MYSQL_PWD` via `env` (never CLI args), and always kills the SSM tunnel child process in `finally`.
* **`scripts/test-iac.js` & `.github/workflows/iac-validation.yml`:**
  * Extend `scripts/test-iac.js` to also validate `aurora-postgresql` and `mysql` scaffolded configurations with `terraform validate` and `tflint` so all three database engines are continuously verified.