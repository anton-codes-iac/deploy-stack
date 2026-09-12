# Secrets Management in deploy-stack

Managing `.env` files across a team and syncing them to the cloud is a notorious pain point. `deploy-stack` solves this by natively integrating with **AWS Secrets Manager**, ensuring zero plaintext secrets ever touch your GitHub repository or CI/CD pipelines.

## The Secrets Lifecycle

To maintain zero-secret Git repositories and safe infrastructure provisioning, secrets follow a strict 4-step lifecycle:

```text
1. Scaffold        ───▶  2. Provision Vault   ───▶  3. Push Secrets     ───▶  4. Deploy to App
(deploy-stack)           (deploy-stack apply)       (secrets push .env)       (git push)
Generates Terraform       Creates empty vault        Uploads encrypted keys    ECS container boots
& secret_keys.json        in AWS Secrets Mgr         & updates secret_keys     with injected env
```

---

### Step 1: Provision the Vault (Day 1)
Your Secrets Manager vault is declared in `terraform/secrets.tf`. Provision the base infrastructure first:

```bash
npx deploy-stack apply
```
*This creates an empty, secure secret vault named `<project-name>-secrets` in your AWS account.*

### Step 2: Push Secrets to AWS
Once the vault exists, push your local `.env` values directly to AWS:

```bash
npx deploy-stack secrets push .env
```

**What happens under the hood?**
1. The CLI reads your local `.env` file.
2. It encrypts the key-value pairs and pushes them securely into AWS Secrets Manager under your project's namespace (e.g., `my-project-secrets`).
3. It generates a local `terraform/secret_keys.json` file containing *only the names* of your keys (e.g., `["API_KEY", "STRIPE_SECRET"]`), **not the values**.

> 💡 **Tip:** The `secrets push` command takes the file path as the first argument. If you need to use other flags, ensure they are appended at the end of the command:
> `npx deploy-stack secrets push .env --any-other-flags`

### Step 3: Map Secrets into the Container
Commit the updated `terraform/secret_keys.json` and push to GitHub:

```bash
git add terraform/secret_keys.json
git commit -m "chore: map new secrets to ECS"
git push origin main
```

Terraform reads `secret_keys.json` during the GitHub Actions deployment and maps each key directly into your ECS Task Definition. When your Fargate container boots up, AWS injects the secret values into `process.env` (Node) or `os.environ` (Python) in memory.