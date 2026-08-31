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

    let secretsArray = [];

    if (config.NEEDS_DATABASE) {
        filesToProcess.push({ src: 'terraform/database.tf', dest: 'terraform/database.tf' });

        config.DB_ENV_VARS = `
        { "name": "DB_HOST", "value": "\${aws_db_instance.postgres.address}" },
        { "name": "DB_PORT", "value": "5432" },
        { "name": "DB_NAME", "value": "\${aws_db_instance.postgres.db_name}" }`;

        secretsArray.push(`{ "name": "DB_USER", "valueFrom": "\${aws_db_instance.postgres.master_user_secret[0].secret_arn}:username::" }`);
        secretsArray.push(`{ "name": "DB_PASSWORD", "valueFrom": "\${aws_db_instance.postgres.master_user_secret[0].secret_arn}:password::" }`);
    } else {
        config.DB_ENV_VARS = '';
    }

    // Build the initial HCL map for AWS Secrets Manager
    let initialSecretMap = `{\n    EXAMPLE_API_KEY = "replace_me_in_aws_console"`;

    // Inject Rails Master Key if applicable
    if (config.finalFramework === 'rails') {
        secretsArray.push(`{ "name": "RAILS_MASTER_KEY", "valueFrom": "\${aws_secretsmanager_secret.app_secrets.arn}:RAILS_MASTER_KEY::" }`);

        initialSecretMap += `,\n    RAILS_MASTER_KEY = var.rails_master_key`;

        const masterKeyPath = path.join(targetDir, 'config', 'master.key');
        if (fsSync.existsSync(masterKeyPath)) {
            const realKey = fsSync.readFileSync(masterKeyPath, 'utf-8').trim();
            const tfvarsPath = path.join(targetDir, 'terraform', 'secrets.auto.tfvars');
            fsSync.writeFileSync(tfvarsPath, `rails_master_key = "${realKey}"\n`);
        }
    }

    initialSecretMap += `\n  }`;

    config.TASK_SECRETS = secretsArray.join(',\n        ');
    config.INITIAL_SECRET_MAP = initialSecretMap;

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
            const appendIgnore = '\n# Added by deploy-stack (Terraform)\nterraform/.terraform/\nterraform/*.tfstate\nterraform/*.tfstate.backup\nterraform/.terraform.lock.hcl\nterraform/secret_keys.json\n.env\n';
            await fs.appendFile(targetGitignore, appendIgnore);
        }
    }

    // 6. Create .dockerignore to keep images lean and secure
    const dockerignorePath = path.join(targetDir, '.dockerignore');
    if (!fsSync.existsSync(dockerignorePath)) {
        const dockerignoreContent = `
.git/
.github/
terraform/
**/.terraform/
**/.terraform.*
**/*.tfstate*
.env
README.md
node_modules/
npm-debug.log
__pycache__/
*.pyc
.DS_Store
`.trim();
        await fs.writeFile(dockerignorePath, dockerignoreContent);
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
terraform/*.auto.tfvars
.env

# OS
.DS_Store
Thumbs.db
`;

    const presets = {
        node: '\n# Node.js\nnode_modules/\nnpm-debug.log\nyarn-error.log\n',
        nextjs: '\n# Next.js\nnode_modules/\n.next/\nout/\nbuild/\nnext-env.d.ts\n',
        nuxt: '\n# Nuxt 3\nnode_modules/\n.nuxt/\n.output/\ndist/\n',
        python: '\n# Python\n__pycache__/\n*.py[cod]\n*$py.class\nvenv/\nenv/\n.venv/\n.pytest_cache/\n',
        django: '\n# Django\n*.log\n*.pot\n*.pyc\n__pycache__/\ndb.sqlite3\nmedia/\n',
        go: '\n# Go\n/bin/\n/pkg/\n/obj/\n*.exe\n*.exe~*\n*.dll\n*.so\n*.dylib\n',
        rails: '\n# Rails\n/*.log\n/tmp/\n/log/\n/public/system/\n/public/assets/\n/vendor/bundle/\n',
        static: '\n# Static Sites\nnode_modules/\ndist/\nbuild/\nout/\n.output/\n.cache/\npublic/\n'
    };

    const frameworkIgnore = presets[framework] || '';
    return (baseIgnore + frameworkIgnore).trim();
}