# 0004. IaC-Driven Diagnostic Context (Stateless CLI)

* **Status:** Accepted
* **Date:** 2026-09-19

## Context and Problem Statement

To provide a seamless developer experience, the `deploy-stack diagnose` command needs to automatically fetch CloudWatch logs and ECS task failures without requiring the user to manually input their AWS Region, Cluster Name, or Log Group. 

We needed a mechanism to persist or infer the deployment context locally so the CLI knows where to look for errors.

## Decision Drivers

* **Statelessness:** The CLI should avoid managing internal database files or proprietary local state files that can fall out of sync with actual infrastructure.
* **Single Source of Truth:** Terraform is already the declarative source of truth for the project's infrastructure.
* **Ecosystem Compatibility:** Developers often delete node_modules or switch laptops; context retrieval must survive typical Git workflows.

## Considered Options

1. **Local State File:** Create a `.deploy-stack/context.json` file upon generation. (Rejected: creates state drift and pollutes version control).
2. **AWS Tag Querying:** Use the AWS SDK to query all clusters for a specific tag. (Rejected: too slow, requires broad IAM `ListClusters` permissions, and fails if multiple environments exist).
3. **IaC Parsing (Stateless):** Parse the generated `terraform/main.tf` to extract the AWS Region and infer the cluster name from the local directory structure.

## Decision Outcome

**Chosen Option:** IaC Parsing (Stateless). The `diagnose` command reads the AWS Region directly via regex from `terraform/main.tf` and constructs standard AWS resource names based on the current working directory.

### Positive Consequences
* The CLI remains entirely stateless. If the Terraform files exist, the diagnostics work.
* Enforces the architectural philosophy that the generated IaC is the ultimate source of truth.
* Zero additional files are added to the user's repository.

### Negative Consequences
* If a user manually alters the `region` string inside `main.tf` using non-standard formatting, the regex parser may fail to detect it, falling back to a default region.