# 🧩 Framework Support & Quirks

`deploy-stack` is designed to be as "zero-config" as possible. However, because different frameworks have unique internal architectures (especially around network binding and build outputs), a few frameworks require minor application-level tweaks to run securely in a Dockerized AWS Fargate environment.

## The 3-Tier Support Philosophy

We handle framework requirements using a 3-tier strategy so you are never left guessing why a deployment failed:

1. **Zero-Touch Plugins (Tier 1):** If you use one of our ecosystem plugins (e.g., `nest add nest-deploy-stack` or `cookiecutter-django-deploy-stack`), your code is automatically patched and configured. Zero manual intervention required.
2. **Intelligent CLI Pre-flight (Tier 2):** If you run the standalone `deploy-stack` CLI against a raw repository, the CLI statically analyzes your code. If it detects a missing production requirement (like a localhost binding), it will flag it inline in your terminal with the exact copy-paste fix.
3. **In-Repo Docs (Tier 3):** The generated `DEPLOYMENT.md` file always contains a framework-specific checklist before you push to CI/CD.

---

## 🛠️ Framework Requirements Cheat Sheet

| Framework | What `deploy-stack` Automates | Application Code Requirement | Zero-Click Starter / Plugin |
|---|---|---|---|
| **Next.js** | Multi-stage Dockerfile, CloudFront edge routing, `vercel.json` parsing | `output: 'standalone'` must be set in `next.config.js` | Built-in CLI detection |
| **NestJS** | Multi-stage TypeScript build (`dist/`), unprivileged Node runtime | `await app.listen(port, '0.0.0.0')` in `src/main.ts` | `nest-deploy-stack` (`nest add`) |
| **FastAPI** | Alpine Python container, Uvicorn CLI args, unprivileged port mapping | None (0.0.0.0 set via Docker CMD) | `cookiecutter-fastapi-deploy-stack` |
| **Django** | Gunicorn WSGI adapter, Celery worker topologies, RDS bindings | None (0.0.0.0 set via Docker CMD) | `cookiecutter-django-deploy-stack` |
| **Ruby on Rails** | Puma adapter, `.auto.tfvars` Master Key injection, Kamal Dockerfile replaced with 0-CVE Alpine build | None (0.0.0.0 set via Docker CMD) | `rails-template-deploy-stack` |
| **Nuxt 3** | Nitro-optimized Node output | None (`NITRO_HOST=0.0.0.0` injected automatically) | `nuxt-deploy-stack` |
| **SvelteKit** | Node adapter conversion | None (`HOST=0.0.0.0` injected automatically) | `svelte-adapter-deploy-stack` |
| **Static Sites** *(Vite, Astro, React)* | Output folder detection (`dist/`, `build/`), Nginx routing | None | `vite-plugin-deploy-stack` |

## ⚠️ The Golden Rule: 0.0.0.0 vs Localhost

The most common reason a newly deployed container fails its ALB health check is network binding. 

In local development, frameworks bind to `localhost` (or `127.0.0.1`) for security. However, inside a Docker container on AWS ECS, binding to `localhost` means the web server only listens to internal container traffic. The AWS Application Load Balancer (ALB) trying to route traffic from the outside world will hit a closed port, resulting in a `502 Bad Gateway` or `503 Service Temporarily Unavailable`.

**Always ensure your application explicitly binds to `0.0.0.0`.**