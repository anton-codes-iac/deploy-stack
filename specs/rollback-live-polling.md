# Live Progress Updates for `deploy-stack rollback`

Enhance the existing `DescribeServicesCommand` polling loop in `src/commands/rollback.js` to emit live spinner updates via `s.message(...)` so the user has continuous visibility into task provisioning, container crashes, and old-task draining.

## 1. Preserve Existing Contracts (`src/commands/rollback.js`)
Keep the existing polling architecture and test contracts intact:
* **Keep the in-place loop:** Do not extract a new signature or alter how `service` and spinner instance `s` are referenced.
* **Keep timing seams:** Preserve `pollIntervalMs` (default `5000`) and deadline-based `timeoutMs` (default `300000`) so all existing `{ pollIntervalMs: 1, timeoutMs: 50 }` tests continue to work without modification.
* **Keep `PRIMARY` identity guard:** Continue matching the active deployment via `d.status === 'PRIMARY' && d.taskDefinition === targetTaskDefArn`. Never match a bare `PRIMARY` with a stale task definition ARN.
* **Keep terminal states, UX, and telemetry:** Preserve the existing `rolloutState === 'COMPLETED'` success path, `rolloutState === 'FAILED'` failure path (`error_code: 'ROLLOUT_FAILED'`), and deadline timeout path (`error_code: 'ROLLOUT_TIMEOUT'`), along with their existing user-facing messages and guidance (`status` + `logs`).

## 2. Elapsed Time & Live Counter Extraction
1. Record `const startTime = Date.now();` when initializing the polling deadline (`const deadline = startTime + timeoutMs;`).
2. On each poll iteration, after calling `DescribeServicesCommand`, compute:
   * `const elapsedSec = Math.floor((Date.now() - startTime) / 1000);`
3. If the matched `primary` deployment is not yet in a terminal state (`COMPLETED` or `FAILED`), extract its counters with safe zero defaults:
   * `const runningCount = primary?.runningCount ?? 0;`
   * `const desiredCount = primary?.desiredCount ?? 0;`
   * `const pendingCount = primary?.pendingCount ?? 0;`
   * `const failedTasks = primary?.failedTasks ?? 0;`

## 3. Dynamic Spinner Messages (`s.message(...)`)
On each non-terminal poll tick (right before checking the deadline / sleeping for `pollIntervalMs`), update the active spinner instance `s.message(...)` using the following priority order:

1. **Target `PRIMARY` not yet observed (`!primary`):**
   `Rolling back ${service} to revision ${targetRevision}... [${elapsedSec}s] (registering deployment...)`
2. **Tasks are failing (`failedTasks > 0`):**
   `Rolling back ${service} to revision ${targetRevision}... [${elapsedSec}s] (${runningCount}/${desiredCount} running, ${pendingCount} pending, ${failedTasks} failed ⚠️ — container crashing)`
3. **New tasks are running, waiting on ECS cleanup/deprovisioning (`runningCount >= desiredCount && desiredCount > 0 && pendingCount === 0`):**
   `Rolling back ${service} to revision ${targetRevision}... [${elapsedSec}s] (${runningCount}/${desiredCount} running — draining previous tasks)`
4. **Standard provisioning (default in-progress state):**
   `Rolling back ${service} to revision ${targetRevision}... [${elapsedSec}s] (${runningCount}/${desiredCount} running, ${pendingCount} pending)`

## 4. Unit Tests (`tests/rollback.test.js`)
* Keep all existing unit tests, timing options (`{ pollIntervalMs: 1, timeoutMs: 50 }`), and telemetry assertions (`error_code: 'ROLLOUT_FAILED'` / `'ROLLOUT_TIMEOUT'`) unchanged.
* Add unit tests verifying that `s.message` is called with the expected progress strings during multi-poll sequences:
  1. When the first poll has Not-Yet-Matching `PRIMARY` (`(registering deployment...)`) before transitioning to `COMPLETED`.
  2. Standard provisioning progress (`(0/1 running, 1 pending)`).
  3. Draining progress when `runningCount >= desiredCount` and `pendingCount === 0` (`(1/1 running — draining previous tasks)`).
  4. Crashing container warning when `failedTasks > 0` (`(0/1 running, 0 pending, 2 failed ⚠️ — container crashing)`).