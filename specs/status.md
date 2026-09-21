# Spec: Health Dashboard & Auto-Diagnostics (`deploy-stack status`)

## Objective
Serve as the single Day-2 entry point for infrastructure health. Display an instant terminal dashboard of task lifecycle states and CloudWatch alarms. If the infrastructure is healthy, exit cleanly. If a degraded state is detected, automatically transition into the `diagnose` workflow to find the root cause.

## CLI Command & Flags
\`\`\`bash
deploy-stack status [options]
\`\`\`
- `--region <region>`: Explicit AWS region override.
- `--json`: Output raw status payload as JSON (disables auto-diagnose).

## Core Checks (Phase 1)
1. **ECS Service (`@aws-sdk/client-ecs`):** Fetch `desiredCount`, `runningCount`, and `pendingCount`.
2. **CloudWatch Alarms (`@aws-sdk/client-cloudwatch`):** Fetch state of project-prefixed alarms (e.g., `alb_5xx_errors`).

## Terminal UI & The Handoff (Phase 2)
- Print a clear, color-coded summary block using `picocolors`:
  - **Service:** Name, Status (`ACTIVE`).
  - **Replicas:** `runningCount / desiredCount` (green if matching, yellow if pending, red if 0 running).
  - **Alarms:** List configured alarms with current state badges (`[OK]`, `[ALARM]`).
- **The Trigger:** If `runningCount < desiredCount` (after a brief grace period) OR any alarm is in the `ALARM` state:
  1. Print: `⚠️ Degraded state detected. Running automated diagnostics...`
  2. Automatically invoke the existing `runDiagnose()` function from `src/commands/diagnose.js`.
  3. Exit with code 1 after diagnostics complete.

## Testing & Stability Requirements
- Add unit tests in `tests/status.test.js`.
- Mock ECS and CloudWatch clients.
- Verify status calculation for healthy states (clean exit, code 0).
- Verify the auto-diagnose handoff triggers correctly during a crash loop or 5XX alarm state.