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

export async function mainStack({ isHeadless = false, headlessOptions = {} } = {}) {
    const startTime = Date.now();

    // 0. Silent Pre-flight check
    const hasTerraform = await checkDependency('terraform');
    if (!hasTerraform) {
        console.error(color.red('✖ Terraform is not installed.'));
        console.log(color.yellow('Please run "npx deploy-stack doctor" to check your environment.'));
        process.exit(1);
    }

    const getFlag = (key, defaultValue) => headlessOptions[key] !== undefined ? headlessOptions[key] : defaultValue;

    let projectName, actualProjectName, targetDir;
    let finalFramework, detectedFramework;
    let djangoWsgi = 'core.wsgi';
    let setupType = 'quick';
    let needsDatabase = false;
    let disableDefaultCI = false;
    let project = {};
    let currentGitBranch = 'main';

    if (isHeadless) {
        // --- HEADLESS MODE ---
        projectName = getFlag('dir', '.');
        actualProjectName = projectName === '.' ? path.basename(process.cwd()) : projectName;
        targetDir = projectName === '.' ? process.cwd() : path.join(process.cwd(), projectName);

        detectedFramework = detectFramework(targetDir);
        finalFramework = getFlag('framework', detectedFramework ? detectedFramework.id : 'static');

        project = {
            region: getFlag('region', 'us-east-1'),
            port: getFlag('port', finalFramework === 'static' ? '8080' : '3000'),
            size: getFlag('size', 'micro'),
            healthCheckPath: getFlag('healthCheckPath', '/'),
            desiredCount: getFlag('desiredCount', '1'),
            branch: getFlag('branch', 'main')
        };

        console.log(color.cyan(`🤖 Running deploy-stack in headless mode [${finalFramework} -> ${project.region}]`));
    } else {
        // --- INTERACTIVE MODE ---
        // 1. Start the CLI
        intro(color.bgCyan(color.black(' deploy-stack ☁️  ')));

        // 2. Ask for the target directory FIRST
        const projectName = await text({
            message: 'Where should we generate the infrastructure? (Type "." for current directory)',
            placeholder: '.',
            initialValue: '.',
            validate: (value) => {
                if (!value) return 'Please enter a name or directory.';
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
                    { value: 'nuxt', label: 'Nuxt 3 (SSR)' },
                    { value: 'python', label: 'Python FastAPI' },
                    { value: 'django', label: 'Django (Python)' },
                    { value: 'rails', label: 'Ruby on Rails' },
                    { value: 'go', label: 'Go (Golang)' },
                    { value: 'static', label: 'Static Site (Gatsby, React, plain HTML via Nginx)' },
                ],
            });

            if (typeof finalFramework === 'symbol') {
                cancel('Operation cancelled.');
                process.exit(0);
            }
        }

        // --- DJANGO SPECIFIC PROMPT ---
        let djangoWsgi = 'core.wsgi';
        if (finalFramework === 'django') {
            djangoWsgi = await text({
                message: 'What is the Python module path to your Django wsgi.py?',
                placeholder: 'core.wsgi',
                initialValue: 'core.wsgi',
            });
            if (typeof djangoWsgi === 'symbol') process.exit(0);
        }

        // 3. Prompt for Setup Mode
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

        // 4. Set intelligent defaults & check current Git branch
        let defaultPort = '3000';

        if (finalFramework === 'static') defaultPort = '8080';
        if (finalFramework === 'python' || finalFramework === 'django') defaultPort = '8000';
        if (finalFramework === 'rails') defaultPort = '3000';
        if (finalFramework === 'go') defaultPort = '8080';

        let currentGitBranch = 'main';
        try {
            currentGitBranch = execSync('git symbolic-ref --short HEAD', { cwd: targetDir, stdio: 'pipe' }).toString().trim();
        } catch (e) {
            // Not a git repo yet, fallback to 'main'
        }

        // 5. Ask for Managed Database (Only for Backend/Fullstack Frameworks)
        let needsDatabase = false;
        const isBackendFramework = ['node', 'nextjs', 'nuxt', 'python', 'django', 'rails', 'go'].includes(finalFramework);

        if (isBackendFramework) {
            const dbChoice = await confirm({
                message: 'Do you need a managed AWS RDS PostgreSQL database? (Adds ~$14/month or uses AWS Free Tier)',
                initialValue: false,
            });

            if (typeof dbChoice === 'symbol') {
                cancel('Provisioning cancelled.')
                process.exit(0);
            }
            needsDatabase = dbChoice;
        }

        // 6. Prompt Configuration Group
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
    }

    // 7. Map the user's choices and update the variables
    const cpu = project.size === 'small' ? '512' : '256';
    const memory = project.size === 'small' ? '1024' : '512';

    const baseCost = project.size === 'small' ? 35 : 25;
    const dbCost = needsDatabase ? 14 : 0;
    const totalCost = baseCost + dbCost;

    const computeTier = project.size === 'small' ? 'Small (0.5 vCPU, 1GB RAM)' : 'Micro (0.25 vCPU, 512MB RAM)';
    const estimatedCost = `~$${totalCost}.00 / month${needsDatabase ? ' (Includes Fargate + RDS PostgreSQL)' : ''}`;

    const healthCheckPath = project.healthCheckPath || '/';
    const desiredCount = project.desiredCount || '1';
    const deployBranch = project.branch || currentGitBranch;
    const buildDir = detectedFramework?.buildDir || 'dist';

    // 7.4 Check for conflicting CI boilerplate (Rails)
    if (finalFramework === 'rails') {
        const ciPath = path.join(targetDir, '.github', 'workflows', 'ci.yml');
        const dependabotPath = path.join(targetDir, '.github', 'dependabot.yml');

        if (fsSync.existsSync(ciPath) || fsSync.existsSync(dependabotPath)) {
            if (!isHeadless) {
                console.log('');
                const ciContent = await confirm({
                    message: color.yellow('We detected default Rails GitHub Actions (ci.yml, dependabot.yml) that usually crash in isolated CI environments without a database. Would you like deploy-stack to safely disable them by renaming them to .bak?'),
                    initialValue: true,
                });
                if (typeof ciContent === 'symbol') {
                    cancel('Provisioning cancelled.');
                    process.exit(0);
                }
                disableDefaultCI = ciContent;
            } else {
                // Headless: automatically disable conflicting CI
                disableDefaultCI = true;
            }
        }
    }

    // 7.5. The Pre-Flight Cost Estimator
    // We explicitly ask for financial consent to eliminate AWS billing anxiety.
    if (!isHeadless) {
        console.log(''); // Add a blank line for visual pacing
        const costConsent = await confirm({
            message: color.yellow(`⚠️  Pre-Flight Check: This AWS architecture will cost ${estimatedCost}. Proceed with provisioning?`),
            initialValue: true,
        });
        if (!costConsent || typeof costConsent === 'symbol') {
            cancel('Deployment cancelled. No AWS resources were provisioned.');
            process.exit(0);
        }
    }

    // 8. Safely handle existing files (Backup and auto-prune)
    await handleExistingFiles(targetDir, isHeadless);

    const s = spinner();
    s.start('Provisioning infrastructure...');

    // 9. Provision S3 bucket for Terraform state & enable versioning
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

    // 10. Generate all templates and directories
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
        finalFramework: finalFramework,
        NEEDS_DATABASE: needsDatabase,
        DJANGO_WSGI: djangoWsgi,
        DISABLE_DEFAULT_CI: disableDefaultCI
    });

    // 11. Track the event in telemetry
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

    // 12. Provide the Outro, Framework Warnings and Next Steps
    let frameworkWarnings = '';
    if (!(finalFramework === 'static' && detectedFramework?.buildDir)) {
        frameworkWarnings = getFrameworkWarning(finalFramework);
    }

    const isGitInitialized = fsSync.existsSync(path.join(targetDir, '.git'));

    const cdStep = projectName === '.' ? '' : `1. cd ${projectName}\n        `;
    const applyStep = `${cdStep}npx deploy-stack apply`;

    const gitInstructions = isGitInitialized
        ? `git add . && git commit -m "chore: add AWS infrastructure and CI/CD" && git push`
        : `git init && git add . && git commit -m "chore: add AWS infrastructure and CI/CD" && git branch -M ${deployBranch} && git remote add origin https://github.com/your-username/your-repo.git && git push -u origin ${deployBranch}`;

    const outroMessage = `${color.green('✅ Templates generated!')} ${color.blue('🛡️ DevSecOps scanning enabled.')}
    ${frameworkWarnings ? `\n  ${frameworkWarnings}` : ''}
    ${color.yellow('Next steps:')}
    1. ${color.cyan(applyStep)}
    2. ${color.cyan(gitInstructions)}
    ${color.magenta('🚀 Need help?')} ${color.underline('https://calendly.com/anton-codes-iac/15min')}`;

    outro(outroMessage);

    // 13.Ensure all analytics are sent before the CLI terminates
    await flushTelemetry();
}