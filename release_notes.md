# 📚 The Documentation & Contextual UX Update

This patch release focuses entirely on Developer Experience (DX), ensuring that users migrating from PaaS platforms have clear, actionable documentation for AWS-native concepts right when they need them.

### 📖 What's New
* **PaaS Escape Hatch Guides:** Added step-by-step guides for decoupling frontend frameworks from Vercel's proprietary edge network:
  * **Next.js:** Enforcing `output: 'standalone'` for standard Docker deployments.
  * **SvelteKit:** Swapping `@sveltejs/adapter-auto` or the Vercel adapter for the official Node adapter.
  * **Astro:** Replacing `@astrojs/vercel` with `@astrojs/node`.
* **Comprehensive AWS Migration Guides:** Added dedicated documentation for our core backend engines:
  * **Heroku Migration:** Detailed breakdown of how `Procfile` `web` and `worker` processes map to AWS Fargate and private subnets.
  * **Secrets Management:** A deep dive into how `deploy-stack` leverages AWS Secrets Manager to inject environment variables at runtime.
  * **Database Scaffolding:** Explains our zero-trust PostgreSQL architecture and auto-injected connection strings.

### 🛠️ CLI UX Enhancements
* **Context-Aware Documentation Links:** The CLI now dynamically injects links to the relevant documentation at the exact moment a user might need it. 
  * If a Vercel-locked Next.js, SvelteKit, or Astro config is detected, the CLI links directly to the respective migration fix.
  * If a `Procfile` is detected, the `deploy-stack` outro links to the Heroku guide.
  * If a database is provisioned, the outro links to the database connection guide.
  * Running `deploy-stack secrets push` now outputs a direct link explaining how those secrets reach the Fargate containers.