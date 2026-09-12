# 📦 Reference Implementations & Examples

These repositories demonstrate how `deploy-stack` handles various frameworks and architectural patterns. Each example includes the auto-generated Terraform, GitHub Actions, and container configurations.

### Featured Migrations
* **[Heroku to AWS Migration (Django)](https://github.com/anton-codes-iac/deploy-stack-heroku-django-example):** A classic Heroku-style monolith migrated via the Procfile Importer, demonstrating a multi-container Web and Celery Worker architecture deployed from a single codebase.
* **[Vercel to AWS Migration (Next.js)](https://github.com/anton-codes-iac/deploy-stack-vercel-nextjs-example):** Demonstrates automatic translation of Vercel edge routing (`vercel.json`) to native AWS Application Load Balancer rules.
* **[Docker Compose to AWS Migration](https://github.com/anton-codes-iac/deploy-stack-docker-compose-example):** Demonstrates automatic translation of local `docker-compose.yml` sidecars (like Redis) into a multi-container AWS ECS Task Definition communicating over `localhost`.

### DevSecOps & Security Architectures
* **[Zero-Secret AWS Secrets Manager Injection](https://github.com/anton-codes-iac/deploy-stack-secrets-example):** A production-grade Node.js architecture demonstrating zero-plaintext secret injection. It pushes local `.env` variables directly to AWS and maps them into ECS memory at runtime, exposing a live endpoint querying GitHub's API.

### Frontend & Fullstack Frameworks
* **[Next.js Fullstack App](https://github.com/anton-codes-iac/deploy-stack-nextjs-example):** A complete Next.js deployment showcasing the generated Terraform, CloudFront setup, and automated OIDC workflow.
* **[Vite / React SPA](https://github.com/anton-codes-iac/deploy-stack-vite-example):** Demonstrates SPA routing and `dist/` auto-detection.
* **[Create React App](https://github.com/anton-codes-iac/deploy-stack-cra-example):** Validates backward compatibility with legacy Webpack pipelines and `build/` auto-detection.
* **[Astro Static Site](https://github.com/anton-codes-iac/deploy-stack-astro-example):** Demonstrates modern static site generation (SSG).
* **[SvelteKit Application](https://github.com/anton-codes-iac/deploy-stack-svelte-example):** Demonstrates static adapter integration and custom output folder detection.
* **[Nuxt 3 (SSR)](https://github.com/anton-codes-iac/deploy-stack-nuxt-example):** Demonstrates a fully server-side rendered Nuxt application using Nitro's optimized Node output.

### Backend APIs & Monoliths
* **[Express.js API](https://github.com/anton-codes-iac/deploy-stack-express-example):** A standard Node.js backend setup.
* **[Python FastAPI](https://github.com/anton-codes-iac/deploy-stack-fastapi-example):** A Python API demonstrating unprivileged port mapping.
* **[Ruby on Rails](https://github.com/anton-codes-iac/deploy-stack-rails-example):** A production Rails 7+ setup featuring an auto-provisioned PostgreSQL database and secure `.auto.tfvars` Master Key injection.
* **[Django / Python](https://github.com/anton-codes-iac/deploy-stack-django-example):** A secure Gunicorn/WSGI implementation with PostgreSQL and unprivileged container adapters.
* **[Go / Fiber](https://github.com/anton-codes-iac/deploy-stack-go-example):** A distroless, compiled Go binary deployment demonstrating ultra-low memory footprints and instant boot times.

---

## 🧩 Ecosystem Plugins & Starters

In addition to standalone reference repositories, `deploy-stack` provides native integrations that hook directly into framework build pipelines and community template engines:

* **[astro-deploy-stack](https://www.npmjs.com/package/astro-deploy-stack):** Push-button deployment plugin for Astro sites.
* **[nuxt-deploy-stack](https://www.npmjs.com/package/nuxt-deploy-stack):** Nitro-optimized deployment integration for Nuxt 3 applications.
* **[vite-plugin-deploy-stack](https://www.npmjs.com/package/vite-plugin-deploy-stack):** Zero-config Vite build plugin for single-page applications.
* **[svelte-adapter-deploy-stack](https://www.npmjs.com/package/svelte-adapter-deploy-stack):** Native SvelteKit adapter producing optimized Fargate container builds.
* **[cookiecutter-django-deploy-stack](https://github.com/anton-codes-iac/cookiecutter-django-deploy-stack):** Community Django starter listed on [Django Packages](https://djangopackages.org/packages/p/cookiecutter-django-deploy-stack/) with built-in Fargate and managed RDS scaffolding.