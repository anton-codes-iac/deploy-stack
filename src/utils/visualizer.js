import { note, confirm, isCancel, cancel } from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import { ADDON_REGISTRY } from './addons.js';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';

export const COST_ESTIMATE_MARKER = 'Estimated Fixed Monthly Baseline:';
export const LEGACY_COST_ESTIMATE_MARKER = 'Estimated Monthly Cost:';

// Cost benchmarks for AWS us-east-2 baseline (Fargate + ALB)
const PRICING_TABLE = {
    fargate: {
        cpuPerHour: 0.04048,   // per vCPU hour
        memoryPerHour: 0.004445 // per GB hour
    },
    alb: {
        basePerHour: 0.0225,   // ~$16.43/month base
        lcuPerHour: 0.008      // Baseline ~1 LCU (~$5.84/month)
    },
    rds: {
        microPerHour: 0.016,   // ~$11.68/mo for db.t4g.micro
        storagePerMonth: 2.30  // 20GB gp3 storage baseline
    },
    secretsManagerPerSecret: 0.40 // per secret per month
};

// 1. Parse the local terraform files to extract the actual configuration
export function parseTerraformConfig(tfDir) {
    const tfvarsPath = path.join(tfDir, 'terraform.tfvars');
    let region = 'us-east-2';
    let cpu = 256;
    let memory = 512;
    let framework = 'Application';

    // Read rendered cpu/memory from main.tf first so non-micro sizes chosen
    // at init time survive apply previews and README cost syncs.
    const mainTfPath = path.join(tfDir, 'main.tf');
    if (fs.existsSync(mainTfPath)) {
        const mainTf = fs.readFileSync(mainTfPath, 'utf-8');
        const renderedCpu = mainTf.match(/cpu\s*=\s*"(\d+)"/);
        if (renderedCpu) cpu = parseInt(renderedCpu[1], 10);
        const renderedMemory = mainTf.match(/memory\s*=\s*"(\d+)"/);
        if (renderedMemory) memory = parseInt(renderedMemory[1], 10);
    }

    // terraform.tfvars overrides rendered values when present; hard defaults
    // apply only when neither source specifies them.
    if (fs.existsSync(tfvarsPath)) {
        const content = fs.readFileSync(tfvarsPath, 'utf-8');

        // Use regex to pull values out of the HCL format
        const regionMatch = content.match(/aws_region\s*=\s*"([^"]+)"/);
        if (regionMatch) region = regionMatch[1];

        const cpuMatch = content.match(/container_cpu\s*=\s*(\d+)/);
        if (cpuMatch) cpu = parseInt(cpuMatch[1], 10);

        const memoryMatch = content.match(/container_memory\s*=\s*(\d+)/);
        if (memoryMatch) memory = parseInt(memoryMatch[1], 10);
    }

    // Check if database files exist
    const hasDb = fs.existsSync(path.join(tfDir, 'rds.tf')) || fs.existsSync(path.join(tfDir, 'database.tf'));
    const hasWorker = fs.existsSync(path.join(tfDir, 'worker.tf'));
    const hasSecrets = fs.existsSync(path.join(tfDir, 'secrets.tf'));

    // Registry-driven addon detection: capability keys whose .tf file exists.
    const addons = [];
    for (const [capability, entry] of Object.entries(ADDON_REGISTRY)) {
        if (!entry) continue;
        if (fs.existsSync(path.join(tfDir, entry.file))) addons.push(capability);
    }

    return { framework, region, cpu, memory, hasDb, hasWorker, hasSecrets, addons };
}

