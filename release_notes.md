# 🛡️ Hotfix: Node.js DevSecOps Hardening

This patch updates the default Node.js and Express Dockerfile templates to automatically resolve underlying OS and NPM vulnerabilities caught by Trivy during the CI/CD pipeline.

### 🐛 Security Fixes
* **Alpine OS Patching:** The template now runs `apk update && apk upgrade --no-cache` to immediately patch base image vulnerabilities (e.g., `libcrypto3`, `libssl3`).
* **NPM Updating:** The template now forces a global update to `npm@latest` to eliminate `tar`, `pacote`, and `brace-expansion` vulnerabilities native to the Node 22 base image.