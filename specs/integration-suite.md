# Spec: Integration Stability Suite (Headless Contracts)

## Objective
Expand our Vitest coverage to guarantee that `deploy-stack` can be consumed by automated scripts and ecosystem wrappers (like `nest-deploy-stack`) without hanging on interactive prompts.

## Requirements
1. **Target:** Create a new test file at `tests/headless.test.js`.
2. **Mocking:** Deep-mock `@clack/prompts` using `vi.mock()`.
3. **Execution Assertions:** 
   - Execute the core CLI generation logic passing `--headless` and `--preconfigured` alongside necessary configuration flags (e.g., `--framework=nestjs --port=3000`).
   - Assert that the mocked prompt functions (`text`, `select`, `confirm`, etc.) are **never** called during execution.
4. **Output Assertions:** Ensure the CLI correctly applies the values passed via the flags rather than falling back to interactive defaults.

## Constraints
- The test suite must run purely in memory or within a temporary directory to avoid polluting the local development environment with generated Terraform files.
- It must execute quickly alongside the existing snapshot tests.