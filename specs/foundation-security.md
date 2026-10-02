# Specification: Foundation & Security Closure

## 1. Overview
This sprint closes out the foundational capabilities of Grada before introducing `grada mcp` (Agent Server Mode). It eliminates the final flaky unit test (`db.test.js` `EPERM` sandbox bind failure), hardens the remaining single-stage Dockerfiles (`node`, `python`, `django`) using multi-stage Alpine builds, and updates existing documentation to reflect the `--headless` capabilities.

## 2. Boundaries & Constraints
- **COVERAGE:** The unit test suite must maintain a count of `≥ 1068` tests, but now pass 100% with zero failures. Snapshots must be updated.
- **DOCKER TEMPLATES:** Focus *only* on `templates/docker/node.Dockerfile`, `python.Dockerfile`, and `django.Dockerfile`. Do not use `distroless` (we must retain `alpine` shell access for ECS Exec). 
- **RUNTIME INTEGRITY:** Hardened Docker images must still successfully build and boot.

## 3. Implementation Targets

### A. Deterministic Suite (`db.test.js` Flake)
- **The Bug:** `tests/db.test.js` suffers from an `EPERM` bind failure in restricted CI sandboxes when trying to allocate local TCP loopback servers.
- **The Fix:** Fully mock the `net` module (`net.createServer`, `net.connect`) for both the allocation and the closed-port timeout tests. 
- **Constraint:** Ensure the mock simulates the connection delay/failure so the `pollUntil` retry loop and timeout logic in `src/utils/db-tunnel.js:80` are still fully exercised. Do not stub the loop itself.

### B. Multi-Stage Dockerfile Hardening
- **Node (`node.Dockerfile`):** Convert to a two-stage Alpine build. Stage 1 (`builder`) installs dependencies. Stage 2 (`runner`) copies the app code and production `node_modules`. 
  - *Entrypoint:* Use `CMD ["node", "index.js"]`. For custom scripts, rely on Grada's existing `PROCFILE.web` escape hatch.
- **Python / Django (`python.Dockerfile`, `django.Dockerfile`):** Convert to a two-stage Alpine build. Stage 1 (`builder`) creates a `venv` and runs `pip install`. 
  - *Venv Cleanup:* Run `pip uninstall -y pip setuptools` inside the venv before copying it to the next stage to completely eliminate the package manager.
  - *Runner Stage:* Stage 2 (`runner`) must `apk add --no-cache libpq` (and any required runtime libs), set `ENV PATH="/opt/venv/bin:$PATH"`, and `COPY --from=builder --chown=appuser:appgroup /opt/venv /opt/venv`.

### C. Docs Audit (Update Existing)
- **`apps/docs/src/content/docs/testing-strategy.md`**: Ensure Tier 0 (Mock/PR) and Tier 1 (Live/Nightly) E2E isolation (`CI_MOCK_AWS`, `AWS_ACCESS_KEY_ID` - remove OIDC reference) is accurately described.
- **`apps/docs/src/content/docs/guides/dockerfiles.md`**: Update to reflect that *all* templates (now including Node/Python) use multi-stage Alpine builds for minimal CVE footprints. Check for accuracy; no new files needed.

## 4. Acceptance Criteria
1. Running `npm test` yields `≥ 1068` passing tests with ZERO failures.
2. The `tests/generator.test.js` snapshots have been successfully updated (`npm run test:update`) to reflect the new Dockerfiles.
3. The `node`, `python`, and `django` templates are verified as multi-stage. A local `docker build` on these templates succeeds.
4. Existing documentation files accurately reflect the E2E architecture and Docker template state.