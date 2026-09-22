# Spec: Secrets Pull and Audit Commands

## 1. Overview
Introduce two new CLI commands to manage Day-2 configuration drift:
- `npx deploy-stack secrets pull`: Fetches the JSON payload from AWS Secrets Manager and merges it into the local `.env` file.
- `npx deploy-stack secrets audit`: Compares the local `.env` file against the remote AWS Secrets Manager payload and displays a colored drift report (missing locally, missing remotely, conflicting values).

## 2. CLI Interface & UX
Both commands must use `@clack/prompts` and `picocolors` to match the existing CLI design system.

### `secrets pull`
- **Command:** `npx deploy-stack secrets pull [file]` (defaults to `.env`).
- **Flow:**
  1. Show a spinner: "Fetching secrets from AWS..."
  2. If the local `.env` file exists and has conflicting values, use Clack's `confirm` prompt to ask: "Conflicting variables found. Overwrite local values with remote?"
  3. If headless (`--headless`), automatically overwrite.
  4. Write/append the variables to the `.env` file in standard `KEY="VALUE"` format.
  5. Show an outro: "Successfully synced X secrets to .env".

### `secrets audit`
- **Command:** `npx deploy-stack secrets audit [file]` (defaults to `.env`).
- **Flow:**
  1. Show a spinner: "Auditing local environment against AWS..."
  2. Parse local `.env` and fetch the remote JSON secret.
  3. Print a visual diff:
     - Use green for keys only present in AWS (Missing locally).
     - Use yellow for keys with mismatched values.
     - Use gray/dim for keys only present locally (Not tracked in AWS).
  4. Show an outro summarizing the drift count.

## 3. AWS SDK v3 Integration
- Use `@aws-sdk/client-secrets-manager` (`GetSecretValueCommand`).
- The secret name convention should match the one established in `secrets push` (e.g., `<projectName>-secrets`).
- Handle `ResourceNotFoundException` gracefully by informing the user that no remote secrets exist yet and suggesting they run `secrets push` first.

## 4. File System & Parsing
- Use the built-in `fs` module to read and write `.env`.
- To parse the `.env` file safely, you can either implement a standard regex parser or use a lightweight zero-dependency approach. Do not introduce bloated dependencies if a simple parser suffices.
- When writing to `.env`, preserve existing local variables that do not exist in AWS. Do not delete local-only overrides unless explicitly instructed.

## 5. Telemetry
- Call `trackEvent('secrets_pull', { projectName, variablesCount })`.
- Call `trackEvent('secrets_audit', { projectName, driftCount })`.
- Await `flushTelemetry()` before exiting.

## 6. Testing Requirements (Strictly Headless)
- Add tests in a new file (e.g., `test/secrets-pull.test.js`).
- Use `vitest`.
- **Deep Mocking Required:** You must completely mock `fs` (or use a temp directory), `@clack/prompts`, and `@aws-sdk/client-secrets-manager`.
- The test suite must not pause for user input. Simulate the `confirm` prompt returning both `true` and `false`.
- Ensure tests run at 0 CVEs and pass in a clean CI environment.