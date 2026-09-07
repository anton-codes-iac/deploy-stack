import fsSync from 'fs';
import path from 'path';
import { intro, outro, spinner, log } from '@clack/prompts';
import color from 'picocolors';

import { checkDependency } from '../utils/system.js';
import {
    detectFramework,
    parseProcfile,
    parseVercelConfig,
    analyzeNextConfig,
    analyzeSvelteConfig,
    analyzeAstroConfig
} from '../utils/detector.js';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { getFrameworkWarning } from '../utils/warnings.js';
import { provisionStateBucket } from '../utils/aws.js';
import { generateTemplates } from '../utils/generator.js';
import { handleExistingFiles } from '../utils/backup.js';
import { estimateMonthlyCost } from '../utils/visualizer.js';
import { getTargetDirectory, getProjectConfig } from '../utils/prompts.js';
import { resolveDjangoWsgi, handleRailsCI } from '../utils/frameworks.js';
import { parseDockerCompose } from '../utils/dockerCompose.js';
import { getBaseRules, getCursorRules, injectManagedBlock } from '../utils/ai-rules.js';

const pkg = JSON.parse(fsSync.readFileSync(new URL('../../package.json', import.meta.url)));
const CLI_VERSION = pkg.version;

export async function mainStack({ isHeadless = false, headlessOptions = {} } = {}) {
    const startTime = Date.now();

    // 1. Silent Pre-flight check
    const hasTerraform = await checkDependency('terraform');
    if (!hasTerraform) {
        console.error(color.red('✖ Terraform is not installed.'));
        console.log(color.yellow('Please run "npx deploy-stack doctor" to check your environment.'));
        process.exit(1);
    }

    if (!isHeadless) intro(color.bgCyan(color.black(' deploy-stack ☁️  ')));

    // 2. Resolve Target & Scan Codebase
    const dirConfig = await getTargetDirectory(isHeadless, headlessOptions);
    const detectedFramework = detectFramework(dirConfig.targetDir);
    const procfile = parseProcfile(dirConfig.targetDir);
    const vercelRules = parseVercelConfig(dirConfig.targetDir);
    const dockerCompose = parseDockerCompose(dirConfig.targetDir);

    if (!isHeadless) {
        if (detectedFramework) log.success(`Auto-detected framework: ${detectedFramework.name}`);
        if (procfile && procfile.web) log.success(`Auto-detected Procfile (web command: ${procfile.web.join(' ')})`);
        if (vercelRules) log.success(`Auto-detected vercel.json (Migrating edge network rules)`);
        if (dockerCompose) log.success(`Auto-detected docker-compose.yml (${dockerCompose.length} services mapped)`);
    }

    if (isHeadless) console.log(color.cyan(`🤖 Running deploy-stack in headless mode`));

    // 3. Gather Configuration & Framework Quirks
    const config = await getProjectConfig(isHeadless, headlessOptions, dirConfig.targetDir, detectedFramework);
    const djangoWsgi = await resolveDjangoWsgi(dirConfig.targetDir, procfile, config.framework, isHeadless);
    const disableDefaultCI = await handleRailsCI(dirConfig.targetDir, config.framework, isHeadless);

    // 3.5 Docker Compose Overrides
    if (dockerCompose && dockerCompose.length > 0) {
        // Find the first service that has an exposed port
        const webService = dockerCompose.find(s => s.port);
        if (webService && webService.port) {
            // Override the config port with the one from Docker Compose
            config.port = webService.port.toString();
            if (!isHeadless) {
                console.log(color.cyan(`   🐳 Docker Compose overrides: Port set to ${config.port} via service "${webService.name}"`));
            }
        }
    }

    // 4. Framework Migration Checks (Vercel Escape Hatch)
    if (config.framework === 'nextjs') {
        const nextConfig = analyzeNextConfig(dirConfig.targetDir);
        if (nextConfig.hasConfig && !nextConfig.isStandalone) {
            log.warn(color.yellow('⚠️ Next.js config is missing "output: \'standalone\'".'));
            console.log(color.cyan('   Fix it here: https://github.com/anton-codes-iac/deploy-stack/blob/main/docs/migrations/nextjs-vercel-to-aws.md'));
        }
    } else if (detectedFramework?.name === 'SvelteKit') {
        const svelteConfig = analyzeSvelteConfig(dirConfig.targetDir);
        if (svelteConfig.adapter === 'vercel' || svelteConfig.adapter === 'auto') {
            log.warn(color.yellow('⚠️ SvelteKit is locked into the Vercel/Auto adapter.'));
            console.log(color.cyan('   Fix it here: https://github.com/anton-codes-iac/deploy-stack/blob/main/docs/migrations/sveltekit-vercel-to-aws.md'));
        }
    } else if (detectedFramework?.name === 'Astro') {
        const astroConfig = analyzeAstroConfig(dirConfig.targetDir);
        if (astroConfig.adapter === 'vercel') {
            log.warn(color.yellow('⚠️ Astro is locked into the Vercel adapter.'));
            console.log(color.cyan('   Fix it here: https://github.com/anton-codes-iac/deploy-stack/blob/main/docs/migrations/astro-vercel-to-aws.md'));
        }
    }

    // 5. Calculate Derived Values
    const cpu = config.size === 'small' ? '512' : '256';
    const memory = config.size === 'small' ? '1024' : '512';
    const computeTier = config.size === 'small' ? 'Small (0.5 vCPU, 1GB RAM)' : 'Micro (0.25 vCPU, 512MB RAM)';

    const costs = estimateMonthlyCost({ cpu: parseInt(cpu), memory: parseInt(memory), hasDb: config.needsDatabase });
    const estimatedCost = `~$${costs.totalMonthly} / month${config.needsDatabase ? ' (Includes Fargate + RDS PostgreSQL)' : ''}`;
    const buildDir = detectedFramework?.buildDir || 'dist';

    // 6. Handle Backups & Provision Remote State
    await handleExistingFiles(dirConfig.targetDir, isHeadless);

    const s = spinner();
    s.start('Provisioning infrastructure...');

    let awsAccountId, stateBucketName;
    try {
        const bucketData = await provisionStateBucket(config.region, dirConfig.actualProjectName);
        awsAccountId = bucketData.awsAccountId;
        stateBucketName = bucketData.stateBucketName;
    } catch (error) {
        s.stop('❌ Failed to provision remote state or authenticate with AWS.');
        console.error(color.red(`AWS Error: ${error.message}`));
        trackEvent('cli-error', { step: 'aws_provisioning', error_code: error.name || 'UNKNOWN' });
        await flushTelemetry();
        process.exit(1);
    }

    // 7. Synthesize Templates
    s.message('Synthesizing Terraform templates...');
    await generateTemplates(dirConfig.targetDir, {
        PROJECT_NAME: dirConfig.actualProjectName,
        REGION: config.region,
        PORT: config.port,
        CPU: cpu,
        MEMORY: memory,
        COMPUTE_TIER: computeTier,
        ESTIMATED_COST: estimatedCost,
        STATE_BUCKET: stateBucketName,
        AWS_ACCOUNT_ID: awsAccountId,
        HEALTH_CHECK_PATH: config.healthCheckPath,
        DESIRED_COUNT: config.desiredCount,
        DEPLOY_BRANCH: config.branch,
        BUILD_DIR: buildDir,
        finalFramework: config.framework,
        NEEDS_DATABASE: config.needsDatabase,
        DJANGO_WSGI: djangoWsgi,
        DISABLE_DEFAULT_CI: disableDefaultCI,
        PROCFILE: procfile,
        VERCEL_RULES: vercelRules,
        DOCKER_COMPOSE: dockerCompose,
        ENABLE_PR_PREVIEWS: config.enablePrPreviews
    });

    // 8. Telemetry
    trackEvent('project_provisioned', {
        // 1. Core & Context
        projectName: dirConfig.actualProjectName,
        cli_version: CLI_VERSION,
        is_headless: isHeadless,
        setup_mode: config.setupType,
        duration_ms: Date.now() - startTime,

        // 2. Infrastructure Shape
        framework: config.framework,
        specific_framework: detectedFramework?.name || config.framework,
        region: config.region,
        size: config.size,
        desired_count: parseInt(config.desiredCount),
        has_database: config.needsDatabase,
        has_custom_health_check: config.healthCheckPath !== '/',

        // 3. Advanced Features & PaaS Context
        has_worker: !!(procfile && procfile.worker),
        is_heroku_migration: !!procfile,
        is_vercel_migration: !!vercelRules,
        is_docker_compose: !!dockerCompose,
        has_pr_previews: config.enablePrPreviews,
        ai_assistants_configured: config.aiAssistants || [],
    });

    s.stop('Infrastructure provisioned successfully!');

    // 8.5 Configure AI Context
    s.start('Configuring AI workspace rules...');
    const aiContext = { region: config.region, port: config.port };

    if (config.setupType === 'advanced') {
        // --- ADVANCED MODE: Explicitly respect user choices ---
        if (config.aiAssistants.includes('cursor')) {
            const cursorDir = path.join(dirConfig.targetDir, '.cursor', 'rules');
            if (!fsSync.existsSync(cursorDir)) fsSync.mkdirSync(cursorDir, { recursive: true });
            fsSync.writeFileSync(path.join(cursorDir, 'deploy-stack.mdc'), getCursorRules(aiContext));
        }
        if (config.aiAssistants.includes('windsurf')) {
            injectManagedBlock(path.join(dirConfig.targetDir, '.windsurfrules'), getBaseRules(aiContext), false);
        }
        if (config.aiAssistants.includes('claude')) {
            injectManagedBlock(path.join(dirConfig.targetDir, 'CLAUDE.md'), getBaseRules(aiContext), true);
        }
        if (config.aiAssistants.includes('copilot')) {
            const copilotPath = path.join(dirConfig.targetDir, '.github', 'copilot-instructions.md');
            if (!fsSync.existsSync(path.dirname(copilotPath))) fsSync.mkdirSync(path.dirname(copilotPath), { recursive: true });
            injectManagedBlock(copilotPath, getBaseRules(aiContext), true);
        }
    } else {
        // --- QUICKSTART MODE: Silent Auto-Detection ---
        if (fsSync.existsSync(path.join(dirConfig.targetDir, '.cursor'))) {
            const cursorDir = path.join(dirConfig.targetDir, '.cursor', 'rules');
            if (!fsSync.existsSync(cursorDir)) fsSync.mkdirSync(cursorDir, { recursive: true });
            fsSync.writeFileSync(path.join(cursorDir, 'deploy-stack.mdc'), getCursorRules(aiContext));
        }
        if (fsSync.existsSync(path.join(dirConfig.targetDir, '.windsurf')) || fsSync.existsSync(path.join(dirConfig.targetDir, '.windsurfrules'))) {
            injectManagedBlock(path.join(dirConfig.targetDir, '.windsurfrules'), getBaseRules(aiContext), false);
        }
        if (fsSync.existsSync(path.join(dirConfig.targetDir, 'CLAUDE.md'))) {
            injectManagedBlock(path.join(dirConfig.targetDir, 'CLAUDE.md'), getBaseRules(aiContext), true);
        }
        const copilotPath = path.join(dirConfig.targetDir, '.github', 'copilot-instructions.md');
        if (fsSync.existsSync(copilotPath)) {
            injectManagedBlock(copilotPath, getBaseRules(aiContext), true);
        }
    }
    s.stop('AI rules configured successfully!');

    // 9. Output
    let frameworkWarnings = '';
    if (!(config.framework === 'static' && detectedFramework?.buildDir)) {
        frameworkWarnings = getFrameworkWarning(config.framework);
    }

    const isGitInitialized = fsSync.existsSync(path.join(dirConfig.targetDir, '.git'));
    const needsCd = dirConfig.projectName && dirConfig.projectName !== '.';
    const applyStep = needsCd ? `cd ${dirConfig.projectName} && npx --yes deploy-stack apply` : 'npx --yes deploy-stack apply';
    const gitInstructions = isGitInitialized
        ? `git add . && git commit -m "chore: add AWS infrastructure and CI/CD" && git push`
        : `git init && git add . && git commit -m "chore: add AWS infrastructure and CI/CD" && git branch -M ${config.branch} && git remote add origin https://github.com/your-username/your-repo.git && git push -u origin ${config.branch}`;

    let docsTip = '';
    if (procfile) {
        docsTip = `\n  ${color.blue('📘 Read the Heroku Migration Guide:')} ${color.underline('https://github.com/anton-codes-iac/deploy-stack/blob/main/docs/migrations/heroku-procfile-to-aws.md')}`;
    } else if (config.needsDatabase) {
        docsTip = `\n  ${color.blue('📘 Read the Database Connections Guide:')} ${color.underline('https://github.com/anton-codes-iac/deploy-stack/blob/main/docs/guides/database-connections.md')}`;
    }

    outro(`${color.green('✅ Templates generated!')} ${color.blue('🛡️ DevSecOps scanning enabled.')}
    ${frameworkWarnings ? `\n  ${frameworkWarnings}` : ''}
    ${color.yellow('Next steps:')}
    1. ${color.cyan(applyStep)}
    2. ${color.cyan(gitInstructions)}
    ${color.magenta('🚀 Need help?')} ${color.underline('https://calendly.com/anton-codes-iac/15min')}`);

    await flushTelemetry();
}