// 2. Calculate itemized monthly costs based on task definition settings
export function estimateMonthlyCost({ cpu = 256, memory = 512, hasDb = false, hasWorker = false, hasSecrets = false, addons = [] }) {
    const vCpu = cpu / 1024;
    const memGb = memory / 1024;
    const hoursInMonth = 730;

    // If a worker service exists, we are running a second identical Fargate task
    const taskMultiplier = hasWorker ? 2 : 1;

    const fargateCost = ((vCpu * PRICING_TABLE.fargate.cpuPerHour) +
        (memGb * PRICING_TABLE.fargate.memoryPerHour)) * hoursInMonth * taskMultiplier;
    const albCost = (PRICING_TABLE.alb.basePerHour + PRICING_TABLE.alb.lcuPerHour) * hoursInMonth;
    const dbCost = hasDb ? (PRICING_TABLE.rds.microPerHour * hoursInMonth) + PRICING_TABLE.rds.storagePerMonth : 0;

    // Secrets Manager bills per secret: one for the base app-secrets JSON
    // secret plus one for the RDS managed master password when hasDb is true.
    const secretCount = (hasSecrets ? 1 : 0) + (hasDb ? 1 : 0);
    const secretsCost = secretCount * PRICING_TABLE.secretsManagerPerSecret;

    // Future addons may carry a fixed monthly fee via cost.monthlyFixed.
    let addonsFixedCost = 0;
    for (const key of addons || []) {
        const entry = ADDON_REGISTRY[key];
        if (!entry) continue;
        if (entry.cost && entry.cost.monthlyFixed > 0) addonsFixedCost += entry.cost.monthlyFixed;
    }

    const total = fargateCost + albCost + dbCost + secretsCost + addonsFixedCost;

    return {
        fargateMonthly: fargateCost.toFixed(2),
        albMonthly: albCost.toFixed(2),
        dbMonthly: dbCost.toFixed(2),
        secretsMonthly: secretsCost.toFixed(2),
        totalMonthly: total.toFixed(2)
    };
}

// 3. Render the terminal architecture visualization and requests confirmation
export async function renderDryRunPreview(config, isDryRunFlag = false) {
    const { framework = 'Node.js', region = 'us-east-2', cpu = 256, memory = 512, hasDb = false, hasWorker = false, hasSecrets = false, addons = [] } = config;

    // Fixed the duplicate hasWorker argument
    const cost = estimateMonthlyCost({ cpu, memory, hasDb, hasWorker, hasSecrets, addons });

    const hourlyRate = (Number(cost.totalMonthly) / 730).toFixed(3); // 730 hours in a month
    const secretCount = (hasSecrets ? 1 : 0) + (hasDb ? 1 : 0);

    const costParts = [`Fargate: $${cost.fargateMonthly}`, `ALB: $${cost.albMonthly}`];
    if (hasDb) costParts.push(`RDS: $${cost.dbMonthly}`);
    if (Number(cost.secretsMonthly) > 0) costParts.push(`Secrets: $${cost.secretsMonthly}`);

    const validAddons = (addons || []).filter((key) => Boolean(ADDON_REGISTRY[key]));
    const addonNodes = [];
    for (const key of validAddons) {
        const entry = ADDON_REGISTRY[key];
        addonNodes.push(`  ${pc.gray('├──')} 🧩 [${pc.bold(entry.label)}] ${pc.dim(`(${key})`)}`);
    }
    const usageLine = validAddons.length > 0
        ? `  + Usage-based (${validAddons.length} addon${validAddons.length === 1 ? '' : 's'}): $0/mo fixed · per request, storage & egress`
        : '';

    // Flattened the tree to eliminate nesting and vertical bloat
    const treeOutput = [
        `${pc.bold('Topology')} (${pc.cyan(region)}):`,
        `  ${pc.gray('├──')} 🌐 ${pc.bold('ALB')} (Public Entry & Health: ${pc.green('200 OK')})`,
        `  ${pc.gray('├──')} 🔒 ${pc.bold('IAM OIDC')} (GitHub Auth) & 🐳 ${pc.bold('ECR')} (Registry)`,
        hasDb ? `  ${pc.gray('├──')} 🐘 ${pc.yellow('Amazon RDS')} (PostgreSQL managed instance)` : '',
        secretCount > 0 ? `  ${pc.gray('├──')} 🔑 [${pc.bold('Secrets Manager')} (${secretCount === 1 ? '1 secret' : `${secretCount} secrets`})]` : '',
        ...addonNodes,
        `  ${pc.gray(hasWorker ? '├──' : '└──')} 📦 ${pc.bold('ECS Web Service')} 🟢 ${pc.green(framework)} [${cpu} CPU / ${memory} MB]`,
        hasWorker ? `  ${pc.gray('└──')} 📦 ${pc.bold('ECS Worker Service')} 🔄 Background Tasks [${cpu} CPU / ${memory} MB]` : '',
        '',
        `${pc.bold('Fixed Baseline:')} ${pc.green(pc.bold(`~$${cost.totalMonthly}/mo`))} ${pc.dim(`(${costParts.join(', ')})`)}`,
        usageLine,
        `  ${pc.dim(`* ~$${hourlyRate}/hr (us-east-2 rates) · Destroy anytime: "npx deploy-stack destroy --yes"`)}`
    ].filter(Boolean).join('\n');

    note(treeOutput, 'Cloud Infrastructure Pre-Flight Inspection');

    // 4. Check if this is a dry run (print & exit) or full apply (prompt & proceed)
    if (isDryRunFlag) {
        return true;
    }

    const shouldProceed = await confirm({
        message: 'Review completed. Provision this infrastructure to AWS now?',
        initialValue: true
    });

    if (isCancel(shouldProceed) || !shouldProceed) {
        cancel('Operation canceled. No infrastructure was created.');
        trackEvent('infrastructure_applied', {
            success: false,
            status: 'cancelled_at_preview',
            ...buildCostTelemetryProps(config, cost),
        });
        await flushTelemetry();
        process.exit(0);
    }

    return true;
}

