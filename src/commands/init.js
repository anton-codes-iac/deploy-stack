import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand } from '@aws-sdk/client-s3';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { intro, outro, group, text, select, spinner, cancel, confirm } from '@clack/prompts';
import color from 'picocolors';

import { checkDependency } from '../utils/system.js';
import { trackEvent } from '../core/telemetry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function mainStack() {
    const startTime = Date.now();

    // 0. Silent Pre-flight check
    const hasTerraform = await checkDependency('terraform');
    if (!hasTerraform) {
        console.error(color.red('✖ Terraform is not installed.'));
        console.log(color.yellow('Please run "npx create-cloud-stack doctor" to check your environment.'));
        process.exit(1);
    }

    // 1. Start the CLI
    intro(color.bgCyan(color.black(' create-cloud-stack ☁️  ')));

    // 2. Ask the user for project configuration
    const setupType = await select({
        message: 'Choose your setup mode:',
        options: [
            { value: 'quick', label: '⚡ Quickstart (Recommended)', hint: 'Production defaults, minimal prompts' },
            { value: 'advanced', label: '🛠️  Advanced Configuration', hint: 'Customize health checks, task count, branch, etc.' },
        ],
    });

    if (typeof setupType === 'symbol') {
        cancel('Operation cancelled.');
        process.exit(0);
    }

    // 3. Prompt Configuration Group
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
                        { value: 'eu-central-1', label: 'EU (Frankfurt)' },
                        { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
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
                        { value: 'static', label: 'Static Site (Gatsby, React, plain HTML via Nginx)' },
                    ],
                }),
            size: () =>
                select({
                    message: 'Select your Fargate compute size:',
                    options: [
                        { value: 'micro', label: 'Micro (0.25 vCPU, 512MB RAM) - Best for POCs' },
                        { value: 'small', label: 'Small (0.5 vCPU, 1GB RAM) - Best for small Projects' },
                    ],
                }),
            // --- Advanced-Only Prompts (Skipped if setupType === 'quick') ---
            healthCheckPath: () => {
                if (setupType === 'quick') return undefined;
                return text({
                    message: 'ALB Health Check Path:',
                    placeholder: '/',
                    defaultValue: '/',
                });
            },
            desiredCount: () => {
                if (setupType === 'quick') return undefined;
                return select({
                    message: 'How many container replicas (tasks) should run?',
                    options: [
                        { value: '1', label: '1 Task (Single instance - lowest cost)' },
                        { value: '2', label: '2 Tasks (High Availability across AZs)' },
                    ],
                    defaultValue: '1',
                });
            },
            branch: () => {
                if (setupType === 'quick') return undefined;
                return text({
                    message: 'Primary Git deployment branch for CI/CD:',
                    placeholder: 'main',
                    defaultValue: 'main',
                });
            },
        },
        {
            onCancel: () => {
                cancel('Provisioning cancelled.');
                process.exit(0);
            },
        }
    );

    // 4. Map the user's choices and update the variables
    const actualProjectName = project.name === '.' ? path.basename(process.cwd()) : project.name;
    const targetDir = project.name === '.' ? process.cwd() : path.join(process.cwd(), project.name);

    const cpu = project.size === 'small' ? '512' : '256';
    const memory = project.size === 'small' ? '1024' : '512';

    const computeTier = project.size === 'small' ? 'Small (0.5 vCPU, 1GB RAM)' : 'Micro (0.25 vCPU, 512MB RAM)';
    const estimatedCost = project.size === 'small' ? '~$35.00 / month' : '~$25.00 / month';

    const healthCheckPath = project.healthCheckPath || '/';
    const desiredCount = project.desiredCount || '1';
    const deployBranch = project.branch || 'main';

    // 5. Check for existing files that might be overwritten
    const dockerfilePath = path.join(targetDir, 'Dockerfile');
    const tfDirPath = path.join(targetDir, 'terraform');

    if (fsSync.existsSync(dockerfilePath) || fsSync.existsSync(tfDirPath)) {
        const overwrite = await confirm({
            message: color.yellow('⚠️  A Dockerfile or terraform/ folder already exists here. Overwrite them?'),
            initialValue: false,
        });

        if (!overwrite) {
            cancel('Provisioning cancelled to protect existing files.');
            process.exit(0);
        }
    }

    const s = spinner();
    s.start('Provisioning infrastructure...');

    // 6. Provision S3 bucket for Terraform state & enable versioning
    const stsClient = new STSClient({ region: project.region });
    let awsAccountId;
    try {
        const { Account } = await stsClient.send(new GetCallerIdentityCommand({}));
        awsAccountId = Account;
    } catch (error) {
        s.stop('❌ Failed to authenticate with AWS.');
        console.error(color.red(`AWS Error: Ensure your credentials are valid. (${error.name})`));

        trackEvent('cli-error', { step: 'aws_sts_auth', error_code: error.name });
        process.exit(1);
    }

    let stateBucketName = `${actualProjectName}-tfstate-${awsAccountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (stateBucketName.length > 63) {
        stateBucketName = stateBucketName.substring(0, 63).replace(/-$/, '');
    }

    const s3Client = new S3Client({ region: project.region });
    try {
        await s3Client.send(new CreateBucketCommand({
            Bucket: stateBucketName,
            CreateBucketConfiguration: project.region === 'us-east-1' ? undefined : { LocationConstraint: project.region }
        }));

        await s3Client.send(new PutBucketVersioningCommand({
            Bucket: stateBucketName,
            VersioningConfiguration: { Status: 'Enabled' }
        }));
    } catch (error) {
        if (error.name !== 'BucketAlreadyOwnedByYou') {
            s.stop('❌ Failed to provision remote state.');
            console.error(color.red(`AWS S3 Error: ${error.message}`));

            trackEvent('cli-error', { step: 's3_bucket_creation', error_code: error.name });
            process.exit(1);
        }
    }

    s.message('Synthesizing Terraform templates...');

    // 7. Create project directories
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(targetDir, 'terraform'), { recursive: true });
    await fs.mkdir(path.join(targetDir, '.github', 'workflows'), { recursive: true });

    // 8. Read the template files
    const tfMainPath = path.join(__dirname, '../../templates', 'terraform', 'main.tf');
    const tfNetworkPath = path.join(__dirname, '../../templates', 'terraform', 'network.tf');
    const tfSecretsPath = path.join(__dirname, '../../templates', 'terraform', 'secrets.tf');
    const tfOidcPath = path.join(__dirname, '../../templates', 'terraform', 'oidc.tf');
    const tfBackendPath = path.join(__dirname, '../../templates', 'terraform', 'backend.tf');
    const tfCloudfrontPath = path.join(__dirname, '../../templates', 'terraform', 'cloudfront.tf');
    const dockerTemplatePath = path.join(__dirname, '../../templates', 'docker', `${project.framework}.Dockerfile`);
    const githubActionPath = path.join(__dirname, '../../templates', 'github', 'deploy.yml');
    const readmePath = path.join(__dirname, '../../templates', 'README.md');
    const gitignorePath = path.join(__dirname, '../../templates', '_gitignore');

    let tfMain = await fs.readFile(tfMainPath, 'utf-8');
    let tfNetwork = await fs.readFile(tfNetworkPath, 'utf-8');
    let tfSecrets = await fs.readFile(tfSecretsPath, 'utf-8');
    let tfOidc = await fs.readFile(tfOidcPath, 'utf-8');
    let tfBackend = await fs.readFile(tfBackendPath, 'utf-8');
    let tfCloudfront = await fs.readFile(tfCloudfrontPath, 'utf-8');
    let dockerContent = await fs.readFile(dockerTemplatePath, 'utf-8');
    let githubAction = await fs.readFile(githubActionPath, 'utf-8');
    let readmeContent = await fs.readFile(readmePath, 'utf-8');
    let gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');

    // 9. Update the variables
    const injectVariables = (content) => {
        return content
            .replace(/{{PROJECT_NAME}}/g, actualProjectName)
            .replace(/{{REGION}}/g, project.region)
            .replace(/{{PORT}}/g, project.port)
            .replace(/{{CPU}}/g, cpu)
            .replace(/{{MEMORY}}/g, memory)
            .replace(/{{COMPUTE_TIER}}/g, computeTier)
            .replace(/{{ESTIMATED_COST}}/g, estimatedCost)
            .replace(/{{STATE_BUCKET}}/g, stateBucketName)
            .replace(/{{AWS_ACCOUNT_ID}}/g, awsAccountId)
            .replace(/{{HEALTH_CHECK_PATH}}/g, healthCheckPath)
            .replace(/{{DESIRED_COUNT}}/g, desiredCount)
            .replace(/{{DEPLOY_BRANCH}}/g, deployBranch);
    };

    tfMain = injectVariables(tfMain);
    tfNetwork = injectVariables(tfNetwork);
    tfSecrets = injectVariables(tfSecrets);
    tfOidc = injectVariables(tfOidc);
    tfBackend = injectVariables(tfBackend);
    tfCloudfront = injectVariables(tfCloudfront);
    dockerContent = injectVariables(dockerContent);
    githubAction = injectVariables(githubAction);
    readmeContent = injectVariables(readmeContent);

    // 10. Write the finalized files
    await fs.writeFile(path.join(targetDir, 'terraform', 'main.tf'), tfMain);
    await fs.writeFile(path.join(targetDir, 'terraform', 'network.tf'), tfNetwork);
    await fs.writeFile(path.join(targetDir, 'terraform', 'secrets.tf'), tfSecrets);
    await fs.writeFile(path.join(targetDir, 'terraform', 'oidc.tf'), tfOidc);
    await fs.writeFile(path.join(targetDir, 'terraform', 'backend.tf'), tfBackend);
    await fs.writeFile(path.join(targetDir, 'terraform', 'cloudfront.tf'), tfCloudfront);
    await fs.writeFile(path.join(targetDir, 'Dockerfile'), dockerContent);
    await fs.writeFile(path.join(targetDir, '.github', 'workflows', 'deploy.yml'), githubAction);
    await fs.writeFile(path.join(targetDir, 'README.md'), readmeContent);
    await fs.writeFile(path.join(targetDir, 'terraform', 'secret_keys.json'), "[]");

    // 10.5. Ensure .gitignore exists and contains necessary Terraform ignores
    const targetGitignore = path.join(targetDir, '.gitignore');
    if (!fsSync.existsSync(targetGitignore)) {
        // No gitignore exists? Give them the full template (Terraform + Node + Python)
        await fs.writeFile(targetGitignore, gitignoreContent);
    } else {
        // File exists? Only inject the Terraform rules to prevent duplicates
        const existingGitignore = await fs.readFile(targetGitignore, 'utf-8');

        if (!existingGitignore.includes('terraform/.terraform/')) {
            const terraformIgnores = `
            # Added by create-cloud-stack (Terraform)
            terraform/.terraform/
            terraform/*.tfstate
            terraform/*.tfstate.backup
            terraform/.terraform.lock.hcl
            terraform/secret_keys.json
            terraform/.terraform.*
            `;
            await fs.appendFile(targetGitignore, '\n' + terraformIgnores);
        }
    }

    // 11. Track the event in telemetry
    trackEvent('project_provisioned', {
        projectName: actualProjectName,
        framework: project.framework,
        region: project.region,
        size: project.size,
        setup_mode: setupType,
        desiredCount: desiredCount,
        duration_ms: Date.now() - startTime
    });

    s.stop('Infrastructure provisioned successfully!');

    // 12. Provide the Outro, Framework Warnings and Next Steps
    let frameworkWarnings = '';

    if (project.framework === 'nextjs') {
        frameworkWarnings =
            color.bgYellow(color.black(' ⚠️  IMPORTANT: NEXT.JS SETUP REQUIRED ')) +
            color.yellow('\n    You must modify your next.config file and create a health check route before deploying.') +
            color.yellow('\n    See the "Critical Application Prerequisites" section in your README.md for copy-paste code.\n\n');
    }

    outro(`
    ${color.green('✅ Project provisioned successfully!')}
    
        Next steps:
        1. cd ${project.name}
        2. Deploy infrastructure:
           cd terraform && terraform init && terraform apply
        3. Push to GitHub:
           git init && git add . && git commit -m "Initial commit"

        ${color.cyan('Once deployed, Terraform will output your new https://*.cloudfront.net URL.')}
    `);
}