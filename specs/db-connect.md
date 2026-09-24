# Phase 9: Secure Database Tunneling & Doc Alignment

## Part 1: Fix Existing Logic & Documentation Gaps
Address the three misalignments identified between the generated code and the documentation.

**1. SvelteKit Database Prompt (Logic Gap):**
* In `src/utils/prompts.js`, update the `isBackendFramework` check to include `'svelte'`. Currently, SvelteKit users are not prompted for a database even though it is a full-stack framework.

**2. Connection String Clarity (Doc Gap):**
* In `apps/docs/src/content/docs/guides/database-connections.md`, change "Standard environment variables" to "deploy-stack injected variables".
* Add a brief explanation and a code block demonstrating how the user should construct their framework's connection string from these variables (e.g., `DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"`).

**3. Minor Wording Fixes:**
* In `apps/docs/src/content/docs/guides/database-connections.md`, update "Your auto-generated database name" to "Your deterministic database name".
* In `templates/README.md`, update "DB_USER: The auto-generated master username" to "DB_USER: The hardcoded master username (dbadmin)".

## Part 2: Implement `deploy-stack db connect`
Create a new command that securely tunnels from the developer's localhost directly to the isolated RDS instance via an active ECS container.

**1. Dependencies & CLI Plumbing:**
* Add `@aws-sdk/client-rds` to `package.json` dependencies. Pin the version to match the existing AWS SDKs (e.g., `3.1119.0`).
* Extract `resolveRegion`, `resolveProjectName`, `resolveCluster`, and `resolveService` from `src/commands/exec.js` into a new shared module: `src/utils/resolvers.js`. 
  * Update `src/commands/exec.js` to import them from here.
  * **Critical Test Fix:** Update `tests/exec.test.js` to import these functions from `../src/utils/resolvers.js` instead of `exec.js`.
  * **Scope Limit:** Leave the identical resolver functions inside `logs.js`, `status.js`, and `gc.js` completely untouched.
* Update `bin/cli.js` to parse the `db` command and add a HELP_TEXT line for it (e.g., `  db connect           Open a secure local tunnel to your database`).
* If the user types `deploy-stack db` with no subcommand, print the `db connect` usage and exit non-zero (do not fall through to the scaffold/init flow).
* If the argument is `connect`, route it to `runDbConnect` exported from `src/commands/db.js`.
* Implement `parseDbArgs` in `src/commands/db.js` to support:
  * `--port`: Validate this is purely numeric. Default to `5432`.
  * `--show-credentials`: Boolean.
  * Overrides: `--region`, `--cluster`, `--service`, and `--workspace`.

**2. AWS Resource Discovery (`src/commands/db.js`):**
* **Preconditions:** Reuse the `hasAwsCli` check (and Session Manager plugin guidance) before attempting the connection.
* **Resolve Names:** Use the shared resolvers. If a `--workspace` is provided (or if you detect one locally by reading `.terraform/environment`), append `-${workspace}` to the base project name so it correctly targets PR-preview resources (e.g., `${baseProjectName}-${workspace}-db`). If it's the default workspace, do not append anything.
* **Find the DB:** Query RDS `DescribeDBInstances` for the resolved DB identifier. 
  * *Edge Case:* If this throws `DBInstanceNotFound` (or if no DB is found), catch it and print a friendly, graceful exit message explaining that no database is provisioned for this environment.
  * Extract the `Endpoint.Address`, `DBName`, and `MasterUserSecret.SecretArn`.
* **Fetch the Credentials:** Query Secrets Manager `GetSecretValue` using the `SecretArn`. Parse the returned JSON string to dynamically extract both `username` and `password`.
* **Find an ECS Task:** Query ECS `ListTasks` for the resolved cluster and service. Call `DescribeTasks` on the first returned task ARN. 
  * *Robustness:* Instead of blindly taking `containers[0]`, use the same logic as `exec.js`: find the expected container by name, or fallback to the first `RUNNING` container, then extract its `runtimeId`.

**3. Terminal Output & Security:**
Print a clear success message so the user can easily copy the credentials:
* Print the Local Host, Local Port, Database Name, and Username.
* **Security Check:** Unless the user passed `--show-credentials`, mask the password in the terminal output as `********`. If the flag is present, print the decrypted password.
* Print a fully formed connection string (also masking the password unless the flag is passed):
  `postgresql://<username>:<password_or_mask>@localhost:<localPort>/<dbname>`

**4. Execute the SSM Tunnel:**
* Spawn the `aws` CLI as a child process using `spawn` (inheriting `stdio: 'inherit'`).
* Construct the arguments as an array to prevent Windows parsing errors:
  ```javascript
  const ssmArgs = [
      'ssm', 'start-session',
      '--target', `ecs:${clusterName}_${taskId}_${runtimeId}`,
      '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
      '--parameters', `{"host":["${dbHost}"],"portNumber":["5432"],"localPortNumber":["${localPort}"]}`,
      '--region', region
  ];
  ```
* Wrap the flow in the standard error handling. Explicitly check for `UnrecognizedClientException` and `ExpiredTokenException` to trigger the centralized `aws sso login` guidance. Handle the specific case where no running ECS tasks are found.
* Fire a telemetry event named `db_connect_run`. **CRITICAL:** Explicitly ensure that the database password, username, and connection string are NEVER included in the telemetry event properties.

**5. Additional Deliverables:**
* Create `tests/db.test.js` with fully hoisted mocks for the AWS SDKs (`RDSClient`, `ECSClient`, `SecretsManagerClient`) and `spawn`. Verify the masking logic, missing DB logic, workspace resolution, and successful arg construction.
* Create a documentation page at `apps/docs/src/content/docs/cli/db.md` explaining the `db connect` command, the `--port` flag, the `--show-credentials` flag, and the override flags (`--workspace`, `--region`, `--cluster`, `--service`).
* **Doc Registration:** Update `apps/docs/astro.config.mjs` to register the new `db.md` page in the `sidebar` array under the CLI Reference section.