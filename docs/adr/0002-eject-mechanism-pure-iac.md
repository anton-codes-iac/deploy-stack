# 0002. Eject Mechanism for Pure IaC

* **Status:** Accepted
* **Date:** 2026-08-20 (Retroactive)
* **Deciders:** Core Engineering Team

## Context and Problem Statement

`deploy-stack` abstracts away the complexity of writing raw Terraform for ECS Fargate, ALBs, CloudFront, OIDC, and Secrets Manager. However, a primary reason senior platform teams hesitate to adopt deployment generators is the fear of **tool lock-in**. Teams need a guarantee that if their architecture outgrows the CLI, or if they wish to take 100% manual control of the codebase, they can do so without starting from scratch.

## Decision Drivers

* **Zero Vendor Lock-In:** Uphold the foundational promise that developers permanently own their infrastructure code.
* **Auditability & Freedom:** Provide teams with an unambiguous "escape hatch" to sever ties with `deploy-stack` management metadata while maintaining a perfectly functioning infrastructure pipeline.

## Considered Options

1. **No Eject Command:** Require users to manually delete `ManagedBy` tags and untangle state/workflows by hand.
2. **Submodule / Framework Wrapper:** Keep the Terraform code hidden inside a remote module (rejected, as it violates the core premise of transparent, readable IaC).
3. **Explicit `eject` Command:** Build a dedicated `npx deploy-stack eject` utility that strips all CLI metadata and tracking tags, leaving behind clean, standard Terraform and GitHub Actions files.

## Decision Outcome

**Chosen Option:** Implement an explicit `npx deploy-stack eject` command as a core feature.

### Technical Implementation Details
When invoked, `eject`:
* Removes or sanitizes internal `ManagedBy = "deploy-stack"` default tags across all generated files.
* Preserves all generated `.tf`, `Dockerfile`, and `.github/workflows/` files safely in place.
* Detaches the project from the CLI entirely, leaving valid Terraform code that can be managed directly via the `terraform` or `opentofu` binaries.

### Positive Consequences
* Builds trust with engineers and security teams who refuse black-box wrappers.
* Eliminates friction during adoption; users know they can safely leave at any time.

### Negative Consequences
* Ejected repositories permanently lose access to automated security patches, template updates, or CLI-driven drift synchronization.