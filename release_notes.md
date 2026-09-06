# 🐳 Docker Compose Translator

This release introduces the ability to automatically translate local `docker-compose.yml` environments into production-ready AWS ECS Fargate architectures.

### ✨ What's New
* **Docker Compose Parsing:** The CLI now automatically detects `docker-compose.yml` files. It extracts exposed ports to configure your Application Load Balancer natively without manual input.
* **Sidecar Container Support:** Services defined alongside your main web app (like Redis, Memcached, or background workers) are automatically translated into a multi-container ECS Task Definition. 
* **Localhost Routing:** Because sidecars are deployed within the same ECS Task, your application can communicate with them over `localhost`—mirroring your local Docker development experience in the cloud with zero latency.
* **Isolated CloudWatch Logging:** Sidecar containers are automatically provisioned with their own prefixed CloudWatch log streams (e.g., `ecs-redis`) for easy debugging.

### 📚 Documentation
* Linked the new `deploy-stack-docker-compose-example` repository in the main documentation to demonstrate the multi-container architecture.