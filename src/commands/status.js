import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { runDiagnose } from './diagnose.js';

export const FALLBACK_REGION = 'us-east-2';
export const DEGRADED_MESSAGE = '⚠️ Degraded state detected. Running automated diagnostics...';

function readFileSafe(filePath) {
    try {
        if (fsSync.existsSync(filePath)) return fsSync.readFileSync(filePath, 'utf8');
    } catch {
        // Fall through to defaults
    }
    return null;
}

export function readTerraformRegion(cwd = process.cwd()) {
    const mainTf = readFileSafe(path.join(cwd, 'terraform', 'main.tf'));
    if (!mainTf) return null;
    const match = mainTf.match(/region\s*=\s*"([^"]+)"/);
    if (!match || match[1].includes('{{')) return null;
    return match[1];
}

export function resolveRegion(options = {}, cwd = process.cwd()) {
    if (typeof options.region === 'string' && options.region.trim()) {
        return options.region.trim();
    }
    if (typeof process.env.AWS_REGION === 'string' && process.env.AWS_REGION.trim()) {
        return process.env.AWS_REGION.trim();
    }
    return readTerraformRegion(options.cwd || cwd) || FALLBACK_REGION;
}

export function resolveProjectName(options = {}, cwd = process.cwd()) {
    const base = options.cwd || cwd;
    if (typeof options.projectName === 'string' && options.projectName.trim()) {
        return options.projectName.trim();
    }
    return path.basename(path.resolve(base));
}

export function parseStatusArgs(argv = []) {
    const args = [...argv];
    if (args[0] === 'status') args.shift();
    const options = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--json') {
            options.json = true;
        } else if (arg === '--region' && i + 1 < args.length) {
            options.region = args[++i];
        } else if (arg.startsWith('--region=')) {
            options.region = arg.slice('--region='.length);
        }
    }
    return options;
}

function normalizeAlarm(alarm) {
    return {
        name: alarm.AlarmName || alarm.name || 'unknown',
        state: alarm.StateValue || alarm.state || 'UNKNOWN',
        reason: alarm.StateReason || alarm.reason,
    };
}

export function getServiceHealth(serviceDesc, alarms = []) {
    const desiredCount = serviceDesc?.desiredCount ?? 0;
    const runningCount = serviceDesc?.runningCount ?? 0;
    const pendingCount = serviceDesc?.pendingCount ?? 0;
    const status = serviceDesc?.status || 'UNKNOWN';
    const normalizedAlarms = (alarms || []).map(normalizeAlarm);
    const alarmed = normalizedAlarms.filter((a) => a.state === 'ALARM');
    const healthy = Boolean(serviceDesc) && runningCount >= desiredCount && alarmed.length === 0;
    return { serviceDesc: serviceDesc || null, desiredCount, runningCount, pendingCount, status, alarms: normalizedAlarms, alarmed, healthy };
}

export function formatAlarmBadge(state) {
    if (state === 'ALARM') return color.red('[ALARM]');
    if (state === 'OK') return color.green('[OK]');
    if (state === 'INSUFFICIENT_DATA') return color.yellow('[INSUFFICIENT_DATA]');
    return color.dim(`[${state}]`);
}

function formatReplicas(runningCount, desiredCount, pendingCount) {
    const summary = `${runningCount}/${desiredCount}`;
    let painted = summary;
    if (runningCount <= 0) painted = color.red(summary);
    else if (runningCount < desiredCount) painted = color.yellow(summary);
    else painted = color.green(summary);
    if (pendingCount > 0) painted += color.dim(` (${pendingCount} pending)`);
    return painted;
}

function printDashboard({ serviceName, cluster, health }) {
    console.log('');
    console.log(`  ${color.bold('Service:')} ${color.cyan(serviceName)} ${health.status === 'ACTIVE' ? color.green('(ACTIVE)') : color.yellow(`(${health.status})`)}`);
    console.log(`  ${color.dim('Cluster:')} ${cluster}`);
    console.log(`  ${color.bold('Replicas:')} ${formatReplicas(health.runningCount, health.desiredCount, health.pendingCount)}`);
    if (health.alarms.length === 0) {
        console.log(`  ${color.bold('Alarms:')} ${color.dim('No alarms configured.')}`);
    } else {
        console.log(`  ${color.bold('Alarms:')}`);
        for (const alarm of health.alarms) {
            console.log(`    ${formatAlarmBadge(alarm.state)} ${alarm.name}`);
        }
    }
    console.log('');
}

