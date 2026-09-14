# 0001. S3 Native State Locking

* **Status:** Accepted
* **Date:** 2026-08-15 (Retroactive)
* **Deciders:** Core Engineering Team

## Context and Problem Statement

When deploying infrastructure via Terraform across local developer workstations and automated CI/CD pipelines, remote state management is required to prevent race conditions, state drift, and concurrent apply corruption. 

Traditionally, managing Terraform remote state on AWS required provisioning both an S3 bucket (for storage) and a dedicated DynamoDB table (for state locking). This added operational overhead, increased the baseline AWS resource footprint, and required developers to manage extra IAM permissions solely for locking metadata.

## Decision Drivers

* **Simplicity:** Minimize the number of AWS resources a user has to provision and manage day-to-day.
* **Cost Efficiency:** Eliminate unnecessary idle infrastructure costs (e.g., DynamoDB provisioned capacity).
* **Reliability:** Guarantee that concurrent CI/CD pipeline runs and local CLI executions cannot corrupt Terraform state files.

## Considered Options

1. **S3 + DynamoDB Table:** The traditional HashiCorp recommendation for remote state locking.
2. **S3 Native State Locking:** Utilizing S3's native conditional write support for state locking directly within the S3 bucket backend.
3. **Third-Party State Backends:** (e.g., Terraform Cloud) — rejected to preserve zero-vendor-lock-in and keep execution local to the user's AWS account.

## Decision Outcome

**Chosen Option:** Use an encrypted Amazon S3 bucket as the remote state backend leveraging Terraform's native S3 state locking capabilities.

### Positive Consequences
* **Zero Maintenance:** Users do not have to monitor, manage, or pay for an extra DynamoDB table.
* **Tighter Security:** Simplifies the IAM policy scope required for the `deploy-stack` state bucket helper, adhering strictly to least privilege.
* **Frictionless Onboarding:** Streamlines the bootstrapping experience during the initial `npx deploy-stack` run.

### Negative Consequences
* Relies on modern Terraform backend behavior that supports S3 native locks. Edge cases involving highly outdated, legacy Terraform CLI versions are not supported.