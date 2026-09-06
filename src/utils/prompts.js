import path from 'path';
import { text, select, confirm, group, cancel, log } from '@clack/prompts';
import color from 'picocolors';
import { execSync } from 'child_process';

export async function getTargetDirectory(isHeadless, headlessOptions) {
    if (isHeadless) {
        const projectName = headlessOptions.dir || '.';
        return {
            projectName,
            actualProjectName: projectName === '.' ? path.basename(process.cwd()) : projectName,
            targetDir: projectName === '.' ? process.cwd() : path.join(process.cwd(), projectName)
        };
    }

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

    return {
        projectName,
        actualProjectName: projectName === '.' ? path.basename(process.cwd()) : projectName,
        targetDir: projectName === '.' ? process.cwd() : path.join(process.cwd(), projectName)
    };
}

export async function getProjectConfig(isHeadless, headlessOptions, targetDir, detectedFramework) {
    if (isHeadless) {
        return {
            framework: headlessOptions.framework || (detectedFramework ? detectedFramework.id : 'static'),
            region: headlessOptions.region || 'us-east-2',
            port: headlessOptions.port || (headlessOptions.framework === 'static' ? '8080' : '3000'),
            size: headlessOptions.size || 'micro',
            healthCheckPath: headlessOptions.healthCheckPath || '/',
            desiredCount: headlessOptions.desiredCount || '1',
            branch: headlessOptions.branch || 'main',
            needsDatabase: false,
            setupType: 'headless'
        };
    }

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
        if (typeof finalFramework === 'symbol') process.exit(0);
    }

    const setupType = await select({
        message: 'Choose your setup mode:',
        options: [
            { value: 'quick', label: '⚡ Quickstart (Recommended)', hint: 'Production defaults, minimal prompts' },
            { value: 'advanced', label: '🛠️  Advanced Configuration', hint: 'Customize health checks, task count, branch, etc.' },
        ],
    });
    if (typeof setupType === 'symbol') process.exit(0);

    let defaultPort = '3000';
    if (finalFramework === 'static' || finalFramework === 'go') defaultPort = '8080';
    if (finalFramework === 'python' || finalFramework === 'django') defaultPort = '8000';

    let currentGitBranch = 'main';
    try {
        currentGitBranch = execSync('git symbolic-ref --short HEAD', { cwd: targetDir, stdio: 'pipe' }).toString().trim();
    } catch (e) { }

    let needsDatabase = false;
    const isBackendFramework = ['node', 'nextjs', 'nuxt', 'python', 'django', 'rails', 'go'].includes(finalFramework);

    if (isBackendFramework) {
        const dbChoice = await confirm({
            message: 'Do you need a managed AWS RDS PostgreSQL database? (Adds ~$14/month or uses AWS Free Tier)',
            initialValue: false,
        });
        if (typeof dbChoice === 'symbol') process.exit(0);
        needsDatabase = dbChoice;
    }

    const project = await group({
        region: () => select({
            message: 'Which AWS region do you want to deploy to?',
            options: [
                { value: 'us-east-1', label: 'us-east-1 (N. Virginia)' },
                { value: 'us-east-2', label: 'us-east-2 (Ohio)' },
                { value: 'eu-west-1', label: 'eu-west-1 (Ireland)' },
                { value: 'eu-central-1', label: 'EU (Frankfurt)' },
                { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
            ],
        }),
        port: () => text({
            message: 'What port does your container expose?',
            placeholder: defaultPort,
            defaultValue: defaultPort,
        }),
        size: () => select({
            message: 'Select your Fargate compute size:',
            options: [
                { value: 'micro', label: 'Micro (0.25 vCPU, 512MB RAM) - Best for POCs' },
                { value: 'small', label: 'Small (0.5 vCPU, 1GB RAM) - Best for small Projects' },
            ],
        }),
        healthCheckPath: () => setupType === 'quick' ? undefined : text({
            message: 'ALB Health Check Path:',
            placeholder: '/',
            defaultValue: '/',
        }),
        desiredCount: () => setupType === 'quick' ? undefined : select({
            message: 'How many container replicas (tasks) should run?',
            options: [
                { value: '1', label: '1 Task (Single instance - lowest cost)' },
                { value: '2', label: '2 Tasks (High Availability across AZs)' },
            ],
            defaultValue: '1',
        }),
        branch: () => setupType === 'quick' ? undefined : text({
            message: 'Primary Git deployment branch for CI/CD:',
            placeholder: currentGitBranch,
            defaultValue: currentGitBranch,
        }),
    }, { onCancel: () => process.exit(0) });

    return {
        framework: finalFramework,
        region: project.region,
        port: project.port,
        size: project.size,
        healthCheckPath: project.healthCheckPath || '/',
        desiredCount: project.desiredCount || '1',
        branch: project.branch || currentGitBranch,
        needsDatabase,
        setupType
    };
}