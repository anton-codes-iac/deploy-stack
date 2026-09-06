# 📝 Architecture Overview & Vercel Example

This patch release improves the documentation generated for end-users and adds the Vercel migration reference implementation to our ecosystem.

### 📖 What's New
* **Template Architecture Overview:** The auto-generated `README.md` placed in user repositories now includes a high-level "Architecture Overview". This ensures developers understand the AWS topology (ECS Fargate, ALB, IAM OIDC, S3 State) they just provisioned before diving into deployment commands.
* **Vercel Example Linked:** Officially linked the `deploy-stack-vercel-nextjs-example` repository in the main project README, providing users a direct reference for migrating edge routing (`vercel.json`) and Next.js standalone configurations to AWS.