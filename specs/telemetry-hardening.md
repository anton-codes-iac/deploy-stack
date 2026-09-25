# Spec: Telemetry Observability & Schema Protection

## Overview
Recent PostHog exports showed an automated analyzer importing `deploy-stack` modules directly and calling `trackEvent` with primitive values (e.g., `trackEvent(true, "test")`). We want to **keep all events** (do not drop unknown or fuzzer-generated events, as they provide valuable intelligence), while preventing primitive string/array arguments from polluting the PostHog column schema via object spreading or crashing `crypto.createHash`. We also want to add invocation context tags (`is_tty`, `is_cli_entry`).

---

## Part 1: Capture & Normalize in `src/core/telemetry.js`

### 1. Remove the Event Allowlist & Normalize `eventName`
* Remove the allowlist filtering in `trackEvent(eventName, properties)` so that all events (including unexpected or fuzzer-generated event names like `'test'`, `'data'`, `true`, or `1`) are captured and sent to PostHog.
* Only return early if `process.env.DO_NOT_TRACK` is enabled or if `eventName === undefined || eventName === null || String(eventName).trim() === ''`.
* Otherwise, normalize the event name via `const normalizedEvent = String(eventName);` so booleans or numbers are safely serialized.

### 2. Protect Schema by Wrapping Non-Object `properties` & Safe Project Name Hashing
* Check if `properties` is a plain object:
  * If `properties === undefined || properties === null`, treat it as `{}`.
  * If `typeof properties === 'object' && !Array.isArray(properties)`, spread it normally.
  * If `properties` is a primitive (string, number, boolean) or an Array, preserve the data without spreading by wrapping it as `{ raw_properties: properties }`.
* **Safe Project Name Coercion:** Before passing `rawProjectName` to `crypto.createHash('sha256').update(...)`, coerce it via `String(rawProjectName ?? 'unknown')` so non-string `projectName` properties (e.g., `{ projectName: 42 }`) never throw a `TypeError`.

### 3. Invocation Context Properties
Add two boolean properties to the default telemetry payload (alongside `is_ci` and `is_test_env`) so PostHog dashboards can segment direct module imports from interactive CLI runs:
* `is_tty`: `Boolean(process.stdout && process.stdout.isTTY)`
* `is_cli_entry`: Check the basename of `process.argv[1]` using `path.basename`:
  `Boolean(process.argv && typeof process.argv[1] === 'string' && ['cli.js', 'deploy-stack'].includes(path.basename(process.argv[1])))`

---

## Part 2: Test Requirements (`tests/telemetry.test.js`)

* Update the existing allowlist drop-tests to verify that arbitrary event names (e.g., `'test'`, `true`, `1`) **are** sent to PostHog with `event: String(eventName)`.
* Verify that passing a primitive or array as `properties` (e.g., `trackEvent('test', 'test')` or `trackEvent('test', ['a', 'b'])`) sends `{ raw_properties: ... }` and does **not** create indexed keys (`0`, `1`, `2`, `3`).
* Verify that passing a non-string `projectName` (e.g., `trackEvent('test', { projectName: 42 })`) hashes `'42'` cleanly without throwing.
* Verify that events include boolean `is_tty` and `is_cli_entry` properties (asserting `typeof === 'boolean'` and testing `is_cli_entry` with stubbed `process.argv[1]`).