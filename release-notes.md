# 🚀 Vercel Escape Hatch, Orchestrator Refactor & Advanced Telemetry

This release introduces the second half of our PaaS Migration Engine, focusing on seamlessly escaping Vercel's proprietary edge network, alongside an internal architectural cleanup.

### ✨ What's New
* **Vercel Edge Routing Migration:** `deploy-stack` now automatically parses `vercel.json` files. It natively translates Vercel edge redirects (301/302) and regex path matching directly into standard AWS Application Load Balancer Listener Rules.
* **Vendor Lock-In Detection:** The CLI now proactively analyzes framework configuration files (`next.config.mjs`, `svelte.config.js`, `astro.config.mjs`) during the pre-flight checks. It warns users if they are locked into Vercel-specific adapters and provides exact instructions on how to switch to standard Node/Standalone outputs for AWS containerization.

### 🛠️ Architecture & Telemetry
* **Core Orchestrator Refactor:** Stripped over 250 lines of business logic and UI prompting out of `init.js`, establishing a clean, strictly isolated `src/utils/` toolbox pattern for future PaaS parsers.
* **Wide Telemetry Payloads:** Upgraded the analytics engine to capture detailed execution context (CLI version, headless status, desired task counts, and specific migration vectors like Heroku/Vercel) to better map the user deployment funnel.

### 🐛 Bug Fixes
* **Next.js Standalone Enforcement:** Explicit warnings are now surfaced if a Next.js project is missing the critical `output: 'standalone'` directive before attempting to provision cloud resources.