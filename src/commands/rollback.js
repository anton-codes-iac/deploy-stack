import {
    ECSClient,
    DescribeServicesCommand,
    ListTaskDefinitionsCommand,
    DescribeTaskDefinitionCommand,
    UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { intro, outro, spinner, select, isCancel } from '@clack/prompts';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { handleAwsAuthError } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCluster, resolveService } from '../utils/resolvers.js';

export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 300000;

function readFileSafe(filePath) {
    try {
        if (fsSync.existsSync(filePath)) return fsSync.readFileSync(filePath, 'utf8');
    } catch {
        // Fall through to defaults
    }
    return null;
}

// Mirrors the workspace pattern from src/commands/db.js so PR-preview
// environments resolve to their namespaced cluster/service names.
// Returns '' for the default workspace so names stay un-suffixed.
export function resolveWorkspaceSuffix(options = {}, cwd = process.cwd()) {
    const base = options.cwd || cwd;
    let workspace = null;
    if (typeof options.workspace === 'string' && options.workspace.trim()) {
        workspace = options.workspace.trim();
    } else {
        const detected = readFileSafe(path.join(base, '.terraform', 'environment'));
        if (typeof detected === 'string' && detected.trim()) workspace = detected.trim();
    }
    if (!workspace || workspace === 'default') return '';
    return `-${workspace}`;
}

export function parseRollbackArgs(argv = []) {
    const args = [...argv];
    if (args[0] === 'rollback') args.shift();
    const options = { skipWait: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--cluster' && i + 1 < args.length) {
            options.cluster = args[++i];
        } else if (arg.startsWith('--cluster=')) {
            options.cluster = arg.slice('--cluster='.length);
        } else if (arg === '--service' && i + 1 < args.length) {
            options.service = args[++i];
        } else if (arg.startsWith('--service=')) {
            options.service = arg.slice('--service='.length);
        } else if (arg === '--region' && i + 1 < args.length) {
            options.region = args[++i];
        } else if (arg.startsWith('--region=')) {
            options.region = arg.slice('--region='.length);
        } else if (arg === '--workspace' && i + 1 < args.length) {
            options.workspace = args[++i];
        } else if (arg.startsWith('--workspace=')) {
            options.workspace = arg.slice('--workspace='.length);
        } else if (arg === '--skip-wait') {
            options.skipWait = true;
        } else if (arg.startsWith('--skip-wait=')) {
            options.skipWait = arg.slice('--skip-wait='.length) === 'true';
        } else if (!arg.startsWith('-') && options.revision === undefined) {
            options.revision = arg;
        }
    }
    return options;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFamilyAndRevision(taskDefArn) {
    const familyAndRev = String(taskDefArn).split('/').pop();
    const [family, revStr] = familyAndRev.split(':');
    return { family, revNum: Number(revStr) };
}

function formatRegisteredAt(registeredAt) {
    if (registeredAt instanceof Date) return registeredAt.toISOString().slice(0, 10);
    if (registeredAt) return String(registeredAt).slice(0, 10);
    return '';
}

function isAuthError(error) {
    return !!error && (error.name === 'UnrecognizedClientException' || error.name === 'ExpiredTokenException');
}

