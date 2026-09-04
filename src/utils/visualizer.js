import { note, confirm, isCancel, cancel } from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';

// Cost benchmarks for AWS us-east-1 baseline (Fargate + ALB)
const PRICING_TABLE = {
    fargate: {
        cpuPerHour: 0.04048,   // per vCPU hour
        memoryPerHour: 0.004445 // per GB hour
    },
    alb: {
        basePerHour: 0.0225,   // ~$16.20/month
        lcuPerHour: 0.008      // Baseline ~1 LCU (~$5.76/month)
    },
    rds: {
        microPerHour: 0.016,   // ~$11.68/mo for db.t4g.micro
        storagePerMonth: 2.30  // 20GB gp3 storage baseline
    }
};

// 1. Parse the local terraform files to extract the actual configuration
export function parseTerraformConfig(tfDir) {
    const tfvarsPath = path.join(tfDir, 'terraform.tfvars');
    let region = 'us-east-1';
    let cpu = 256;
    let memory = 512;
    let framework = 'Application';

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

    return { framework, region, cpu, memory, hasDb };
}

// 2. Calculate itemized monthly costs based on task definition settings
export function estimateMonthlyCost({ cpu = 256, memory = 512, hasDb = false }) {
    const vCpu = cpu / 1024;
    const memGb = memory / 1024;
    const hoursInMonth = 730;

    const fargateCost = ((vCpu * PRICING_TABLE.fargate.cpuPerHour) +
        (memGb * PRICING_TABLE.fargate.memoryPerHour)) * hoursInMonth;
    const albCost = (PRICING_TABLE.alb.basePerHour + PRICING_TABLE.alb.lcuPerHour) * hoursInMonth;
    const dbCost = hasDb ? (PRICING_TABLE.rds.microPerHour * hoursInMonth) + PRICING_TABLE.rds.storagePerMonth : 0;

    const total = fargateCost + albCost + dbCost;

    return {
        fargateMonthly: fargateCost.toFixed(2),
        albMonthly: albCost.toFixed(2),
        dbMonthly: dbCost.toFixed(2),
        totalMonthly: total.toFixed(2)
    };
}

// 3. Render the terminal architecture visualization and requests confirmation
export async function renderDryRunPreview(config, isDryRunFlag = false) {
    const { framework = 'Node.js', region = 'us-east-1', cpu = 256, memory = 512, hasDb = false } = config;
    const cost = estimateMonthlyCost({ cpu, memory, hasDb });

    const hourlyRate = (cost.totalMonthly / 730).toFixed(3); // 730 hours in a month

    const treeOutput = [
        `${pc.bold('Topology')} (${pc.cyan(region)}):`,
        `  ${pc.gray('├──')} 🌐 ${pc.bold('ALB')} (Public Entry & Health: ${pc.green('200 OK')})`,
        `  ${pc.gray('├──')} 🔒 ${pc.bold('IAM OIDC')} (GitHub Auth) & 🐳 ${pc.bold('ECR')} (Registry)`,
        `  ${pc.gray('└──')} 📦 ${pc.bold('ECS Fargate Cluster')} 🟢 ${pc.green(framework)} [${cpu} CPU / ${memory} MB]`,
        hasDb ? `       └── 🛢️  ${pc.yellow('Amazon RDS')} (PostgreSQL managed instance)` : '',
        '',
        `${pc.bold('Est. Monthly Cost:')} ${pc.green(pc.bold(`~$${cost.totalMonthly}`))} ${pc.dim(`(ALB: $${cost.albMonthly}, Fargate: $${cost.fargateMonthly}${hasDb ? `, RDS: $${cost.dbMonthly}` : ''})`)}`,
        `  ${pc.dim(`* Hourly billing: ~$${hourlyRate}/hr. Destroy anytime with "npx deploy-stack destroy --yes"`)}`
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
        process.exit(0);
    }

    return true;
}