# Spec: Telemetry Identity Separation, Context Alignment & Binary Check Deduplication

## Overview
Resolve three telemetry and process-spawning issues observed in live PostHog exports:
1. **Machine-Scoped `distinct_id` vs. Project-Scoped `project_id` (`src/core/telemetry.js`):**
   * Previously, `distinct_id` hashed `properties.projectName || 'unknown'`, causing commands that omitted `projectName` (`doctor_run` and early `add_run` guards) to hash `'unknown'` (`b23a6a8439c0dde5`) and merge unrelated users across geographies into one PostHog Person.
2. **Consistent `is_ci` & `cli_command` Context (`src/core/telemetry.js`):**
   * Align `is_ci` with `ci_provider` so unsetting `CI` while leaving `GITHUB_ACTIONS` set never produces `is_ci: false` alongside `ci_provider: 'github_actions'`.
   * Guard `cli_command` on `is_cli_entry` so programmatic module imports report `'module_import'` while preserving multi-word CLI command names (`db connect`, `secrets push`) on real CLI invocations.
3. **Binary Check Deduplication (`src/utils/aws.js`, `src/commands/doctor.js`):**
   * Prevent redundant child-process spawns when `hasAwsCli()` or `runDoctor()` is called ~32 times in rapid succession inside PID-limited containers, while keeping unit tests isolated.

---

## Part 1: Machine-Scoped `distinct_id`, Project-Scoped `project_id` & Test Seams (`src/core/telemetry.js`)

1. **`distinct_id` Resolution & 16-Hex Format:**
   * `distinct_id` must always be a 16-character lowercase hexadecimal SHA-256 prefix (`sha256(rawIdentity)[:16]`), and must never hash `'unknown'` or a bare project folder name.
   * **Test Seam & Cache Reset:**
     * Export a `resetTelemetryIdentityCache()` function that clears the in-memory cached `distinct_id` between unit tests.
     * Support an environment variable override `process.env.DEPLOY_STACK_TELEMETRY_ID_PATH` for the persistent identity file path (defaulting to `path.join(os.homedir(), '.deploy-stack', 'telemetry-id')`).
   * **Resolution Precedence (Cached in Memory Once Resolved):**
     * **Explicit Override Precedence:** If `process.env.DEPLOY_STACK_TELEMETRY_ID_PATH` is explicitly set and non-empty, always take **Branch B (Persistent File)** using that path—even when `is_ci` or `is_test_env` is `true`. This guarantees persistent-file unit tests run deterministically both locally and inside GitHub Actions (`CI=true`).
     * **Branch A — Ephemeral / CI / Unconfigured Test Environment:** When `DEPLOY_STACK_TELEMETRY_ID_PATH` is not explicitly set and either `is_ci` is `true` or `is_test_env` is `true`, compute `distinct_id` by hashing a colon-delimited string of exact machine/CI attributes: `os.hostname()`, `os.platform()`, `os.arch()`, `process.env.GITHUB_REPOSITORY || ''`, `process.env.GITHUB_RUN_ID || ''`, and `process.env.GITLAB_PROJECT_PATH || ''`. Do **not** include `process.cwd()` in `distinct_id` so multiple commands run from different directories on the same runner share one Person within a run.
     * **Branch B — Persistent File Environment:** When `DEPLOY_STACK_TELEMETRY_ID_PATH` is explicitly set, or when neither `is_ci` nor `is_test_env` is `true`, attempt to read the trimmed UUID string from the identity file path. If the file does not exist or is empty, generate a `crypto.randomUUID()`, create the parent directory (`recursive: true`), and write the UUID to the file. Hash the read or newly generated UUID string with SHA-256 (16-hex prefix) and cache it in memory. If reading or writing throws any filesystem error, fall back cleanly to Branch A and cache that result.
2. **`project_id` Property Derivation:**
   * Keep the existing `String(...)` coercion on `properties.projectName` (so numeric inputs like `42` coerce to `'42'`), delete `projectName` from the outgoing event properties, and attach `project_id` set to the 16-character SHA-256 hex prefix of the resolved project name string.
   * When `properties.projectName` is `undefined`, `null`, or empty string `''`, derive the fallback string from `path.basename(process.cwd())`; if that basename is also empty (e.g., `/`), use `'unknown'`.
   * Update the existing `tests/telemetry.test.js` test that previously asserted `distinct_id === sha256('42')[:16]` so it now asserts `properties.project_id === sha256('42')[:16]` and verifies `distinct_id` is a stable 16-hex machine ID not equal to `sha256('unknown')[:16]`.

---

## Part 2: Telemetry Context Alignment (`src/core/telemetry.js`)