export async function runRollback(options = {}) {
    const cwd = options.cwd || process.cwd();
    const region = resolveRegion(options, cwd);
    const projectName = resolveProjectName(options, cwd);

    // Namespace cluster/service for PR-preview workspaces; explicit
    // --cluster/--service flags still win inside the resolvers.
    const namespacedProject = `${projectName}${resolveWorkspaceSuffix(options, cwd)}`;
    const namespacedOptions = { ...options, projectName: namespacedProject };
    const cluster = resolveCluster(namespacedOptions, cwd);
    const service = resolveService(namespacedOptions, cwd);

    const headless = typeof options.isHeadless === 'boolean'
        ? options.isHeadless
        : Boolean(process.env.CI || !process.stdin.isTTY);

    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const ecsClient = (options.ecsClient && typeof options.ecsClient.send === 'function')
        ? options.ecsClient
        : new ECSClient({ region });

    intro(color.bgCyan(color.black(' deploy-stack rollback ⏪ ')));

    const s = spinner();
    s.start('Inspecting service and task revisions...');

    try {
        // 1. Fetch current service state.
        const svcResp = await ecsClient.send(new DescribeServicesCommand({ cluster, services: [service] }));
        const serviceDesc = (svcResp.services || [])[0] || null;

        if (!serviceDesc || serviceDesc.status !== 'ACTIVE') {
            s.stop(color.yellow('Service not found.'));
            console.log(`\n  The ECS service ${color.cyan(service)} does not exist or is inactive.`);
            console.log(`  Run ${color.green('npx deploy-stack apply')} to provision your infrastructure.\n`);
            trackEvent('rollback_run', { projectName, success: false, error_code: 'SERVICE_NOT_FOUND' });
            await flushTelemetry();
            process.exit(1);
            return { ok: false, reason: 'service-not-found', cluster, service, region };
        }

        const currentTaskDefArn = serviceDesc.taskDefinition;
        const { family, revNum: currentRevNum } = parseFamilyAndRevision(currentTaskDefArn);

        let targetTaskDefArn;
        let targetRevisionNum;

        if (options.revision !== undefined && options.revision !== null && String(options.revision).trim() !== '') {
            // Case A: explicit revision. A request for the currently deployed
            // revision is accepted silently; UpdateService with
            // forceNewDeployment still redeploys it.
            const rawRevision = String(options.revision).trim();
            const targetInput = /^\d+$/.test(rawRevision) ? `${family}:${rawRevision}` : rawRevision;
            let descResp;
            try {
                descResp = await ecsClient.send(new DescribeTaskDefinitionCommand({ taskDefinition: targetInput }));
            } catch {
                descResp = null;
            }
            if (!descResp?.taskDefinition || descResp.taskDefinition.status === 'INACTIVE') {
                s.stop(color.red('Revision not found.'));
                console.log(color.red(`\n✖ Task definition "${targetInput}" was not found in family "${family}".`));
                console.log(color.dim('List recent revisions with: aws ecs list-task-definitions --family-prefix ' + family + ` --region ${region}\n`));
                trackEvent('rollback_run', { projectName, success: false, error_code: 'REVISION_NOT_FOUND' });
                await flushTelemetry();
                process.exit(1);
                return { ok: false, reason: 'revision-not-found', cluster, service, region };
            }
            targetTaskDefArn = descResp.taskDefinition.taskDefinitionArn;
            targetRevisionNum = String(descResp.taskDefinition.revision);
            s.stop(`Resolved revision ${targetRevisionNum}.`);
        } else {
            // Case B: discover eligible older revisions.
            const listResp = await ecsClient.send(new ListTaskDefinitionsCommand({
                familyPrefix: family,
                status: 'ACTIVE',
                sort: 'DESC',
                maxResults: 10,
            }));
            const eligibleArns = (listResp.taskDefinitionArns || []).filter(
                (arn) => Number(arn.split(':').pop()) < currentRevNum
            );

            if (eligibleArns.length === 0) {
                s.stop(color.yellow('No previous revisions.'));
                console.log(color.yellow(`\n⚠ No previous task definition revisions found for family ${family}. Cannot roll back.\n`));
                trackEvent('rollback_run', { projectName, success: false, error_code: 'NO_PRIOR_REVISIONS' });
                await flushTelemetry();
                process.exit(1);
                return { ok: false, reason: 'no-prior-revisions', cluster, service, region };
            }

            if (headless) {
                targetTaskDefArn = eligibleArns[0];
                targetRevisionNum = targetTaskDefArn.split(':').pop();
                s.stop(`Selected previous revision ${targetRevisionNum}.`);
            } else {
                const candidates = eligibleArns.slice(0, 5);
                const settled = await Promise.allSettled(
                    candidates.map((arn) => ecsClient.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn })))
                );
                const promptOptions = candidates.map((arn, index) => {
                    const result = settled[index];
                    if (result.status === 'fulfilled') {
                        const taskDef = result.value?.taskDefinition || {};
                        const rev = taskDef.revision ?? arn.split(':').pop();
                        const rawImage = taskDef.containerDefinitions?.[0]?.image || 'unknown';
                        return {
                            value: arn,
                            label: `Revision ${rev} — ${rawImage.split('/').pop()}`,
                            hint: formatRegisteredAt(taskDef.registeredAt),
                        };
                    }
                    return {
                        value: arn,
                        label: `Revision ${arn.split(':').pop()} — unknown`,
                        hint: '',
                    };
                });
                s.stop('Found previous revisions.');
                const selectedArn = await select({
                    message: 'Select a task definition revision to roll back to:',
                    options: promptOptions,
                });
                if (isCancel(selectedArn)) {
                    outro(color.yellow('Rollback cancelled.'));
                    return { ok: false, reason: 'cancelled', cluster, service, region };
                }
                targetTaskDefArn = selectedArn;
                targetRevisionNum = targetTaskDefArn.split(':').pop();
            }
        }

        // 2. Trigger the rollback.
        s.start(`Rolling back ${service} to revision ${targetRevisionNum}...`);
        await ecsClient.send(new UpdateServiceCommand({
            cluster,
            service,
            taskDefinition: targetTaskDefArn,
            forceNewDeployment: true,
        }));

        if (options.skipWait === true) {
            s.stop(`Rollback to revision ${targetRevisionNum} triggered.`);
            trackEvent('rollback_run', { projectName, success: true, targetRevision: String(targetRevisionNum), skipWait: true });
            await flushTelemetry();
            outro(color.green(`Rollback to revision ${targetRevisionNum} initiated! 🚀`));
            return { ok: true, targetTaskDefArn, targetRevision: targetRevisionNum, cluster, service, region };
        }

        // 3. Monitor the deployment until it stabilizes or times out,
        // with live spinner updates on every non-terminal tick.
        const startTime = Date.now();
        const deadline = startTime + timeoutMs;
        while (true) {
            const pollResp = await ecsClient.send(new DescribeServicesCommand({ cluster, services: [service] }));
            const svc = (pollResp.services || [])[0] || null;
            const primary = svc?.deployments?.find(
                (d) => d.status === 'PRIMARY' && d.taskDefinition === targetTaskDefArn
            );

            if (primary && (primary.rolloutState === 'COMPLETED'
                || (primary.runningCount === primary.desiredCount
                    && primary.desiredCount > 0
                    && (svc.deployments || []).length === 1))) {
                s.stop(color.green(`Rolled back to revision ${targetRevisionNum}.`));
                trackEvent('rollback_run', { projectName, success: true, targetRevision: String(targetRevisionNum) });
                await flushTelemetry();
                outro(color.green(`Service successfully rolled back to revision ${targetRevisionNum}! 🚀`));
                return { ok: true, targetTaskDefArn, targetRevision: targetRevisionNum, cluster, service, region };
            }

            if (primary?.rolloutState === 'FAILED') {
                s.stop(color.red('❌ Rollback deployment failed.'));
                console.log(color.red('\n✖ The rollback deployment failed to stabilize.'));
                console.log(`  Check service health with ${color.green('npx deploy-stack status')} and recent output with ${color.green('npx deploy-stack logs')}.\n`);
                trackEvent('rollback_run', { projectName, success: false, error_code: 'ROLLOUT_FAILED', targetRevision: String(targetRevisionNum) });
                await flushTelemetry();
                process.exit(1);
                return { ok: false, reason: 'rollout-failed', cluster, service, region };
            }

            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            if (!primary) {
                s.message(`Rolling back ${service} to revision ${targetRevisionNum}... [${elapsedSec}s] (registering deployment...)`);
            } else {
                const runningCount = primary.runningCount ?? 0;
                const desiredCount = primary.desiredCount ?? 0;
                const pendingCount = primary.pendingCount ?? 0;
                const failedTasks = primary.failedTasks ?? 0;
                if (failedTasks > 0) {
                    s.message(`Rolling back ${service} to revision ${targetRevisionNum}... [${elapsedSec}s] (${runningCount}/${desiredCount} running, ${pendingCount} pending, ${failedTasks} failed ⚠️ — container crashing)`);
                } else if (runningCount >= desiredCount && desiredCount > 0 && pendingCount === 0) {
                    s.message(`Rolling back ${service} to revision ${targetRevisionNum}... [${elapsedSec}s] (${runningCount}/${desiredCount} running — draining previous tasks)`);
                } else {
                    s.message(`Rolling back ${service} to revision ${targetRevisionNum}... [${elapsedSec}s] (${runningCount}/${desiredCount} running, ${pendingCount} pending)`);
                }
            }

            if (Date.now() >= deadline) {
                s.stop(color.yellow('⚠ Rollback timed out waiting for ECS stabilization.'));
                console.log(color.yellow('\n⚠ The rollback is still in progress.'));
                console.log(`  Check progress with ${color.green('npx deploy-stack status')}.\n`);
                trackEvent('rollback_run', { projectName, success: false, error_code: 'ROLLOUT_TIMEOUT', targetRevision: String(targetRevisionNum) });
                await flushTelemetry();
                process.exit(1);
                return { ok: false, reason: 'rollout-timeout', cluster, service, region };
            }

            await sleep(pollIntervalMs);
        }
    } catch (error) {
        if (isAuthError(error)) {
            trackEvent('rollback_run', { projectName, success: false, error_code: 'AUTH_EXPIRED' });
            await flushTelemetry();
            handleAwsAuthError(error, s, options);
            return { ok: false, reason: 'auth-error', cluster, service, region };
        }
        trackEvent('rollback_run', {
            projectName,
            success: false,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        await flushTelemetry();
        s.stop(color.red('❌ Rollback failed.'));
        console.log(color.red(`✖ ${error?.message || error}`));
        console.log(color.dim('Check your AWS credentials and region, then try again.'));
        process.exit(1);
        return { ok: false, reason: 'error', cluster, service, region };
    }
}

// Convenience alias mirroring the CLI verb.
export const rollbackCommand = runRollback;

export default runRollback;
