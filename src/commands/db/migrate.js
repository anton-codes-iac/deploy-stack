import {
    ECSClient,
    DescribeTasksCommand,
    DescribeTaskDefinitionCommand,
    RunTaskCommand,
    StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, FilterLogEventsCommand, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import color from 'picocolors';
import { intro, outro, spinner, text, isCancel } from '@clack/prompts';
import { trackSuccess, trackFailure } from '../../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../../utils/args.js';
import { handleAuthErrorBranch, resolveClient } from '../../utils/aws.js';
import {
    resolveRegion,
    resolveProjectName,
    resolveCluster,
    resolveService,
    resolveLogGroup,
    resolveAppName,
    resolveHeadless,
    resolveCwd,
} from '../../utils/resolvers.js';
import { detectMigrationCommand } from '../../utils/detector.js';
import { fetchActiveService, resolveContainer, pickRuntimeContainer } from '../../utils/ecs.js';
import { sleep, pollUntil, parseTimeoutSeconds } from '../../utils/system.js';
import { isNotFoundError, buildLogStreamName } from '../logs.js';
import fsSync from 'fs';
import path from 'path';

export const DEFAULT_MIGRATE_TIMEOUT_SECONDS = 600;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
export const DEFAULT_FLUSH_MAX_POLLS = 6;
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;

export const GATE_START_MARKER = '# deploy-stack:db-migrate-start';
export const GATE_END_MARKER = '# deploy-stack:db-migrate-end';

export function parseDbMigrateArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'db') args.shift();
    if (args[0] === 'migrate') args.shift();
    const { options, rest } = parseFlags(args, {
        string: [
            { name: 'cmd', key: 'cmd' },
            { name: 'task-def', key: 'taskDef' },
            { name: 'timeout', key: 'timeout' },
            { name: 'project-name', key: 'projectName' },
            { name: 'region', key: 'region' },
            { name: 'workspace', key: 'workspace' },
            { name: 'cluster', key: 'cluster' },
            { name: 'service', key: 'service' },
            { name: 'container', key: 'container' },
        ],
        boolean: ['setup-ci', 'headless'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.unexpectedPositionals = positionals;
    return options;
}

// Single-quote a shell argument for embedding in the workflow `run: |` block
// (literal block scalars need no YAML escaping).
export function quoteShellArg(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function renderGateBlock({ cmd, includeSetupNode, taskDefRef }) {
    const lines = [`      ${GATE_START_MARKER}`];
    if (includeSetupNode) {
        lines.push(
            '      - name: Setup Node.js for migrations',
            '        uses: actions/setup-node@v4',
            '        with:',
            "          node-version: '20'",
            ''
        );
    }
    lines.push(
        '      - name: Pre-Deploy Database Migration',
        '        run: |',
        `          npx deploy-stack db migrate --cmd ${quoteShellArg(cmd)} --task-def "${taskDefRef}" --headless`,
        `      ${GATE_END_MARKER}`
    );
    return `${lines.join('\n')}\n`;
}

// Idempotently injects (or refreshes) the migration gate block into a
// deploy.yml document. Returns the updated content, or null when neither
// anchor step is present. Pure and unit-tested.
export function injectMigrationGate(workflowContent, { cmd }) {
    const content = String(workflowContent ?? '');
    const taskDefRef = '${{ steps.register-task-def.outputs.task-arn }}';

    // Strip any previous gate block first so the setup-node check below
    // never matches a node step that only exists inside the old block.
    let base = content;
    const startIdx = base.indexOf(GATE_START_MARKER);
    const endIdx = base.indexOf(GATE_END_MARKER);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const lineStart = base.lastIndexOf('\n', startIdx) + 1;
        const lineEnd = base.indexOf('\n', endIdx);
        base = base.slice(0, lineStart) + base.slice(lineEnd === -1 ? base.length : lineEnd + 1);
    }

    const includeSetupNode = !base.includes('actions/setup-node');
    const block = renderGateBlock({ cmd, includeSetupNode, taskDefRef });

    const forceIdx = base.indexOf('- name: Force ECS deployment');
    if (forceIdx === -1) return null;
    const insertAt = base.lastIndexOf('\n', forceIdx) + 1;
    return `${base.slice(0, insertAt)}${block}${base.slice(insertAt)}`;
}

// Identity keys for one log line. FilterLogEvents results carry `eventId`
// but GetLogEvents results do not, so every line registers its
// timestamp:message fingerprint (present in both APIs) plus its `eventId`
// when it has one — the final head-flush then never reprints live lines.
function eventKeys(event) {
    const keys = [`${event.timestamp ?? ''}:${event.message ?? ''}`];
    if (event.eventId) keys.push(`id:${event.eventId}`);
    return keys;
}

function printNewEvents(events, seen) {
    if (seen.size > 5000) seen.clear();
    for (const event of events || []) {
        const keys = eventKeys(event);
        if (keys.some((key) => seen.has(key))) continue;
        for (const key of keys) seen.add(key);
        console.log(String(event.message ?? '').replace(/\n$/, ''));
    }
}

// Live tail: FilterLogEvents scoped to the single task stream. `startTime`
// is deliberately omitted — the stream is unique per task run, so there is
// nothing stale to exclude and local clock skew can never drop early lines.
async function fetchNewLogEvents({ logsClient, logGroupName, logStreamName, seen }) {
    let events = [];
    try {
        const resp = await logsClient.send(new FilterLogEventsCommand({
            logGroupName,
            logStreamNames: [logStreamName],
        }));
        events = resp.events || [];
    } catch (error) {
        // The stream does not exist until the container starts emitting.
        if (isNotFoundError(error)) return;
        throw error;
    }
    printNewEvents(events, seen);
}

// Final flush: GetLogEvents reads the exact stream from the head, catching
// anything the live tail missed (Fargate ingestion lags several seconds on
// sub-second commands). Shares the `seen` set so lines print exactly once.
async function flushRemainingLogs({ logsClient, logGroupName, logStreamName, seen }) {
    let nextToken;
    for (;;) {
        let resp;
        try {
            resp = await logsClient.send(new GetLogEventsCommand({
                logGroupName,
                logStreamName,
                startFromHead: true,
                ...(nextToken ? { nextToken } : {}),
            }));
        } catch (error) {
            if (isNotFoundError(error)) return;
            throw error;
        }
        printNewEvents(resp.events, seen);
        const forward = resp.nextForwardToken;
        if (!forward || forward === nextToken) return;
        nextToken = forward;
    }
}

export async function runDbMigrate(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let projectName;
    let cluster;
    let service;
    let containerName;
    let logGroupName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
        const appName = resolveAppName(projectName, options.workspace, cwd);
        const namespacedOptions = { ...options, projectName: appName };
        cluster = resolveCluster(namespacedOptions, cwd);
        service = resolveService(namespacedOptions, cwd);
        containerName = resolveContainer(namespacedOptions, cwd);
        logGroupName = resolveLogGroup(namespacedOptions, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'db_migrate_run' });
    }
    const headless = resolveHeadless(options);

    const setupCi = options.setupCi === true || options.setupCi === 'true';

    intro(color.bgCyan(color.black(' deploy-stack db migrate 🚀 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Wrap multi-word --cmd values in quotes: --cmd "${options.unexpectedPositionals.join(' ')}".\n`,
            event: 'db_migrate_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { cluster, service, region },
        });
    }

    const timeoutSeconds = parseTimeoutSeconds(options.timeout, DEFAULT_MIGRATE_TIMEOUT_SECONDS);
    if (timeoutSeconds === null) {
        return failCommand({
            message: `\n✖ Invalid --timeout "${options.timeout}". Use a positive number of seconds (default ${DEFAULT_MIGRATE_TIMEOUT_SECONDS}).\n`,
            event: 'db_migrate_run',
            telemetry: { projectName },
            errorCode: 'INVALID_TIMEOUT',
            reason: 'invalid-timeout',
            resultExtra: { cluster, service, region },
        });
    }

    // 1. Resolve the migration command (shared by live runs and --setup-ci).
    let resolvedCmd = null;
    let cmdSource = null;
    if (typeof options.cmd === 'string' && options.cmd.trim()) {
        resolvedCmd = options.cmd.trim();
        cmdSource = 'explicit';
    } else {
        const detectedCmd = detectMigrationCommand(cwd);
        if (!headless) {
            const answer = await text({
                message: 'Migration command to run inside the VPC:',
                placeholder: 'e.g. npx prisma migrate deploy',
                initialValue: detectedCmd || '',
            });
            if (isCancel(answer) || typeof answer !== 'string' || !answer.trim()) {
                outro(color.yellow('Migration cancelled.'));
                return { ok: false, reason: 'cancelled', cluster, service, region };
            }
            resolvedCmd = answer.trim();
            cmdSource = 'prompted';
        } else if (detectedCmd) {
            resolvedCmd = detectedCmd;
            cmdSource = 'detected';
            console.log(color.dim(`  Using detected migration command: ${resolvedCmd}`));
        } else {
            return failCommand({
                message: '\n✖ No migration command found. Pass --cmd "<command>" (e.g. --cmd "npx prisma migrate deploy").\n',
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: 'none', ci_setup: setupCi },
                errorCode: 'MISSING_MIGRATION_CMD',
                reason: 'missing-migration-cmd',
                resultExtra: { cluster, service, region },
            });
        }
    }

    // 2. --setup-ci: patch the workflow file, no AWS calls.
    if (setupCi) {
        const workflowFile = path.join(cwd, '.github', 'workflows', 'deploy.yml');
        let workflowContent = null;
        try {
            if (fsSync.existsSync(workflowFile)) workflowContent = fsSync.readFileSync(workflowFile, 'utf8');
        } catch {
            workflowContent = null;
        }
        if (workflowContent === null) {
            return failCommand({
                message: `\n✖ Workflow not found at ${color.cyan('.github/workflows/deploy.yml')}. Run ${color.green('npx deploy-stack init')} first.\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: true },
                errorCode: 'WORKFLOW_NOT_FOUND',
                reason: 'workflow-not-found',
                resultExtra: { cluster, service, region },
            });
        }
        const updated = injectMigrationGate(workflowContent, { cmd: resolvedCmd });
        if (updated === null) {
            return failCommand({
                message: '\n✖ Could not find the task-definition registration or ECS deployment step in .github/workflows/deploy.yml to anchor the migration gate.\n',
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: true },
                errorCode: 'WORKFLOW_ANCHOR_NOT_FOUND',
                reason: 'workflow-anchor-not-found',
                resultExtra: { cluster, service, region },
            });
        }
        fsSync.writeFileSync(workflowFile, updated, 'utf8');
        console.log(color.green('\n✅ Pre-deploy migration gate installed in .github/workflows/deploy.yml.'));
        console.log(color.dim('  Migrations now run against the new image revision before the ECS service updates.\n'));
        await trackSuccess('db_migrate_run', { projectName, cmd_source: cmdSource, ci_setup: true });
        outro(color.green('Setup complete.'));
        return { ok: true, ciSetup: true, workflowFile, cmdSource };
    }

    // 3. Live run: discover the service and launch a one-off task.
    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    const logsClient = resolveClient(options.logsClient ?? options.cloudwatchClient, CloudWatchLogsClient, { region });
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxFlushPolls = options.maxFlushPolls ?? DEFAULT_FLUSH_MAX_POLLS;
    const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? timeoutSeconds * 1000;

    const s = spinner();
    s.start('Starting migration task...');

    let taskArn = null;
    const onSigint = () => {
        if (taskArn) {
            ecsClient.send(new StopTaskCommand({
                cluster,
                task: taskArn,
                reason: 'Cancelled by user via SIGINT',
            })).catch(() => {});
        }
        process.exit(130);
    };

    try {
        const serviceDesc = await fetchActiveService(ecsClient, cluster, service);
        if (!serviceDesc) {
            s.stop(color.yellow('Service not found.'));
            return failCommand({
                print: () => {
                    console.log(`\n  The ECS service ${color.cyan(service)} does not exist or is inactive.`);
                    console.log(`  Run ${color.green('npx deploy-stack apply')} to provision your infrastructure.\n`);
                },
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                errorCode: 'ECS_SERVICE_NOT_FOUND',
                reason: 'ecs-service-not-found',
                resultExtra: { cluster, service, region },
            });
        }

        const vpcConfig = serviceDesc.networkConfiguration?.awsvpcConfiguration;
        const subnets = vpcConfig?.subnets || [];
        const securityGroups = vpcConfig?.securityGroups || [];
        if (subnets.length === 0 || securityGroups.length === 0) {
            s.stop(color.red('Service has no VPC configuration.'));
            return failCommand({
                message: `\n✖ The ECS service ${color.cyan(service)} has no VPC network configuration, so the migration task cannot be placed.\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                errorCode: 'RUN_TASK_FAILED',
                reason: 'run-task-failed',
                resultExtra: { cluster, service, region },
            });
        }
        // Mirror the service's own placement; the generated service uses
        // public subnets with ENABLED, custom private-subnet services inherit
        // their own value instead of a hard-coded default.
        const assignPublicIp = vpcConfig.assignPublicIp || 'ENABLED';

        const targetTaskDef = (typeof options.taskDef === 'string' && options.taskDef.trim())
            ? options.taskDef.trim()
            : serviceDesc.taskDefinition;
        const taskDefResp = await ecsClient.send(
            new DescribeTaskDefinitionCommand({ taskDefinition: targetTaskDef })
        );
        const selected = pickRuntimeContainer(taskDefResp.taskDefinition, containerName);
        if (!selected || selected.name !== containerName) {
            s.stop(color.red('Container not found.'));
            return failCommand({
                message: `\n✖ Container "${containerName}" does not exist in task definition "${targetTaskDef}".\n`,
                hint: `Override with --container <name>. Available: ${(taskDefResp.taskDefinition?.containerDefinitions || []).map((c) => c.name).join(', ') || 'none'}\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                errorCode: 'CONTAINER_NOT_FOUND',
                reason: 'container-not-found',
                resultExtra: { cluster, service, region },
            });
        }

        // Stream coordinates from the task definition itself so custom log
        // drivers, groups, and stream prefixes always match the live tail.
        const logOptions = selected.logConfiguration?.options || {};
        if (typeof logOptions['awslogs-group'] === 'string' && logOptions['awslogs-group']) {
            logGroupName = logOptions['awslogs-group'];
        }
        let logStreamPrefix = 'ecs';
        if (typeof logOptions['awslogs-stream-prefix'] === 'string' && logOptions['awslogs-stream-prefix']) {
            logStreamPrefix = logOptions['awslogs-stream-prefix'];
        }
        const runResp = await ecsClient.send(new RunTaskCommand({
            cluster,
            taskDefinition: targetTaskDef,
            launchType: 'FARGATE',
            networkConfiguration: { awsvpcConfiguration: { subnets, securityGroups, assignPublicIp } },
            startedBy: 'deploy-stack-db-migrate',
            overrides: { containerOverrides: [{ name: containerName, command: ['sh', '-c', resolvedCmd] }] },
        }));
        taskArn = runResp.tasks?.[0]?.taskArn || null;
        if (!taskArn || (runResp.failures || []).length > 0) {
            const failureReason = runResp.failures?.[0]?.reason || 'no task ARN returned';
            s.stop(color.red('Failed to start migration task.'));
            taskArn = null;
            return failCommand({
                message: `\n✖ ECS could not start the migration task: ${failureReason}.\n`,
                event: 'db_migrate_run',
                telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                errorCode: 'RUN_TASK_FAILED',
                reason: 'run-task-failed',
                resultExtra: { cluster, service, region },
            });
        }
        const taskId = taskArn.split('/').pop();
        const logStreamName = buildLogStreamName(containerName, taskId, logStreamPrefix);
        const seen = new Set();

        // Registered immediately so Ctrl+C aborts even while provisioning;
        // the task line itself prints once the spinner stops (below) so the
        // two never share a terminal line.
        process.once('SIGINT', onSigint);

        let finalTask = null;
        let streaming = false;
        let lastPhase = null;
        const shortTaskId = taskId.slice(0, 8);
        const phaseMessage = (status) => {
            if (status === 'PROVISIONING' || status === 'PENDING' || status === 'ACTIVATING') {
                return `Starting migration task (${status}, ${shortTaskId})...`;
            }
            return `Waiting on Fargate task (${status}, ${shortTaskId})...`;
        };
        // Strict by name only — never the containers[0] fallback: a sidecar
        // finishing first must not end the migration early.
        const matchContainerStrict = (task) => {
            const list = task?.containers || [];
            return list.find((c) => c.name === containerName) || null;
        };
        try {
            const outcome = await pollUntil({
                intervalMs: pollIntervalMs,
                timeoutMs,
                onTick: async () => {
                    await fetchNewLogEvents({ logsClient, logGroupName, logStreamName, seen });
                    const descResp = await ecsClient.send(
                        new DescribeTasksCommand({ cluster, tasks: [taskArn] })
                    );
                    const task = (descResp.tasks || [])[0] || null;
                    const status = task?.lastStatus;
                    const match = matchContainerStrict(task);
                    const containerDone = !!match
                        && match.lastStatus === 'STOPPED'
                        && typeof match.exitCode === 'number';
                    if ((task && status === 'STOPPED') || containerDone) {
                        // Flush CloudWatch (retrying while nothing has printed
                        // yet: Fargate ingestion lags several seconds), then
                        // stop the task if Fargate has not already done so.
                        for (let attempt = 0; ; attempt++) {
                            await flushRemainingLogs({ logsClient, logGroupName, logStreamName, seen });
                            if (seen.size > 0 || attempt + 1 >= maxFlushPolls) break;
                            await sleep(flushIntervalMs);
                        }
                        if (task?.lastStatus !== 'STOPPED') {
                            try {
                                await ecsClient.send(new StopTaskCommand({
                                    cluster,
                                    task: taskArn,
                                    reason: 'Migration container finished; stopping task',
                                }));
                            } catch {
                                // Best-effort: the result below is authoritative.
                            }
                        }
                        if (!streaming) s.stop('Migration task stopped.');
                        return { done: true, value: task };
                    }
                    if (status === 'RUNNING' && !streaming) {
                        streaming = true;
                        s.stop(color.green('Migration container running. Streaming logs...'));
                        console.log(color.dim(`  task ${taskId} — press Ctrl+C to abort and stop the remote task.\n`));
                    } else if (!streaming && status && status !== lastPhase) {
                        lastPhase = status;
                        s.message(phaseMessage(status));
                    }
                    return { done: false };
                },
            });
            if (outcome.timedOut) {
                try {
                    await ecsClient.send(new StopTaskCommand({
                        cluster,
                        task: taskArn,
                        reason: `Migration timed out after ${timeoutSeconds}s`,
                    }));
                } catch {
                    // Best-effort: the timeout below is authoritative.
                }
                try { s.stop(color.yellow('Migration timed out.')); } catch { /* already stopped */ }
                return failCommand({
                    message: `\n✖ Migration timed out after ${timeoutSeconds}s. The task was stopped (best-effort); increase --timeout and retry.\n`,
                    event: 'db_migrate_run',
                    telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
                    errorCode: 'MIGRATION_TIMEOUT',
                    reason: 'migration-timeout',
                    resultExtra: { cluster, service, region, taskArn },
                });
            }
            finalTask = outcome.value;
        } finally {
            process.removeListener('SIGINT', onSigint);
        }

        const containers = finalTask?.containers || [];
        const match = containers.find((c) => c.name === containerName) || containers[0];
        const exitCode = match?.exitCode;
        const stoppedReason = match?.reason || finalTask?.stoppedReason || 'unknown';
        if (exitCode === 0) {
            console.log(color.green('\n✅ Migration succeeded.'));
            await trackSuccess('db_migrate_run', { projectName, cmd_source: cmdSource, ci_setup: false });
            outro(color.green('Done.'));
            return { ok: true, success: true, exitCode: 0, taskArn };
        }
        const propagated = (typeof exitCode === 'number' && exitCode > 0) ? exitCode : 1;
        return failCommand({
            message: `\n✖ Migration failed with exit code ${exitCode ?? 'unknown'}: ${stoppedReason}.\n`,
            event: 'db_migrate_run',
            telemetry: { projectName, cmd_source: cmdSource, ci_setup: false },
            errorCode: 'MIGRATION_TASK_FAILED',
            extra: { exit_code: exitCode ?? -1 },
            reason: 'migration-task-failed',
            resultExtra: { cluster, service, region, taskArn },
            exitCode: propagated,
        });
    } catch (error) {
        await trackFailure('db_migrate_run', {
            projectName,
            cmd_source: cmdSource,
            ci_setup: false,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        if (handleAuthErrorBranch(error, s, options)) {
            return { ok: false, reason: 'error', cluster, service, region };
        }
        try { s.stop(color.red('❌ Db migrate failed.')); } catch { /* spinner already stopped */ }
        return failCommand({
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            reason: 'error',
            resultExtra: { cluster, service, region },
        });
    }
}

export default runDbMigrate;