1. **Boolean Env Helper & `is_ci` / `ci_provider` Consistency:**
   * Treat an environment variable as active/truthy only when it is defined and its trimmed lowercase value is not `''`, `'0'`, or `'false'`.
   * Apply this check in `detectCiProvider()` as well (fixing the pre-existing quirk where `GITHUB_ACTIONS='false'` matched `'github_actions'`).
   * Compute `ci_provider` first, then set `is_ci` to `true` if `process.env.CI` passes the truthy check **or** `ci_provider !== 'none'`.
2. **`cli_command` Precedence Guarded by `is_cli_entry`:**
   * Compute `is_cli_entry` first (`['cli.js', 'deploy-stack'].includes(path.basename(process.argv?.[1] || ''))`).
   * When `is_cli_entry` is `true`, preserve the existing precedence: use `CLI_COMMAND` (which captures two-word commands like `db connect` and `secrets push`) falling back to `process.argv.slice(2).join(' ') || 'unknown'`.
   * When `is_cli_entry` is `false`, set `cli_command` to `'module_import'`.

---

## Part 3: Binary Pre-Flight Caching & Deduplication (`src/utils/aws.js` & `src/commands/doctor.js`)

1. **Synchronous `hasAwsCli(options = {})` Result Caching (`src/utils/aws.js`):**
   * Preserve the exact existing signature `hasAwsCli(options = {})` where callers pass `options.spawnSyncImpl` (used across `src/commands/exec.js`, `src/commands/db.js`, `tests/exec.test.js`, and `tests/db.test.js`).
   * **Bypass Cache on Custom `options.spawnSyncImpl`:** Only read/populate the module-level boolean cache when `options.spawnSyncImpl` is not provided (`options.spawnSyncImpl === undefined`). Whenever a caller or test passes a custom `options.spawnSyncImpl` (such as `tests/exec.test.js` calling `hasAwsCli({ spawnSyncImpl: mockSpawn })` three times expecting `false`/`true`/`false`), execute `options.spawnSyncImpl` directly without reading or writing the cache.
   * For default calls (`options.spawnSyncImpl === undefined`), cache the boolean result for `5000` ms (`AWS_CLI_CACHE_TTL_MS = 5000`) so 32 rapid calls in a container without injected mocks spawn `aws --version` only once instead of 32 times.
   * Export `resetAwsCliCache()` to allow explicit cache clearing in unit tests.
2. **In-Flight `checkDependency` Deduplication in `runDoctor()` (`src/commands/doctor.js`):**
   * Keep the deduplication scoped to `src/commands/doctor.js` (leaving sequential single calls in `init.js` and `destroy.js` untouched).
   * Maintain a module-scoped `Map` of in-flight promises keyed by the binary name (`cmd`). Perform the `Map` lookup and `.set(cmd, promise)` synchronously before any `await` in the wrapper, and remove the key in `.finally(() => inFlight.delete(cmd))` once the promise settles.

---

## Part 4: Unit Tests (`tests/telemetry.test.js`, `tests/doctor.test.js`, `tests/aws.test.js`)

1. **`tests/telemetry.test.js`:**
   * Call `resetTelemetryIdentityCache()` in `beforeEach`.
   * Update the numeric `projectName: 42` test to assert `properties.project_id === sha256('42')[:16]` and verify `distinct_id` is a 16-hex string that stays identical across events with and without `projectName` and never equals `b23a6a8439c0dde5` (`sha256('unknown')[:16]`).
   * Test persistent file identity using a temporary directory via `DEPLOY_STACK_TELEMETRY_ID_PATH` (verifying that a UUID file is created and subsequent calls after `resetTelemetryIdentityCache()` produce the same `distinct_id`, even when `CI=true`).
   * Verify `is_ci` is `true` when `CI` is unset (`delete process.env.CI`) and `GITHUB_ACTIONS='true'`, and `false` when `CI='false'` and `GITHUB_ACTIONS='false'`.
   * Verify `cli_command` is `'module_import'` when `is_cli_entry` is `false`, and preserves `CLI_COMMAND` / subcommand args when `is_cli_entry` is `true`.
2. **`tests/doctor.test.js` & `tests/aws.test.js`:**
   * In `tests/doctor.test.js`, verify that calling `runDoctor()` 5 times concurrently via `Promise.all` invokes `checkDependency` only once per binary (4 calls total, not 20) while the promises are in flight, and invokes it fresh on a subsequent sequential call.
   * In `tests/aws.test.js`, use a `child_process` module mock (`vi.mock`) to verify that repeated default `hasAwsCli()` calls within the TTL spawn `aws --version` only once and reuse the cached boolean until `resetAwsCliCache()` is called, while leaving `tests/exec.test.js` undisturbed.