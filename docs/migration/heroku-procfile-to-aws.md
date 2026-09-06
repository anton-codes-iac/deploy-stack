# Migrating from Heroku to AWS (Procfile Support)

When migrating from Heroku or Render, you likely rely on a `Procfile` to define your application's architecture (e.g., a web server and a background worker like Celery or Sidekiq). 

`deploy-stack` natively understands Heroku `Procfile` syntax and automatically translates it into a production-grade, multi-container AWS architecture.

## How it Works

When you run `npx deploy-stack`, the CLI scans your root directory for a `Procfile`. 

### The `web` Process
If the CLI detects a `web:` declaration:
1. It overrides the default Docker `CMD`.
2. It provisions an AWS ECS Fargate service for this process.
3. It automatically wires this specific container to your public-facing Application Load Balancer (ALB) so it can receive internet traffic.

### The `worker` Process
If the CLI detects a `worker:` declaration:
1. It generates a completely separate ECS Fargate task definition (`worker.tf`).
2. It spins up the worker in a **fully isolated private subnet**.
3. It intentionally strips all public ingress, ensuring your background workers are secure and can only communicate with your database or message brokers internally.

## Example

**Your `Procfile`:**
```text
web: gunicorn myapp.wsgi
worker: celery -A myapp worker -l info
```

**The Result:**
Running `deploy-stack` will automatically generate the Terraform required to spin up both containers simultaneously from the exact same Docker image, scaling them independently based on your needs.