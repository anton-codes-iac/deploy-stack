# Spec: Continuous Infrastructure Validation Pipeline

## Objective
Create a GitHub Actions workflow that automatically generates, compiles, and security-scans our IaC templates across all supported frameworks to prevent regressions.

## Requirements
1. **Workflow Registration:** Create `.github/workflows/iac-validation.yml` triggered on push to `main` and all pull requests.
2. **Matrix Strategy:** Run tests across all 10 supported framework permutations: `nestjs`, `nextjs`, `nuxt`, `node`, `svelte`, `static`, `python`, `django`, `rails`, and `go`.
3. **Execution Steps:** For each framework in the matrix:
   - Scaffold the app: Run `node bin/cli.js --headless --preconfigured --framework=<matrix-framework>` in a temporary directory.
   - Terraform Compile: Run `terraform init -backend=false` followed by `terraform validate`.
   - Terraform Lint: Run `tflint` to catch deprecated syntax.
   - DevSecOps Scan: Run Trivy (via `aquasecurity/trivy-action`) to scan the generated `Dockerfile` and `terraform/` directory.

## Constraints
- The pipeline must execute completely offline without AWS credentials (hence `-backend=false`).
- Trivy must be configured to fail the build if it detects HIGH or CRITICAL vulnerabilities.