// Shared cost/shape telemetry properties so visualizer.js and apply.js emit
// the exact same shape. projectName flows into telemetry's hashed distinct_id,
// keeping per-project funnels joinable without storing raw names.
export function buildCostTelemetryProps(config = {}, costs = estimateMonthlyCost(config)) {
    return {
        projectName: config.projectName || path.basename(process.cwd()),
        estimated_monthly_usd: Number(costs.totalMonthly),
        cpu: config.cpu ?? 256,
        memory: config.memory ?? 512,
        has_db: Boolean(config.hasDb),
        has_worker: Boolean(config.hasWorker),
        addons: config.addons || [],
        addon_count: (config.addons || []).length,
    };
}

const DOC_COST_LINE = (total) =>
    `* **${COST_ESTIMATE_MARKER}** ~$${total}/month (us-east-2 reference rates; excludes variable traffic, ECR/CloudWatch storage, and usage-based addons)`;

function buildActiveAddonsSection(addons = []) {
    const lines = [];
    for (const key of addons || []) {
        const entry = ADDON_REGISTRY[key];
        if (!entry) continue;
        lines.push(`- \`${key}\` (${entry.label}): ${entry.cost.summary}`);
    }
    if (lines.length === 0) return '';
    return ['### Active Addons (Usage-Based)', '', ...lines].join('\n');
}

// Refresh the cost baseline (and usage-based addon list) in the generated
// deployment docs after `deploy-stack add`. Checks DEPLOYMENT.md first, then
// README.md; no-ops gracefully when neither file exists or the user removed
// the cost marker. Returns the updated file path, or null when untouched.
export function syncDocCostEstimate(cwd = process.cwd()) {
    const tfDir = path.join(cwd, 'terraform');
    if (!fs.existsSync(path.join(tfDir, 'main.tf'))) return null;

    let targetPath = null;
    for (const name of ['DEPLOYMENT.md', 'README.md']) {
        const candidate = path.join(cwd, name);
        if (!fs.existsSync(candidate)) continue;
        const content = fs.readFileSync(candidate, 'utf-8');
        if (content.includes(COST_ESTIMATE_MARKER) || content.includes(LEGACY_COST_ESTIMATE_MARKER)) {
            targetPath = candidate;
            break;
        }
    }
    if (!targetPath) return null;

    const detected = parseTerraformConfig(tfDir);
    const costs = estimateMonthlyCost(detected);

    const lines = fs.readFileSync(targetPath, 'utf-8').split('\n');
    const markerIdx = lines.findIndex(
        (line) => line.includes(COST_ESTIMATE_MARKER) || line.includes(LEGACY_COST_ESTIMATE_MARKER)
    );
    if (markerIdx === -1) return null;
    lines[markerIdx] = DOC_COST_LINE(costs.totalMonthly);

    // Drop any previously rendered Active Addons section (heading, blank
    // separators, and our `- \`key\`` bullets) so reruns replace rather than
    // duplicate it. Anything else is user content and stays untouched.
    const sectionIdx = lines.findIndex((line) => line.trim() === '### Active Addons (Usage-Based)');
    if (sectionIdx !== -1) {
        let endIdx = sectionIdx + 1;
        while (endIdx < lines.length && lines[endIdx].trim() === '') endIdx++;
        while (endIdx < lines.length && lines[endIdx].trim().startsWith('- `')) endIdx++;
        lines.splice(sectionIdx, endIdx - sectionIdx);
        if (lines[sectionIdx] === '' && lines[sectionIdx + 1] === '') lines.splice(sectionIdx, 1);
    }

    const section = buildActiveAddonsSection(detected.addons);
    if (section) {
        lines.splice(markerIdx + 1, 0, '', section);
    }

    fs.writeFileSync(targetPath, lines.join('\n'));
    return targetPath;
}