# Deployment Safety & One-Command Rollback

This sprint delivers zero-downtime deployment safety nets across both infrastructure definition and Day-2 operations:
1. Native ECS Deployment Circuit Breakers in Terraform (`templates/terraform/main.tf`).
2. The `deploy-stack rollback [revision]` CLI command with interactive revision inspection.

---

## Part 1: Terraform Deployment Circuit Breakers

### 1. Template Update (`templates/terraform/main.tf`)
In `templates/terraform/main.tf` (around lines 204–225), locate the existing `resource "aws_ecs_service" "app"` block. **Do NOT replace or alter existing attributes** (`${local.app_name}`, `{{DESIRED_COUNT}}`, `{{PORT}}`, `enable_execute_command = true`, or `depends_on = [aws_lb_listener.http]`). Insert **only** the `deployment_circuit_breaker` block inside the existing resource:

```hcl
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
```

### 2. Generator Tests & Snapshot Update (`tests/generator.test.js`)
* In `tests/generator.test.js`, add an explicit assertion verifying that the generated `main.tf` content includes `deployment_circuit_breaker` with `enable = true` and `rollback = true`.
* Update existing snapshots in `tests/generator.test.js` by running `npx vitest run -u` and verify that the snapshot diff contains only the added `deployment_circuit_breaker` block.

---

## Part 2: `deploy-stack rollback` CLI Command

### 1. CLI Routing & Argument Parsing (`bin/cli.js` & `src/commands/rollback.js`)
* In `bin/cli.js`:
  * Add `rollback` to the flat `Commands:` list in `HELP_TEXT`, immediately after the `status` line:
    ```
      rollback [rev]       Roll back ECS service to a previous task revision
    ```
  * Route `rollback` to `runRollback({ ...parseRollbackArgs(rawArgs), ...(isHeadless ? { isHeadless: true } : {}) })` exported from `src/commands/rollback.js`. **Important:** Only pass `isHeadless: true` when `--headless` was explicitly passed on the CLI; leave `options.isHeadless` as `undefined` otherwise so normal runs fall through to `process.env.CI || !process.stdin.isTTY` auto-detection while allowing tests to pass `isHeadless: false` explicitly.
* In `src/commands/rollback.js`:
  * Implement and export `parseRollbackArgs(argv = [])`:
    * Strip a leading `'rollback'` token if present.
    * First non-flag positional argument: `revision` (optional string: can be numeric like `'12'`, `family:revision` like `'my-app-task:12'`, or a full task definition ARN).
    * Flags (supporting both `--flag value` and `--flag=value` forms):
      * `--cluster` (string)
      * `--service` (string)
      * `--region` (string)
      * `--workspace` (string)
      * `--skip-wait` (boolean, default `false`)

### 2. Resolvers, Workspace Handling & Preconditions
* **SDK-Only Command:** Do **not** gate on `hasAwsCli` (unlike `exec` or `db connect`, `rollback` uses `@aws-sdk/client-ecs` directly, matching `status`, `logs`, and `gc`).
* **Imports:**
  * Import `ECSClient`, `DescribeServicesCommand`, `ListTaskDefinitionsCommand`, `DescribeTaskDefinitionCommand`, and `UpdateServiceCommand` from `@aws-sdk/client-ecs` (do not import `DescribeTasksCommand`).
  * Import `resolveRegion`, `resolveProjectName`, `resolveCluster`, and `resolveService` from `../utils/resolvers.js`.
  * Import `handleAwsAuthError` from `../utils/aws.js`.
* **Workspace Resolution:**
  * Support `--workspace` (or local `.terraform/environment` detection) using the exact `resolveWorkspaceSuffix` pattern from `src/commands/db.js`: if a non-`default` workspace is active, namespace `projectName` as `${baseProjectName}-${workspace}` before passing `projectName` into `resolveCluster` and `resolveService` (unless `--cluster` or `--service` was explicitly passed).
