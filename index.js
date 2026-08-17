#!/usr/bin/env node
import { SecretsManagerClient, UpdateSecretCommand } from "@aws-sdk/client-secrets-manager";
import dotenv from "dotenv";
import fsSync from 'fs';
import { intro, outro, group, text, select, spinner, cancel, confirm } from '@clack/prompts';
import color from 'picocolors';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the CLI script (not the user's current working directory)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function mainStack() {
    // 1. Start the CLI
    intro(color.bgCyan(color.black(' create-cloud-stack ☁️  ')));

    // 2. Ask the user for project configuration
    const project = await group(
        {
            name: () =>
                text({
                    message: 'What is the name of your project? (Type "." to use current directory)',
                    placeholder: 'my-web-app',
                    validate: (value) => {
                        if (!value) return 'Please enter a name.';
                        if (value !== '.' && value.includes(' ')) return 'Name cannot contain spaces.';
                    },
                }),
            region: () =>
                select({
                    message: 'Which AWS region do you want to deploy to?',
                    options: [
                        { value: 'us-east-1', label: 'us-east-1 (N. Virginia)' },
                        { value: 'us-east-2', label: 'us-east-2 (Ohio)' },
                        { value: 'eu-west-1', label: 'eu-west-1 (Ireland)' },
                    ],
                }),
            port: () =>
                text({
                    message: 'What port does your container expose?',
                    placeholder: '3000',
                    defaultValue: '3000',
                }),
            framework: () =>
                select({
                    message: 'Which framework preset should we configure?',
                    options: [
                        { value: 'node', label: 'Node.js / Express' },
                        { value: 'nextjs', label: 'Next.js (Standalone)' },
                        { value: 'python', label: 'Python FastAPI' },
                    ],
                }),
        },
        {
            onCancel: () => {
                cancel('Operation cancelled.');
                process.exit(0);
            },
        }
    );

    // 3. Determine the target directory
    const targetDir = project.name === '.' ? process.cwd() : path.join(process.cwd(), project.name);

    // 4. Check for existing files that might be overwritten
    const dockerfilePath = path.join(targetDir, 'Dockerfile');
    const tfDirPath = path.join(targetDir, 'terraform');

    if (fsSync.existsSync(dockerfilePath) || fsSync.existsSync(tfDirPath)) {
        const overwrite = await confirm({
            message: color.yellow('⚠️  A Dockerfile or terraform/ folder already exists here. Overwrite them?'),
            initialValue: false,
        });

        if (!overwrite) {
            cancel('Scaffolding cancelled to protect existing files.');
            process.exit(0);
        }
    }

    const s = spinner();
    s.start('Scaffolding infrastructure...');

    // 5. Create project directories
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(targetDir, 'terraform'), { recursive: true });
    await fs.mkdir(path.join(targetDir, '.github', 'workflows'), { recursive: true });

    // 6. Read the template files
    const tfMainPath = path.join(__dirname, 'templates', 'terraform', 'main.tf');
    const tfNetworkPath = path.join(__dirname, 'templates', 'terraform', 'network.tf');
    const tfSecretsPath = path.join(__dirname, 'templates', 'terraform', 'secrets.tf');
    const dockerTemplatePath = path.join(__dirname, 'templates', 'docker', `${project.framework}.Dockerfile`);
    const githubActionPath = path.join(__dirname, 'templates', 'github', 'deploy.yml');

    let tfMain = await fs.readFile(tfMainPath, 'utf-8');
    let tfNetwork = await fs.readFile(tfNetworkPath, 'utf-8');
    let tfSecrets = await fs.readFile(tfSecretsPath, 'utf-8');
    let dockerContent = await fs.readFile(dockerTemplatePath, 'utf-8');
    let githubAction = await fs.readFile(githubActionPath, 'utf-8');

    // 7. Helper function to replace tokens everywhere
    const actualProjectName = project.name === '.' ? path.basename(process.cwd()) : project.name;

    const injectVariables = (content) => {
        return content
            .replace(/{{PROJECT_NAME}}/g, project.name)
            .replace(/{{REGION}}/g, project.region)
            .replace(/{{PORT}}/g, project.port);
    };

    tfMain = injectVariables(tfMain);
    tfNetwork = injectVariables(tfNetwork);
    tfSecrets = injectVariables(tfSecrets);
    dockerContent = injectVariables(dockerContent);
    githubAction = injectVariables(githubAction);

    // 8. Write the finalized files
    await fs.writeFile(path.join(targetDir, 'terraform', 'main.tf'), tfMain);
    await fs.writeFile(path.join(targetDir, 'terraform', 'network.tf'), tfNetwork);
    await fs.writeFile(path.join(targetDir, 'terraform', 'secrets.tf'), tfSecrets);
    await fs.writeFile(path.join(targetDir, 'Dockerfile'), dockerContent);
    await fs.writeFile(path.join(targetDir, '.github', 'workflows', 'deploy.yml'), githubAction);

    await fs.writeFile(path.join(targetDir, 'terraform', 'secret_keys.json'), "[]");

    s.stop('Infrastructure scaffolded successfully!');

    // 9. Provide the Outro / Next Steps
    outro(`
    ${color.green('✅ Project scaffolded successfully!')}
    
        Next steps:
        1. cd ${project.name}
        2. Deploy infrastructure:
           cd terraform && terraform init && terraform apply
        3. Push to GitHub:
           git init && git add . && git commit -m "Initial commit"
        4. Add your AWS credentials to GitHub Repo Secrets:
           - AWS_ACCESS_KEY_ID
           - AWS_SECRET_ACCESS_KEY
    `);
}

async function pushSecrets(envFilePath, projectName) {
    const s = spinner();
    s.start(`Reading ${envFilePath} and pushing to AWS Secrets Manager...`);

    try {
        // 1. Read and parse the local .env file
        const envPath = path.resolve(process.cwd(), envFilePath);
        const envContent = await fs.readFile(envPath, 'utf-8');
        const parsedSecrets = dotenv.parse(envContent);

        if (Object.keys(parsedSecrets).length === 0) {
            s.stop('No secrets found in file.');
            return;
        }

        // 2. Initialize the AWS Client
        // It automatically uses the AWS credentials the user set in their terminal
        const client = new SecretsManagerClient({});

        // 3. Update the secret string in AWS
        // The SecretId matches the name we generated in secrets.tf
        const command = new UpdateSecretCommand({
            SecretId: `${projectName}-secrets`,
            SecretString: JSON.stringify(parsedSecrets),
        });

        await client.send(command);

        const keys = Object.keys(parsedSecrets);
        const keysFilePath = path.join(process.cwd(), 'terraform', 'secret_keys.json');

        await fs.writeFile(keysFilePath, JSON.stringify(keys, null, 2));

        s.stop(`✅ Successfully pushed ${Object.keys(parsedSecrets).length} secrets to AWS!`);
        console.log(color.cyan(`\nUpdated ${keysFilePath}`));
        console.log(color.green('Commit this file and push to GitHub to trigger a deployment with your new variables.'));

    } catch (error) {
        s.stop(`❌ Failed to push secrets: ${error.message}`);
    }
}

// --- The Router ---
const args = process.argv.slice(2);

if (args[0] === 'secrets' && args[1] === 'push') {
    const envFile = args[2] || '.env';
    // In a real version, we'd read the project name from a config file, 
    // but for the POC we'll ask for it or assume the current directory name
    const projectName = path.basename(process.cwd());
    pushSecrets(envFile, projectName).catch(console.error);
} else {
    mainStack().catch(console.error);
}