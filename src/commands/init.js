import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { intro, outro, group, text, select, spinner, cancel, confirm, log } from '@clack/prompts';
import color from 'picocolors';
import { execSync } from 'child_process';

import { checkDependency } from '../utils/system.js';
import { detectFramework } from '../utils/detector.js';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { getFrameworkWarning } from '../utils/warnings.js';
import { provisionStateBucket } from '../utils/aws.js';
import { generateTemplates } from '../utils/generator.js';
import { handleExistingFiles } from '../utils/backup.js';

export async function mainStack() {
    const startTime = Date.now();

    // 0. Silent Pre-flight check
    const hasTerraform = await checkDependency('terraform');
    if (!hasTerraform) {
        console.error(color.red('✖ Terraform is not installed.'));
        console.log(color.yellow('Please run "npx deploy-stack doctor" to check your environment.'));
        process.exit(1);
    }

    // 1. Start the CLI
    intro(color.bgCyan(color.black(' deploy-stack ☁️  ')));

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

    const projectName = await text({
        message: 'What is the name of your project? (Type "." to use current directory)',
        placeholder: 'my-web-app',
        validate: (value) => {
            if (!value) return 'Please enter a name.';
            if (value !== '.' && value.includes(' ')) return 'Name cannot contain spaces.';
        },
    });

    if (typeof projectName === 'symbol') {
        cancel('Operation cancelled.');
        process.exit(0);
    }

    const actualProjectName = projectName === '.' ? path.basename(process.cwd()) : projectName;
    const targetDir = projectName === '.' ? process.cwd() : path.join(process.cwd(), projectName);

    // 2.5 Run the scanner
    const detectedFramework = detectFramework(targetDir);
    if (detectedFramework) {
        log.success(`Auto-detected framework: ${detectedFramework.name}`);
    }

    // 2.6 Resolve the framework
    let finalFramework = detectedFramework ? detectedFramework.id : null;

    if (!finalFramework) {
        finalFramework = await select({
            message: 'Which framework preset should we configure?',
            options: [
                { value: 'node', label: 'Node.js / Express' },
                { value: 'nextjs', label: 'Next.js (Standalone)' },
                { value: 'python', label: 'Python FastAPI' },
                { value: 'static', label: 'Static Site (Gatsby, React, plain HTML via Nginx)' },
            ],
        });

        if (typeof finalFramework === 'symbol') {
            cancel('Operation cancelled.');
            process.exit(0);
        }
    }

    // 2.7 Set intelligent defaults
    let defaultPort = '3000';

    if (finalFramework === 'static') defaultPort = '8080';
    if (finalFramework === 'python') defaultPort = '8000';

    // 2.8 Check current Git branch
    let currentGitBranch = 'main';
    try {
        currentGitBranch = execSync('git symbolic-ref --short HEAD', { cwd: targetDir, stdio: 'pipe' }).toString().trim();
    } catch (e) {
        // Not a git repo yet, fallback to 'main'
    }

    // 3. Prompt Configuration Group
    const project = await group(
        {
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
                    placeholder: defaultPort,
                    defaultValue: defaultPort,
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
                    placeholder: currentGitBranch,
                    defaultValue: currentGitBranch,
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
    const cpu = project.size === 'small' ? '512' : '256';
    const memory = project.size === 'small' ? '1024' : '512';

    const computeTier = project.size === 'small' ? 'Small (0.5 vCPU, 1GB RAM)' : 'Micro (0.25 vCPU, 512MB RAM)';
    const estimatedCost = project.size === 'small' ? '~$35.00 / month' : '~$25.00 / month';

    const healthCheckPath = project.healthCheckPath || '/';
    const desiredCount = project.desiredCount || '1';
    const deployBranch = project.branch || currentGitBranch;

    const buildDir = detectedFramework?.buildDir || 'dist';

    // 5. Safely handle existing files (Backup and auto-prune)
    await handleExistingFiles(targetDir);

    const s = spinner();
    s.start('Provisioning infrastructure...');

    // 6. Provision S3 bucket for Terraform state & enable versioning
    let awsAccountId, stateBucketName;
    try {
        const bucketData = await provisionStateBucket(project.region, actualProjectName);
        awsAccountId = bucketData.awsAccountId;
        stateBucketName = bucketData.stateBucketName;
    } catch (error) {
        s.stop('❌ Failed to provision remote state or authenticate with AWS.');
        console.error(color.red(`AWS Error: ${error.message}`));
        trackEvent('cli-error', { step: 'aws_provisioning', error_code: error.name || 'UNKNOWN' });
        await flushTelemetry();
        process.exit(1);
    }

    s.message('Synthesizing Terraform templates...');

    // 7. Generate all templates and directories
    await generateTemplates(targetDir, {
        PROJECT_NAME: actualProjectName,
        REGION: project.region,
        PORT: project.port,
        CPU: cpu,
        MEMORY: memory,
        COMPUTE_TIER: computeTier,
        ESTIMATED_COST: estimatedCost,
        STATE_BUCKET: stateBucketName,
        AWS_ACCOUNT_ID: awsAccountId,
        HEALTH_CHECK_PATH: healthCheckPath,
        DESIRED_COUNT: desiredCount,
        DEPLOY_BRANCH: deployBranch,
        BUILD_DIR: buildDir,
        finalFramework: finalFramework
    });

    // 8. Track the event in telemetry
    trackEvent('project_provisioned', {
        projectName: actualProjectName,
        framework: finalFramework,
        specific_framework: detectedFramework?.name || finalFramework,
        region: project.region,
        size: project.size,
        setup_mode: setupType,
        desiredCount: desiredCount,
        duration_ms: Date.now() - startTime
    });

    s.stop('Infrastructure provisioned successfully!');

    // 9. Provide the Outro, Framework Warnings and Next Steps
    let frameworkWarnings = '';
    if (!(finalFramework === 'static' && detectedFramework?.buildDir)) {
        frameworkWarnings = getFrameworkWarning(finalFramework);
    }

    const isGitInitialized = fsSync.existsSync(path.join(targetDir, '.git'));

    const cdStep = projectName === '.' ? '' : `1. cd ${projectName}\n        `;
    const deployStepNum = projectName === '.' ? '1' : '2';
    const gitStepNum = projectName === '.' ? '2' : '3';

    const gitInstructions = isGitInitialized
        ? `git add .\n       git commit -m "chore: add AWS infrastructure and CI/CD"\n       git push`
        : `git init\n       git add .\n       git commit -m "chore: add AWS infrastructure and CI/CD"\n       git branch -M ${deployBranch}\n       git remote add origin https://github.com/your-username/your-repo.git\n       git push -u origin ${deployBranch}`;

    outro(`
    ${color.green('✅ Project provisioned successfully!')}

    ${color.blue('🛡️ DevSecOps Enabled:')}
       Automated Trivy vulnerability scanning for your Docker container 
       and Terraform has been added to your CI/CD pipeline. 
       Check the 'Summary' page of your GitHub Actions runs for reports.

    ${frameworkWarnings}
    
    Next steps:
    ${cdStep}${deployStepNum}. Deploy infrastructure:
       cd terraform && terraform init && terraform apply

    ${gitStepNum}. Push to GitHub to trigger CI/CD:
       cd ..
       ${gitInstructions}

    ${color.cyan('Once deployed, Terraform will output your new https://*.cloudfront.net URL.')}

    ${color.magenta('🚀 Infrastructure ready! Need help or have feedback? Grab 15 mins with Anton:')}
    ${color.underline('https://calendly.com/anton-codes-iac/15min')}
    `);

    // 10.Ensure all analytics are sent before the CLI terminates
    await flushTelemetry();
}