* **Injectable Dependencies & Testable Headless Override:**
  * Accept `options.ecsClient` (defaulting to `new ECSClient({ region })`).
  * Accept `options.pollIntervalMs` (default `5000`) and `options.timeoutMs` (default `300000`).
  * **Testable Headless Resolution:** Because `bin/cli.js` only passes `isHeadless: true` when `--headless` is set, `options.isHeadless` is `undefined` in normal runs (preserving `process.env.CI || !process.stdin.isTTY` auto-detection) while allowing unit tests in Vitest to pass `isHeadless: false` explicitly:
    ```javascript
    const headless = typeof options.isHeadless === 'boolean'
        ? options.isHeadless
        : Boolean(process.env.CI || !process.stdin.isTTY);
    ```
* **Spinner Lifecycle & Centralized Auth Error Handling:**
  * Call `intro(color.bgCyan(color.black(' deploy-stack rollback ⏪ ')))` at the start of `runRollback`.
  * Immediately instantiate `const s = spinner();` and call `s.start('Inspecting service and task revisions...');` before entering the `try` block so `s` is always initialized and safe to pass into `handleAwsAuthError`.
  * In the outer `catch (error)` block, check for `UnrecognizedClientException` or `ExpiredTokenException`.
  * **Critical Ordering:** Emit `trackEvent('rollback_run', { projectName, success: false, error_code: 'AUTH_EXPIRED' })` and `await flushTelemetry()` *before* invoking `handleAwsAuthError(error, s, options)`, followed immediately by `return;`.

### 3. Task Definition Discovery & Selection
1. **Fetch Current Service State:**
   * Call `DescribeServicesCommand({ cluster, services: [service] })`.
   * If `services` is empty or `services[0].status !== 'ACTIVE'`, stop spinner (`s.stop(...)`), print an error that the service was not found or is inactive, emit `trackEvent('rollback_run', { projectName, success: false, error_code: 'SERVICE_NOT_FOUND' })`, `await flushTelemetry()`, call `process.exit(1)`, and `return;`.
   * Extract the active `currentTaskDefArn = services[0].taskDefinition` (e.g., `arn:aws:ecs:us-east-2:123456789012:task-definition/my-app-task:14`).
   * **Extract Family Name & Revision Number:** Parse the substring between the last `/` and the last `:`:
     ```javascript
     const familyAndRev = currentTaskDefArn.split('/').pop();
     const [family, currentRevStr] = familyAndRev.split(':');
     const currentRevNum = Number(currentRevStr);
     ```

