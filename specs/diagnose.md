# Spec: `deploy-stack diagnose` (alias: `wtf`)

## Objective
Build a new CLI command that automatically queries AWS to troubleshoot why a deployed application is failing (e.g., container crash loops, ALB 502 Bad Gateway).

## Requirements
1. **Command Registration:** Register `diagnose` and its alias `wtf` in `bin/cli.js` using Commander.
2. **AWS SDK Integration:** Use `@aws-sdk/client-ecs` and `@aws-sdk/client-cloudwatch-logs` to:
   - Find the most recent stopped tasks in the ECS Fargate cluster.
   - Extract the `stoppedReason` (e.g., OutOfMemory, Essential container in task exited).
   - Fetch the last 50 lines of logs from CloudWatch for the failing container.
3. **Output:** Format the output beautifully using `picocolors`. Highlight the exact error clearly so the user doesn't have to dig through JSON.

## Constraints
- Mock the AWS SDK calls in the tests so they don't require real AWS credentials to pass.
- Do not modify the existing `apply` or `destroy` commands.