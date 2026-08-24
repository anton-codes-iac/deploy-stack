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

    // 5. Handle .gitignore appending cleanly
    const targetGitignore = path.join(targetDir, '.gitignore');
    const gitignoreContent = await fs.readFile(path.join(templatesDir, '_gitignore'), 'utf-8');

    if (!fsSync.existsSync(targetGitignore)) {
        await fs.writeFile(targetGitignore, gitignoreContent);
    } else {
        const existingGitignore = await fs.readFile(targetGitignore, 'utf-8');
        if (!existingGitignore.includes('terraform/.terraform/')) {
            await fs.appendFile(targetGitignore, '\n# Added by deploy-stack (Terraform)\nterraform/.terraform/\nterraform/*.tfstate\nterraform/*.tfstate.backup\nterraform/.terraform.lock.hcl\nterraform/secret_keys.json\nterraform/.terraform.*\n');
        }
    }
}