2. **Resolve Target Revision (Stopping Discovery Spinner in All Paths):**
   * **Case A: Explicit `options.revision` provided via CLI (`rollback [rev]`):**
     * Normalize the identifier:
       * If `options.revision` is purely numeric (`/^\d+$/`), construct `targetInput = `${family}:${options.revision}``.
       * Otherwise (it is already `family:rev` or a full ARN), use `targetInput = options.revision`.
     * Validate by calling `DescribeTaskDefinitionCommand({ taskDefinition: targetInput })` directly (do **not** limit validation to the last 10 revisions from `ListTaskDefinitions`).
     * If `DescribeTaskDefinitionCommand` throws or returns an inactive definition: stop spinner (`s.stop(...)`), print a clear error message, emit `trackEvent('rollback_run', { projectName, success: false, error_code: 'REVISION_NOT_FOUND' })`, `await flushTelemetry()`, call `process.exit(1)`, and `return;`.
     * Set `targetTaskDefArn = descResp.taskDefinition.taskDefinitionArn` and `targetRevisionNum = String(descResp.taskDefinition.revision)`.
     * Stop the discovery spinner (`s.stop(\`Resolved revision \${targetRevisionNum}.\`)`) so `s` is stopped before Section 4.

   * **Case B: No `options.revision` provided:**
     * Call `ListTaskDefinitionsCommand({ familyPrefix: family, status: 'ACTIVE', sort: 'DESC', maxResults: 10 })`.
     * **Strict Older-Revision Filtering:** Filter `taskDefinitionArns` so `eligibleArns` contains only revisions whose parsed revision number (`Number(arn.split(':').pop())`) is **strictly less than `currentRevNum`**. This prevents accidentally rolling *forward* if a newer task definition revision was registered in ECS but not deployed to the service.
     * If `eligibleArns.length === 0`:
       * Stop spinner (`s.stop(...)`), print `⚠ No previous task definition revisions found for family ${family}. Cannot roll back.`
       * Emit `trackEvent('rollback_run', { projectName, success: false, error_code: 'NO_PRIOR_REVISIONS' })`, `await flushTelemetry()`, call `process.exit(1)`, and `return;`.
     * **If `headless` is true:**
       * Select `targetTaskDefArn = eligibleArns[0]` (the newest revision older than `currentRevNum`) and extract `targetRevisionNum = targetTaskDefArn.split(':').pop()`.
       * Stop the discovery spinner (`s.stop(\`Selected previous revision \${targetRevisionNum}.\`)`) so `s` is stopped before Section 4.
     * **If `headless` is false (interactive TTY):**
       * Take up to the first 5 ARNs from `eligibleArns` (`eligibleArns.slice(0, 5)`).
       * Call `DescribeTaskDefinitionCommand` in parallel using `Promise.allSettled` for those 5 ARNs so a single failed describe call does not abort discovery:
         * On `fulfilled`: extract `revision`, shortened image name/tag (`const rawImage = taskDefinition.containerDefinitions?.[0]?.image || 'unknown'; const shortImage = rawImage.split('/').pop();`), and `registeredAt` timestamp (formatted cleanly, e.g., ISO date string).
         * On `rejected`: fallback to `revision = arn.split(':').pop()`, `shortImage = 'unknown'`, `registeredAtStr = ''`.
       * Stop the discovery spinner (`s.stop('Found previous revisions.')`) before prompting.
       * Prompt using `@clack/prompts` `select()`:
         * `message: 'Select a task definition revision to roll back to:'`
         * `options`: `{ value: arn, label: \`Revision \${rev} — \${shortImage}\`, hint: registeredAtStr }`
       * If `isCancel(selectedArn)`:
         * Print `outro(color.yellow('Rollback cancelled.'))` and `return { ok: false, reason: 'cancelled' }` cleanly (exit code 0, no error telemetry).
       * Set `targetTaskDefArn = selectedArn` and `targetRevisionNum = targetTaskDefArn.split(':').pop()`.

### 4. Service Update & Deployment Monitoring
1. **Trigger Rollback:**
   * Because Section 3 stops the discovery spinner on every path, cleanly start the rollback spinner before calling `UpdateServiceCommand`:
     `s.start(\`Rolling back \${service} to revision \${targetRevisionNum}...\`);`
   * Call `UpdateServiceCommand({ cluster, service, taskDefinition: targetTaskDefArn, forceNewDeployment: true })`.
2. **If `options.skipWait` is true:**
   * Stop spinner (`s.stop(\`Rollback to revision \${targetRevisionNum} triggered.\`)`).
   * Emit `trackEvent('rollback_run', { projectName, success: true, targetRevision: String(targetRevisionNum), skipWait: true })` and `await flushTelemetry()`.
   * Print `outro(color.green(\`Rollback to revision \${targetRevisionNum} initiated! 🚀\`))` and `return { ok: true, targetTaskDefArn, targetRevision: targetRevisionNum }`.