function printSessionExpiredGuidance() {
    console.log(color.yellow('\n⚠️  AWS Session Expired / Invalid Credentials'));
    console.log(`Run ${color.cyan('aws sso login')} or ${color.cyan('aws configure')} to refresh your credentials.`);
}

export async function runStatus(options = {}) {
    const cwd = options.cwd || process.cwd();
    const region = resolveRegion(options, cwd);
    const projectName = resolveProjectName(options, cwd);
    const cluster = options.cluster || process.env.ECS_CLUSTER || `${projectName}-cluster`;
    const serviceName = options.service || process.env.ECS_SERVICE || `${projectName}-service`;
    const logGroup = options.logGroup || process.env.ECS_LOG_GROUP || `/ecs/${projectName}`;
    const asJson = Boolean(options.json);

    const ecsClient = (options.ecsClient && typeof options.ecsClient.send === 'function')
        ? options.ecsClient
        : new ECSClient({ region });
    const cloudWatchClient = (options.cloudWatchClient && typeof options.cloudWatchClient.send === 'function')
        ? options.cloudWatchClient
        : (options.cloudwatchClient && typeof options.cloudwatchClient.send === 'function')
            ? options.cloudwatchClient
            : new CloudWatchClient({ region });

    if (!asJson) intro(color.bgCyan(color.black(' deploy-stack status 📊 ')));

    const s = asJson ? null : spinner();
    if (s) s.start('Checking service health...');

    try {
        const svcResp = await ecsClient.send(new DescribeServicesCommand({ cluster, services: [serviceName] }));
        const serviceDesc = (svcResp.services || [])[0] || null;

        if (!serviceDesc || serviceDesc.status === 'INACTIVE') {
            if (s) s.stop(color.yellow('Service not found.'));
            console.log(`\n  The ECS service ${color.cyan(serviceName)} does not exist or is inactive.`);
            console.log(`  Run ${color.green('npx deploy-stack apply')} to provision your infrastructure.\n`);

            trackEvent('status_run', { projectName, success: true, healthy: false, missing: true });
            await flushTelemetry();

            if (asJson) return { healthy: false, missing: true, service: null, alarms: [], region };
            process.exit(0);
            return;
        }

        const alarmsResp = await cloudWatchClient.send(new DescribeAlarmsCommand({ AlarmNamePrefix: projectName, MaxRecords: 100 }));
        const rawAlarms = [...(alarmsResp.MetricAlarms || []), ...(alarmsResp.CompositeAlarms || [])];

        const health = getServiceHealth(serviceDesc, rawAlarms);
        const payload = {
            service: {
                name: serviceName,
                cluster,
                status: health.status,
                desiredCount: health.desiredCount,
                runningCount: health.runningCount,
                pendingCount: health.pendingCount,
            },
            alarms: health.alarms,
            healthy: health.healthy,
            region,
        };

        if (asJson) {
            console.log(JSON.stringify(payload, null, 2));
            trackEvent('status_run', { projectName, success: true, healthy: health.healthy, json: true });
            await flushTelemetry();
            return payload;
        }

        if (s) s.stop('Health check complete.\n');
        printDashboard({ serviceName, cluster, health });

        if (!health.healthy) {
            console.log(color.yellow(DEGRADED_MESSAGE));
            trackEvent('status_run', { projectName, success: false, healthy: false, degraded: true });
            await flushTelemetry();
            const diagnosis = await runDiagnose({ cluster, region, logGroup });
            process.exit(1);
            return { ...payload, diagnosis };
        }

        outro(color.green('All systems healthy. ✅'));
        trackEvent('status_run', { projectName, success: true, healthy: true });
        await flushTelemetry();
        return payload;
    } catch (error) {
        if (s) s.stop(color.red('❌ Status check failed.'));

        if (error && (error.name === 'UnrecognizedClientException' || error.name === 'ExpiredTokenException')) {
            printSessionExpiredGuidance();
        } else {
            console.log(color.red(`✖ ${error?.message || error}`));
            console.log(color.dim('Check your AWS credentials and region, then try again.'));
        }

        trackEvent('status_run', {
            projectName,
            success: false,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        await flushTelemetry();
        process.exit(1);
        return { healthy: false, service: null, alarms: [], region };
    }
}

// Convenience alias mirroring the CLI verb.
export const statusCommand = runStatus;

export default runStatus;
