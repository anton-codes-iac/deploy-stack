# Specification: Test Suite Deduplication & Hygiene

## 1. Overview
The current Vitest test suite contains significant boilerplate. Mocks for terminal interactions (`@clack/prompts`), telemetry (`src/core/telemetry.js`), and basic console/tmpdir helpers are hand-rolled and duplicated across 17+ test files. 

This task extracts these shared mocks into a centralized `tests/helpers/` directory to shrink the maintenance surface area.

## 2. Boundaries & Constraints
- **NO PRODUCTION CHANGES:** Do not modify any files in `src/`, `bin/`, or `templates/`. Do not modify `vitest.config.js`.
- **OUT OF SCOPE FILES:** Do not migrate `tests/telemetry.test.js` or `tests/commands-import.test.js` (leave their bespoke mocks intact to prevent import/circular breakages).
- **OUT OF SCOPE MOCKS:** Do NOT attempt to unify AWS SDK or `child_process` mocks in this pass. 
- **EXPLICIT IMPORTS:** Use explicit `vi.hoisted` imports per test file. Do not use global `setupFiles` auto-mocking.

## 3. Extraction Targets
Create the `tests/helpers/` directory and extract the following:

1. **`@clack/prompts` Mock:**
   - Centralize the mock implementations for all used exports: `intro`, `outro`, `text`, `select`, `confirm`, `spinner`, `isCancel`, `cancel`, `log`, `multiselect`, `password`, `note`, and `group`.
   - **Bare Defaults:** Shared factories must ship with bare `vi.fn()`s. Any preset return values (like `mockResolvedValue(['claude'])`) must remain as test-specific overrides in the individual test files.
   - **`isCancel` Semantics:** Must preserve the real behavior: `(value) => typeof value === 'symbol'`, not a bare `vi.fn()`.
   - **`log` Union:** The helper's `log` object must include all 5 sub-methods used across the suite: `{ info, warn, message, success, error }`.
   - **Spinner Shape:** Standardize the spinner mock shape to support `.message()` calls and track created spinners.

2. **Telemetry Mock:**
   - Centralize the `vi.mock('../src/core/telemetry.js', ...)` implementations.
   - Mock `trackEvent`, `flushTelemetry` (with `mockResolvedValue()`), `trackSuccess`, and `trackFailure`. Ensure the success/failure mocks delegate to `trackEvent` correctly so existing success-path assertions don't break.
   - Pass through `isActiveEnvValue` using `importOriginal`.

3. **Other Duplication:**
   - Extract the recurring `process.exit`, `console.log`, and `console.error` spy trio.
   - Extract `tmpdir` fixture generation helpers.

## 4. Implementation Strategy
- Create clean, exportable mock factories in `tests/helpers/`.
- Iteratively migrate the applicable test files to use these new helpers via `vi.hoisted()`.
- Replace the duplicated inline `vi.mock()` blocks with one-liners delegating to the helper.
- **Reset Semantics:** Each file should maintain its own `vi.clearAllMocks()` or `vi.resetAllMocks()` in its `beforeEach` hook.

## 5. Acceptance Criteria
- `tests/helpers/` exists and contains the centralized mocks.
- No test file (except the explicitly excluded ones) retains a hand-rolled `@clack/prompts` or telemetry mock block.
- **Coverage Preservation:** ≥1,067 passing tests, with zero failures other than the known pre-existing `db.test.js` loopback port failure.