3. **If `options.skipWait` is false (default):**
   * Keep the spinner from Step 1 running and poll `DescribeServicesCommand({ cluster, services: [service] })` every `pollIntervalMs` until `timeoutMs` elapses:
     * Locate the primary deployment: `const primary = svc.deployments?.find(d => d.status === 'PRIMARY' && d.taskDefinition === targetTaskDefArn);`
     * **Success predicate:** If `primary` exists and (`primary.rolloutState === 'COMPLETED'` || (`primary.runningCount === primary.desiredCount && primary.desiredCount > 0 && svc.deployments.length === 1`)):
       * Stop spinner with `color.green(\`Rolled back to revision \${targetRevisionNum}.\`)`.
       * Emit `trackEvent('rollback_run', { projectName, success: true, targetRevision: String(targetRevisionNum) })` and `await flushTelemetry()`.
       * Print `outro(color.green(\`Service successfully rolled back to revision \${targetRevisionNum}! 🚀\`))` and `return { ok: true, targetTaskDefArn, targetRevision: targetRevisionNum }`.
     * **Failure predicate:** If `primary?.rolloutState === 'FAILED'`:
       * Stop spinner with `color.red('❌ Rollback deployment failed.')`.
       * Print diagnostic guidance (`npx deploy-stack status` and `npx deploy-stack logs`).
       * Emit `trackEvent('rollback_run', { projectName, success: false, error_code: 'ROLLOUT_FAILED', targetRevision: String(targetRevisionNum) })` and `await flushTelemetry()`.
       * Call `process.exit(1)` and `return;`.
   * **Timeout handling:** If the loop exceeds `timeoutMs`:
     * Stop spinner with `color.yellow('⚠ Rollback timed out waiting for ECS stabilization.')`.
     * Print guidance to check progress with `npx deploy-stack status`.
     * Emit `trackEvent('rollback_run', { projectName, success: false, error_code: 'ROLLOUT_TIMEOUT', targetRevision: String(targetRevisionNum) })` and `await flushTelemetry()`.
     * Call `process.exit(1)` and `return;`.

---

## Part 3: Test Suite (`tests/rollback.test.js`)

Create `tests/rollback.test.js` using Vitest:
* Inject a mocked `ecsClient` and `{ pollIntervalMs: 1, timeoutMs: 50 }` into `runRollback` so tests execute instantaneously.
* **Test Cases:**
  1. `parseRollbackArgs` parses positional `[rev]`, `--cluster`, `--service`, `--region`, `--workspace`, and `--skip-wait`.
  2. Explicit numeric revision (`rollback 12`) calls `DescribeTaskDefinitionCommand` with `${family}:12`, updates service, waits for `COMPLETED`, and tracks `rollback_run` with `{ success: true, targetRevision: '12' }`.
  3. `--skip-wait` path triggers `UpdateServiceCommand`, skips polling, emits `rollback_run` with `{ success: true, targetRevision: '12', skipWait: true }`, and returns `{ ok: true, targetTaskDefArn, targetRevision: '12' }`.
  4. Headless mode (`isHeadless: true` or `process.env.CI = 'true'` when `isHeadless` is omitted) with no positional revision filters out revisions greater than or equal to `currentRevNum` (e.g., ignores `rev 15` when service is on `rev 14` and selects `rev 13`).
  5. Interactive mode (`isHeadless: false`) calls `DescribeTaskDefinitionCommand` via `Promise.allSettled`, displays shortened image tags (`rawImage.split('/').pop()`), prompts via `@clack/prompts` `select`, and updates service with the chosen ARN (plus handles `isCancel` cleanly without exiting 1).
  6. Graceful exit (`process.exit(1)`) and telemetry `error_code` tracking for:
     * Missing/inactive service (`SERVICE_NOT_FOUND`)
     * Single revision with no older rollback targets (`NO_PRIOR_REVISIONS`)
     * Non-existent explicit revision (`REVISION_NOT_FOUND`)
     * Failed rollout state (`ROLLOUT_FAILED`)
     * Poll timeout (`ROLLOUT_TIMEOUT`)
     * Auth expiration (`AUTH_EXPIRED`) before calling `handleAwsAuthError`.

---

## Part 4: Documentation & Sidebar Registration

1. **CLI Reference Page (`apps/docs/src/content/docs/cli/rollback.md`):**
   * Use the standard Starlight frontmatter (`title`, `description`).
   * Cover automatic ECS deployment circuit breakers vs. manual `npx deploy-stack rollback [revision]`.
   * Document flags: `--cluster`, `--service`, `--region`, `--workspace`, and `--skip-wait`.
2. **Sidebar Registration (`apps/docs/astro.config.mjs`):**
   * In `apps/docs/astro.config.mjs`, add `{ label: 'rollback', slug: 'cli/rollback' }` to the `CLI Reference` sidebar items immediately after `{ label: 'status', slug: 'cli/status' }`.