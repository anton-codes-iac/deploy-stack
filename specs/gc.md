# Spec: Orphaned Resource Garbage Collection (`gc`)

## Overview
The `gc` (Garbage Collection) command protects the user's AWS bill by scanning for lingering, orphaned infrastructure left behind by failed deployments, deleted PR previews, or manual AWS Console interventions.

## UX & Flow
1. Run `npx deploy-stack gc`.
2. The CLI enters a "Dry Run / Discovery" phase, showing a spinner while it scans specific AWS services.
3. It presents a categorized list of orphaned resources found, along with an estimated cost-saving or disk-space reclaimed.
4. CLI prompts the user: `Are you sure you want to permanently delete these orphaned resources? (y/N)`.
5. If confirmed, it deletes them and outputs a success summary.

## Scan Targets (The Scope)
* **Target 1: Untagged ECR Images:** Find all images in ECR repositories matching the project prefix (`<project-name>-*`) that lack a tag, and batch delete them.
* **Target 2: Orphaned CloudWatch Log Groups:** Find log groups starting with `/ecs/<project-name>-` where the corresponding ECS cluster or service no longer exists.
* **Target 3: Unattached Elastic IPs (EIPs):** Find any EIPs in the VPC that are not associated with a running NAT Gateway or EC2 instance (to stop the hourly unused EIP charge).

## Technical Contract
* **File:** `src/commands/gc.js`
* **Dependencies:** `@aws-sdk/client-ecr`, `@aws-sdk/client-cloudwatch-logs`, `@aws-sdk/client-ec2`, `@clack/prompts`.
* **Safety First:** The command must *never* delete a resource without explicit interactive confirmation. There is no `--yes` flag for this command to prevent CI pipeline accidents.

## Test Requirements (`tests/gc.test.js`)
* Mock AWS SDKs to return a mix of active and orphaned resources.
* Prove that the dry-run output accurately counts only the orphaned resources.
* Prove that rejecting the confirmation prompt prevents any `Delete*` commands from firing.