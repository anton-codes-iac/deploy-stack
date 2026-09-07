import fsSync from 'fs';

export const getBaseRules = (context = {}) => `
# deploy-stack Infrastructure Context

This project's AWS infrastructure is managed strictly by the \`deploy-stack\` CLI. 
**DO NOT** generate custom Terraform, AWS CloudFormation, or raw AWS CLI commands to deploy this application or modify the architecture.

### Standard Operating Procedures

1. **Applying Changes:** If the user asks to deploy, provision, or update the infrastructure, instruct them to run:
   \`npx deploy-stack apply\`

2. **Environment Variables:** If the user adds a new environment variable and needs it available in production, instruct them to run:
   \`npx deploy-stack secrets push <path-to-env-file>\`

3. **Teardown:** If the user wants to destroy the AWS environment, instruct them to run:
   \`npx deploy-stack destroy\`

4. **Architecture Details:** 
   - **AWS Region:** \`${context.region || 'Unknown (Check terraform/main.tf)'}\`
   - **Container Port:** \`${context.port || 'Unknown'}\`
   - The infrastructure is an AWS ECS Fargate cluster.
   - It uses an Application Load Balancer (ALB).
   - CI/CD is handled securely via GitHub Actions OIDC (no long-lived IAM keys).
   - Preview environments (Ephemeral PRs) are managed via Terraform Workspaces.
`;

export const getCursorRules = (context = {}) => `---
description: "Rules for deploying the application and managing AWS infrastructure"
globs: ["terraform/*.tf", ".github/workflows/*.yml", "Dockerfile"]
---${getBaseRules(context)}`;

export function injectManagedBlock(filePath, content, isMarkdown = true) {
    const beginMarker = isMarkdown ? '<!-- BEGIN DEPLOY-STACK CONTEXT -->' : '# BEGIN DEPLOY-STACK CONTEXT';
    const endMarker = isMarkdown ? '<!-- END DEPLOY-STACK CONTEXT -->' : '# END DEPLOY-STACK CONTEXT';
    const block = `\n${beginMarker}\n${content.trim()}\n${endMarker}\n`;

    if (fsSync.existsSync(filePath)) {
        let fileContent = fsSync.readFileSync(filePath, 'utf8');
        // Look for the existing block to replace it
        const regex = new RegExp(`\\n?${beginMarker}[\\s\\S]*?${endMarker}\\n?`);

        if (regex.test(fileContent)) {
            fileContent = fileContent.replace(regex, block); // Replace our old rules
        } else {
            fileContent = fileContent.trim() + '\n' + block; // Append to bottom
        }
        fsSync.writeFileSync(filePath, fileContent);
    } else {
        // File doesn't exist, create it cleanly
        fsSync.writeFileSync(filePath, block.trim() + '\n');
    }
}