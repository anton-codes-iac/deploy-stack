We need to resolve three UX issues identified via telemetry.

## 1. Telemetry Noise Reduction (`src/core/telemetry.js`)
Because this is a hand-rolled fetch implementation, we are receiving rogue/junk events ('message', 'data', 'true') likely from stray event bindings or bot traffic. 
* Add a strict guard at the very top of `trackEvent(eventName, properties)`.
* **The Guard:** 
  * Check if `typeof eventName !== 'string'`.
  * Check if `eventName` includes any of these valid substrings: `['_run', '_pushed', '_pull', '_audit', '_streamed', '_executed', '_provisioned', '_ejected', '_applied', '_destroyed', 'recovery_', 'cli-error']`. Implement this using `.some(validStr => eventName.includes(validStr))`.
  * If invalid or not a string, immediately `return;` (before the `DO_NOT_TRACK` check and without pushing anything to `pendingRequests`).

## 2. Centralized AWS Auth Guidance (`src/utils/aws.js`)
We currently have `isAuthError` / `ExpiredTokenException` catch blocks scattered across 7 call sites in 5 files (`secrets.js`, `diagnose.js`, `exec.js`, `status.js`, `logs.js`).
* **Relocation:** Move `hasAwsCli(options = {})` AND the `AWS_CLI_INSTALL_URL` constant from `src/commands/exec.js` into `src/utils/aws.js` and export them. Ensure `utils/aws.js` imports `child_process` and `picocolors`.
* **Test/Source Fix:** Update `src/commands/exec.js` and `tests/exec.test.js` to import `hasAwsCli` and `AWS_CLI_INSTALL_URL` from `../utils/aws.js` (or `../src/utils/aws.js` for tests).
* **New Helper:** Create and export `handleAwsAuthError(error, clackSpinner = null, options = {})` in `src/utils/aws.js`.
  * The caller is responsible for checking if the error is an auth error before calling this helper.
  * **CRITICAL ORDERING:** The caller MUST emit `trackEvent` and `await flushTelemetry()` *before* invoking this helper, because this helper terminates the process.
  * Inside the helper:
    * If `clackSpinner` is provided, call `clackSpinner.stop(color.red('❌ AWS session expired or invalid credentials.'))`.
    * If `hasAwsCli(options)` is false, print instructions to install the AWS CLI using `AWS_CLI_INSTALL_URL`.
    * If `hasAwsCli(options)` is true, print: `Run aws sso login or aws configure to refresh your credentials.`
    * In both cases, print the troubleshooting link: `https://github.com/anton-codes-iac/deploy-stack/blob/main/apps/docs/src/content/docs/guides/aws-credentials.md`
    * Call `process.exit(1)` at the end of the helper, followed by `return;` to prevent test fall-through.
* **Refactor Call Sites:** Update all 7 call sites to invoke this helper (passing their local `opts` or `options` object so the `spawnSyncImpl` seam works). 
  * Remove their inline `process.exit(1)` calls. 
  * Add an explicit `return;` immediately after invoking the helper in the caller to ensure tests do not fall through.
  * Remove redundant `spinner.stop()` calls *only* within the auth error branches (e.g., in `diagnose.js` and `status.js`). Ensure non-auth error paths keep their `spinner.stop()` calls so they don't hang the terminal.

## 3. Graceful Secrets Onboarding (`src/commands/secrets.js` & `bin/cli.js`)
When running `secrets push`, if the `.env` file is missing, it currently throws a hard error.
* **Plumbing:** In `bin/cli.js`, pass `{ isHeadless }` to `pushSecrets` exactly like `pullSecrets` does. Update `@clack/prompts` import in `secrets.js` to include `isCancel`. Ensure `opts` is used instead of `options`, as `pushSecrets` normalizes arguments into `opts`.
* **UX Flow (in `pushSecrets` inner try/catch):** When `fsError.code === 'ENOENT'` is caught:
  * Stop the spinner: `s.stop('No .env file found.');`
  * **If `opts.isHeadless` OR `process.env.CI` is truthy:**
    * Print exactly: `No .env file found. In automated environments, please ensure the file is generated before running secrets push.`
    * Track event: `trackEvent('secrets_pushed', { success: false, reason: 'missing_env_headless' })` and `await flushTelemetry();`.
    * Call `process.exit(1)` followed immediately by `return;`.
  * **If interactive:** 
    * Use `@clack/prompts` `confirm` to ask: `Would you like to create an empty ${resolvedFilePath} file now to get started?`
    * Handle `isCancel(confirmed)` by printing a cancellation message and `return;`.
    * If true: Ensure parent directories exist using `await fs.mkdir(path.dirname(envPath), { recursive: true })` (using `fs/promises`). Write `# Add your environment variables here\n` to the absolute `envPath`. Print a success message to add variables and re-run. Track `secrets_pushed` event with `{ success: false, reason: 'created_empty_file' }`, `await flushTelemetry();`, then `return;`.
    * If false: Print a cancellation message and `return;`.
  * Ensure this inner catch block completely handles the flow and returns, so the error does not bubble up to the outer catch block.
* **Testing (`tests/secrets.test.js`):** 
  * GitHub Actions automatically sets `CI=true`. To prevent interactive tests from silently failing by taking the headless route, interactive test cases MUST save the original `process.env.CI`, run `delete process.env.CI`, and restore it after the test.
  * Headless test cases should verify both the `opts.isHeadless` flag and the `process.env.CI` fallback.