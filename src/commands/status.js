import { spawnSync } from 'child_process';
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure } from '../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { handleAuthErrorBranch, resolveClient } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCwd, readTerraformComputeTarget } from '../utils/resolvers.js';
import { runDiagnose } from './diagnose.js';

export const DEGRADED_MESSAGE = '⚠️ Degraded state detected. Running automated diagnostics...';

export function parseStatusArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'status') args.shift();
    const { options } = parseFlags(args, {
        string: ['region'],
        bareBoolean: ['json'],
    });
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

export function getLambdaHealth(configuration = {}) {
    const state = configuration.State || 'UNKNOWN';
    const lastUpdateStatus = configuration.LastUpdateStatus || 'UNKNOWN';
    const healthy = state === 'Active' && lastUpdateStatus === 'Successful';
    return { state, lastUpdateStatus, healthy };
}

function printLambdaDashboard({ functionName, configuration, health }) {
    console.log('');
    console.log(`  ${color.bold('Function:')} ${color.cyan(functionName)} ${health.state === 'Active' ? color.green('(ACTIVE)') : color.yellow(`(${health.state})`)}`);
    console.log(`  ${color.bold('Last update:')} ${health.lastUpdateStatus === 'Successful' ? color.green(health.lastUpdateStatus) : color.yellow(health.lastUpdateStatus)}`);
    if (configuration.LastModified) console.log(`  ${color.dim('Modified:')} ${configuration.LastModified}`);
    if (configuration.MemorySize) console.log(`  ${color.dim('Memory:')} ${configuration.MemorySize} MB ${color.dim(`(timeout ${configuration.Timeout ?? '?'}s)`)}`);
    if (configuration.Code?.ImageUri) console.log(`  ${color.dim('Image:')} ${configuration.Code.ImageUri.split('/').pop()}`);
    console.log('');
}

// Lambda health via the AWS CLI (`get-function`), mirroring the ECS status
// flow above without adding an @aws-sdk/client-lambda dependency.
export async function runLambdaStatus(input = {}) {
    const options = normalizeOptions(input);
    const cwd = options.cwd || process.cwd();
    const region = options.region;
    const projectName = options.projectName;
    const functionName = typeof options.functionName === 'string' && options.functionName.trim()
        ? options.functionName.trim()
        : `${projectName}-fn`;
    const asJson = Boolean(options.json);
    const runSync = options.spawnSyncImpl || spawnSync;

    if (!asJson) intro(color.bgCyan(color.black(' deploy-stack status 📊 ')));

    const s = asJson ? null : spinner();
    if (s) s.start('Checking function health...');

    const res = runSync('aws', [
        'lambda', 'get-function',
        '--function-name', functionName,
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' });

    if (res?.error?.code === 'ENOENT') {
        if (s) s.stop(color.red('❌ Status check failed.'));
        await trackFailure('status_run', { projectName, error_code: 'AWS_CLI_MISSING' });
        return failCommand({
            message: '✖ The AWS CLI is required for Lambda status checks.',
            hint: 'Install it from https://aws.amazon.com/cli/, then try again.',
            reason: 'aws-cli-missing',
            resultExtra: { functionName, region },
        });
    }

    if (res?.status !== 0) {
        const detail = String(res?.stderr || res?.stdout || '').trim();
        if (/ResourceNotFound/i.test(detail)) {
            if (s) s.stop(color.yellow('Function not found.'));
            console.log(`\n  The Lambda function ${color.cyan(functionName)} does not exist.`);
            console.log(`  Run ${color.green('npx deploy-stack apply')} to provision your infrastructure.\n`);

            await trackSuccess('status_run', { projectName, healthy: false, missing: true });

            if (asJson) return { healthy: false, missing: true, function: null, region, computeTarget: 'lambda' };
            process.exit(0);
            return;
        }
        if (s) s.stop(color.red('❌ Status check failed.'));
        await trackFailure('status_run', { projectName, error_code: 'GET_FUNCTION_FAILED' });
        return failCommand({
            message: `✖ ${detail || 'aws lambda get-function failed.'}`,
            hint: 'Check your AWS credentials and region, then try again.',
            resultExtra: { functionName, region },
        });
    }

    let configuration;
    try {
        configuration = JSON.parse(res.stdout || '{}').Configuration || {};
    } catch {
        if (s) s.stop(color.red('❌ Status check failed.'));
        await trackFailure('status_run', { projectName, error_code: 'BAD_RESPONSE' });
        return failCommand({
            message: '✖ Could not parse the Lambda get-function response.',
            hint: 'Check your AWS CLI version, then try again.',
            resultExtra: { functionName, region },
        });
    }

    const health = getLambdaHealth(configuration);
    const payload = {
        function: {
            name: functionName,
            state: health.state,
            lastUpdateStatus: health.lastUpdateStatus,
            lastModified: configuration.LastModified,
            memorySize: configuration.MemorySize,
            timeout: configuration.Timeout,
            imageUri: configuration.Code?.ImageUri,
        },
        healthy: health.healthy,
        region,
        computeTarget: 'lambda',
    };

    if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
        await trackSuccess('status_run', { projectName, healthy: health.healthy, json: true });
        return payload;
    }

    if (s) s.stop('Health check complete.\n');
    printLambdaDashboard({ functionName, configuration, health });

    if (!health.healthy) {
        console.log(color.yellow(DEGRADED_MESSAGE));
        await trackFailure('status_run', { projectName, healthy: false, degraded: true });
        const diagnosis = await runDiagnose({ cwd, region });
        await failCommand({ exitCode: 1 });
        return { ...payload, diagnosis };
    }

    outro(color.green('All systems healthy. ✅'));
    await trackSuccess('status_run', { projectName, healthy: true });
    return payload;
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

export async function runStatus(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let projectName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'status_run' });
    }
    if (readTerraformComputeTarget(cwd) === 'lambda') {
        return runLambdaStatus({ ...options, cwd, region, projectName });
    }
    const cluster = options.cluster || process.env.ECS_CLUSTER || `${projectName}-cluster`;
    const serviceName = options.service || process.env.ECS_SERVICE || `${projectName}-service`;
    const logGroup = options.logGroup || process.env.ECS_LOG_GROUP || `/ecs/${projectName}`;
    const asJson = Boolean(options.json);

    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    // Both key casings are accepted for backward compatibility; first wins.
    const cloudWatchClient = resolveClient(
        options.cloudWatchClient ?? options.cloudwatchClient, CloudWatchClient, { region }
    );

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

            await trackSuccess('status_run', { projectName, healthy: false, missing: true });

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
            await trackSuccess('status_run', { projectName, healthy: health.healthy, json: true });
            return payload;
        }

        if (s) s.stop('Health check complete.\n');
        printDashboard({ serviceName, cluster, health });

        if (!health.healthy) {
            console.log(color.yellow(DEGRADED_MESSAGE));
            await trackFailure('status_run', { projectName, healthy: false, degraded: true });
            const diagnosis = await runDiagnose({ cluster, region, logGroup });
            await failCommand({ exitCode: 1 });
            return { ...payload, diagnosis };
        }

        outro(color.green('All systems healthy. ✅'));
        await trackSuccess('status_run', { projectName, healthy: true });
        return payload;
    } catch (error) {
        await trackFailure('status_run', {
            projectName,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        if (handleAuthErrorBranch(error, s, options)) {
            return { healthy: false, service: null, alarms: [], region };
        }

        if (s) s.stop(color.red('❌ Status check failed.'));
        return failCommand({
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
        });
    }
}

// Convenience alias mirroring the CLI verb.
export const statusCommand = runStatus;

export default runStatus;
