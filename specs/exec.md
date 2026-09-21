# Spec: 1-Click Container Access (exec)

## Objective
Implement `npx deploy-stack exec` to automatically drop the user into a secure, interactive shell inside their running AWS Fargate container using ECS Exec. 

## 1. Infrastructure Updates (Terraform)
To allow ECS Exec, the Fargate tasks need SSM permissions and the service needs a specific flag enabled.
- **Update `templates/terraform/main.tf` (and any other relevant tf files):**
  - Add `enable_execute_command = true` to the `aws_ecs_service` resource.
  - Ensure the `aws_iam_role.ecs_task_role` (the role the container runs as, NOT the execution role) has the following permissions:
    - `ssmmessages:CreateControlChannel`
    - `ssmmessages:CreateDataChannel`
    - `ssmmessages:OpenControlChannel`
    - `ssmmessages:OpenDataChannel`

## 2. CLI Implementation (`src/commands/exec.js`)
- **Auto-Discovery:** Use `@aws-sdk/client-ecs` to dynamically find the active Cluster, Service, and a running Task ARN based on the current project directory.
- **Interactive Shell:** Use Node's `child_process.spawn` with `stdio: 'inherit'` to execute the AWS CLI command: 
  `aws ecs execute-command --cluster <cluster> --task <task_arn> --container <container_name> --interactive --command "/bin/sh"`
- **Prerequisite Checks:** Before spawning, quickly verify the user has the `aws` CLI installed (since ECS Exec relies on the AWS CLI and the Session Manager plugin under the hood). If missing, print a friendly error with a link to install it.
- **Error Handling:** If no tasks are running (e.g., scale is 0 or crashing), exit gracefully using `picocolors` and `@clack/prompts` explaining that a running container is required.

## 3. Testing & Wiring
- Add `exec` to `bin/cli.js`.
- Create `tests/exec.test.js` using `vitest` to mock the ECS client and the `spawn` call, ensuring the correct AWS CLI arguments are constructed and prerequisite failures are handled smoothly.