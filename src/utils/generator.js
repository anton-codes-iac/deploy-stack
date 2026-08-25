import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function generateTemplates(targetDir, config) {
    // 1. Create directories
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(targetDir, 'terraform'), { recursive: true });
    await fs.mkdir(path.join(targetDir, '.github', 'workflows'), { recursive: true });

    // 2. Define paths
    const templatesDir = path.join(__dirname, '../../templates');
    const filesToProcess = [
        { src: 'terraform/main.tf', dest: 'terraform/main.tf' },
        { src: 'terraform/network.tf', dest: 'terraform/network.tf' },
        { src: 'terraform/secrets.tf', dest: 'terraform/secrets.tf' },
        { src: 'terraform/oidc.tf', dest: 'terraform/oidc.tf' },
        { src: 'terraform/backend.tf', dest: 'terraform/backend.tf' },
        { src: 'terraform/cloudfront.tf', dest: 'terraform/cloudfront.tf' },
        { src: `docker/${config.finalFramework}.Dockerfile`, dest: 'Dockerfile' },
        { src: 'github/deploy.yml', dest: '.github/workflows/deploy.yml' },
        { src: 'README.md', dest: 'README.md' }
    ];

    // 3. Process standard files
    for (const file of filesToProcess) {
        let content = await fs.readFile(path.join(templatesDir, file.src), 'utf-8');

        // Inject variables
        for (const [key, value] of Object.entries(config)) {
            content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
        }

        await fs.writeFile(path.join(targetDir, file.dest), content);
    }

    // 4. Create empty secrets file
    await fs.writeFile(path.join(targetDir, 'terraform', 'secret_keys.json'), "[]");

    // 5. Handle .gitignore dynamically based on framework
    const targetGitignore = path.join(targetDir, '.gitignore');

    if (!fsSync.existsSync(targetGitignore)) {
        await fs.writeFile(targetGitignore, getGitignoreContent(config.finalFramework));
    } else {
        const existingGitignore = await fs.readFile(targetGitignore, 'utf-8');
        if (!existingGitignore.includes('terraform/.terraform/')) {
            const appendIgnore = '\n# Added by deploy-stack (Terraform)\nterraform/.terraform/\nterraform/*.tfstate\nterraform/*.tfstate.backup\nterraform/.terraform.lock.hcl\nterraform/secret_keys.json\nterraform/.terraform.*\n.env\n';
            await fs.appendFile(targetGitignore, appendIgnore);
        }
    }
}

function getGitignoreContent(framework) {
    const baseIgnore = `
# Infrastructure (deploy-stack)
terraform/.terraform/
terraform/*.tfstate
terraform/*.tfstate.backup
terraform/.terraform.lock.hcl
terraform/secret_keys.json
terraform/.terraform.*
.env

# OS
.DS_Store
Thumbs.db
`;

    const nodeIgnore = `
# Node.js
node_modules/
npm-debug.log
yarn-error.log
`;

    const nextjsIgnore = `
# Next.js
node_modules/
.next/
out/
build/
next-env.d.ts
`;

    const pythonIgnore = `
# Python
__pycache__/
*.py[cod]
*$py.class
venv/
env/
.venv/
.pytest_cache/
`;

    const staticIgnore = `
# Static Sites
node_modules/
dist/
build/
out/
.output/
.cache/
public/
`;

    let frameworkIgnore = '';
    if (framework === 'node') frameworkIgnore = nodeIgnore;
    if (framework === 'nextjs') frameworkIgnore = nextjsIgnore;
    if (framework === 'python') frameworkIgnore = pythonIgnore;
    if (framework === 'static') frameworkIgnore = staticIgnore;

    return (baseIgnore + frameworkIgnore).trim();
}