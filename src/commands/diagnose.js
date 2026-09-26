import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { handleAwsAuthError } from '../utils/aws.js';

export const LOG_FETCH_LIMIT = 50;

export function extractStoppedReason(task) {
    return task?.stoppedReason || 'Unknown';
}

export function getFailingContainer(task) {
    const containers = task?.containers || [];
    return (
        containers.find((c) => c.exitCode !== undefined && c.exitCode !== 0) ||
        containers.find((c) => c.reason && c.reason !== 'Essential container in task exited') ||
        containers[0] ||
        {}
    );
}

function taskActivityTime(task) {
    // Prefer container exit time over ENI deprovisioning time when present.
    const stamp = task?.executionStoppedAt ?? task?.stoppingAt ?? task?.stoppedAt
        ?? task?.startedAt ?? task?.createdAt;
    if (stamp === undefined || stamp === null) return 0;
    return new Date(stamp).getTime() || 0;
}

// Parses `.../task-definition/<family>:<revision>` (ECS-managed format).
// Returns null when the ARN is missing or doesn't match, so callers fail
// closed into the timestamp rule below.
export function parseTaskDefinitionRef(taskDefinitionArn) {
    if (typeof taskDefinitionArn !== 'string') return null;
    const match = taskDefinitionArn.match(/task-definition\/([^/:]+):(\d+)\s*$/);
    if (!match) return null;
    return { family: match[1], revision: parseInt(match[2], 10) };
}

function taskStartTime(task) {
    const stamp = task?.startedAt ?? task?.createdAt;
    if (stamp === undefined || stamp === null) return 0;
    return new Date(stamp).getTime() || 0;
}

export function formatAge(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

export function pickMostRecentTask(tasks) {
    if (!tasks || tasks.length === 0) return null;
    return [...tasks].sort((a, b) => taskActivityTime(b) - taskActivityTime(a))[0];
}

export function extractTaskIdFromArn(taskArn) {
    if (typeof taskArn !== 'string' || !taskArn.includes('/')) return '';
    return taskArn.split('/').pop() || '';
}

function isLogGroupNotFoundError(error) {
    return !!error && error.name === 'ResourceNotFoundException';
}

export async function runDiagnose(options = {}) {
    const projectName = path.basename(process.cwd());

    // Attempt to read the region from the generated Terraform variables
    let autoRegion = 'us-east-2';
    try {
        const mainTfPath = path.join(process.cwd(), 'terraform', 'main.tf');
        if (fsSync.existsSync(mainTfPath)) {
            const mainTf = fsSync.readFileSync(mainTfPath, 'utf8');
            // Matches: region = "us-east-2"
            const regionMatch = mainTf.match(/region\s*=\s*"([^"]+)"/);
            if (regionMatch) autoRegion = regionMatch[1];
        }
    } catch (e) {
        // Fallback silently
    }

    const region = (typeof options.region === 'string' && options.region.trim())
        ? options.region
        : (process.env.AWS_REGION || autoRegion);
    const cluster = options.cluster || process.env.ECS_CLUSTER || `${projectName}-cluster`;
    const logGroup = options.logGroup || process.env.ECS_LOG_GROUP || `/ecs/${projectName}`;

    intro(color.bgCyan(color.black(' deploy-stack diagnose 🩺 ')));

    const s = spinner();
    s.start('Looking up recent stopped ECS tasks...');

    const ecsClient = (options.ecsClient && typeof options.ecsClient.send === 'function')
        ? options.ecsClient
        : new ECSClient({ region });

    const logsClient = (options.logsClient && typeof options.logsClient.send === 'function')
        ? options.logsClient
        : new CloudWatchLogsClient({ region });

    try {
        const listResp = await ecsClient.send(
            new ListTasksCommand({
                cluster,
                desiredStatus: 'STOPPED',
                sort: 'DESC',
                maxResults: 100
            })
        );

        const taskArns = listResp.taskArns || [];

        if (taskArns.length === 0) {
            s.stop('No stopped tasks found.');
            console.log(color.green('✅ No stopped tasks — your service looks healthy.'));
            outro(color.green('Diagnose complete. Nothing to fix!'));
            trackEvent('diagnose_run', { success: true, healthy: true, log_source: 'none' });
            await flushTelemetry();
            return { healthy: true, stoppedReason: null, logs: [] };
        }

        // ListTasks order is arbitrary — describe the full batch (up to the
        // DescribeTasks 100-ARN limit) and pick the latest stopped task below.
        s.message(`Describing ${Math.min(taskArns.length, 100)} stopped task(s)...`);
        const descResp = await ecsClient.send(
            new DescribeTasksCommand({
                cluster,
                tasks: taskArns.slice(0, 100)
            })
        );

        const tasks = descResp.tasks || [];
        if (tasks.length === 0) {
            s.stop('No task details returned.');
            console.log(color.yellow('⚠ Stopped task ARNs were listed, but ECS returned no task details.'));
            outro(color.yellow('Diagnose finished with no details.'));
            trackEvent('diagnose_run', { success: false, error_code: 'NO_TASK_DETAILS', log_source: 'none' });
            await flushTelemetry();
            return { healthy: false, stoppedReason: null, logs: [] };
        }

        const failedTask = pickMostRecentTask(tasks);
        const stoppedReason = extractStoppedReason(failedTask);
        const failingContainer = getFailingContainer(failedTask);
        const containerName = failingContainer.name || 'unknown';
        const exitCode = failingContainer.exitCode;
        const containerReason = failingContainer.reason;

        // A STOPPED task from an old crash lingers in ECS for ~1h. If a
        // RUNNING task started after the latest stop, the service has already
        // recovered — report that instead of the stale crash.
        s.message('Checking for running tasks...');
        const stoppedActivity = taskActivityTime(failedTask);
        const runningListResp = await ecsClient.send(
            new ListTasksCommand({
                cluster,
                desiredStatus: 'RUNNING',
                sort: 'DESC',
                maxResults: 100
            })
        );
        const runningArns = runningListResp.taskArns || [];
        let newestRunning = null;
        if (runningArns.length > 0) {
            const runningDescResp = await ecsClient.send(
                new DescribeTasksCommand({
                    cluster,
                    tasks: runningArns.slice(0, 100)
                })
            );
            const runningTasks = runningDescResp.tasks || [];
            for (const task of runningTasks) {
                if (!newestRunning || taskStartTime(task) > taskStartTime(newestRunning)) {
                    newestRunning = task;
                }
            }
        }
        const latestRunningStart = newestRunning ? taskStartTime(newestRunning) : 0;

        // A crash on a superseded revision is stale by construction, even when
        // its stop timestamp postdates the running task (normal drain order).
        // Anything else falls through to the timestamp comparison.
        const stoppedRef = parseTaskDefinitionRef(failedTask.taskDefinitionArn);
        const runningRef = newestRunning ? parseTaskDefinitionRef(newestRunning.taskDefinitionArn) : null;
        const supersededRevision = Boolean(
            stoppedRef && runningRef
            && stoppedRef.family === runningRef.family
            && stoppedRef.revision < runningRef.revision
        );
        const recoveredByTimestamp = Boolean(newestRunning) && latestRunningStart > stoppedActivity;

        if (supersededRevision || recoveredByTimestamp) {
            const now = Date.now();
            const sinceClock = new Date(latestRunningStart).toISOString().slice(11, 19);
            const exitSuffix = exitCode !== undefined ? ` (exit code ${exitCode})` : '';
            const crashContext = supersededRevision
                ? `ℹ Previous crash (revision ${stoppedRef.revision}, ${formatAge(now - stoppedActivity)} ago): ${stoppedReason} — ${containerName}${exitSuffix}. Revision ${runningRef.revision} is now running. No action needed.`
                : `ℹ Previous crash (${formatAge(now - stoppedActivity)} ago): ${stoppedReason} — ${containerName}${exitSuffix}. No action needed.`;
            s.stop('Service recovered.');
            console.log(color.green(`\n✔ Service recovered — a healthy task has been running since ${sinceClock} (${formatAge(now - latestRunningStart)}).`));
            console.log(color.dim(crashContext));
            outro(color.green('Diagnose complete. The service recovered after that crash. ✅'));
            trackEvent('diagnose_run', { success: true, healthy: true, recovered: true, log_source: 'none' });
            await flushTelemetry();
            return {
                healthy: true,
                recovered: true,
                stoppedReason,
                taskArn: failedTask.taskArn,
                containerName,
                logs: [],
            };
        }

        s.message(`Fetching last ${LOG_FETCH_LIMIT} log lines for "${containerName}"...`);

        // CloudWatch stream names follow `ecs/<containerName>/<taskId>`.
        const taskId = extractTaskIdFromArn(failedTask.taskArn);
        const streamPrefix = containerName && containerName !== 'unknown' && taskId
            ? `ecs/${containerName}/${taskId}`
            : '';

        const fetchLogMessages = async (input) => {
            const logsResp = await logsClient.send(new FilterLogEventsCommand(input));
            return (logsResp.events || []).slice(-LOG_FETCH_LIMIT).map((e) => e.message);
        };

        let logs = [];
        let logGroupMissing = false;
        let logSource = 'none';
        if (streamPrefix) {
            try {
                logs = await fetchLogMessages({
                    logGroupName: logGroup,
                    logStreamNamePrefix: streamPrefix,
                    limit: LOG_FETCH_LIMIT,
                });
                if (logs.length > 0) logSource = 'task-stream';
            } catch (scopedError) {
                if (isLogGroupNotFoundError(scopedError)) {
                    logGroupMissing = true;
                    logs = [];
                }
                // Any other scoped-query error falls through to the group fallback.
            }
        }
        if (!logGroupMissing && logs.length === 0) {
            try {
                logs = await fetchLogMessages({
                    logGroupName: logGroup,
                    startTime: Date.now() - 60 * 60 * 1000,
                    limit: LOG_FETCH_LIMIT,
                });
                if (logs.length > 0) logSource = 'group-fallback';
            } catch (fallbackError) {
                if (isLogGroupNotFoundError(fallbackError)) logGroupMissing = true;
                logs = [];
            }
        }

        s.stop('Diagnosis complete.\n');

        console.log(`  ${color.red(color.bold('✖ Stopped reason:'))} ${color.red(stoppedReason)}`);
        console.log(`  ${color.dim('Cluster:')} ${color.cyan(cluster)}`);
        console.log(`  ${color.dim('Task:')} ${color.dim(failedTask.taskArn || taskArns[0])} ${color.dim(`(stopped ${formatAge(Date.now() - stoppedActivity)} ago)`)}`);
        console.log(`  ${color.dim('Container:')} ${color.yellow(containerName)}${exitCode !== undefined ? color.dim(` (exit code ${exitCode})`) : ''}`);
        if (containerReason && containerReason !== stoppedReason) {
            console.log(`  ${color.dim('Container reason:')} ${color.yellow(containerReason)}`);
        }

        if (logs.length > 0) {
            console.log(`\n  ${color.bold(`Last ${logs.length} log lines (${color.cyan(logGroup)}):`)}`);
            for (const line of logs) {
                console.log(`  ${color.dim('│')} ${highlightErrorLine(line)}`);
            }
        } else if (logGroupMissing) {
            console.log(color.yellow(`\n⚠ Log group not found (expected ${logGroup}).`));
            console.log(color.dim(`List matching groups with: aws logs describe-log-groups --log-group-name-prefix "/ecs/" --region ${region}`));
        } else {
            console.log(color.dim(`\n  No recent log events found in ${logGroup}.`));
        }

        outro(color.green('Diagnose complete. Fix the error above, then redeploy. 🚀'));

        trackEvent('diagnose_run', { success: true, healthy: false, log_source: logSource });
        await flushTelemetry();

        return {
            healthy: false,
            cluster,
            taskArn: failedTask.taskArn || taskArns[0],
            stoppedReason,
            containerName,
            exitCode,
            containerReason,
            logs
        };
    } catch (error) {
        trackEvent('diagnose_run', {
            success: false,
            error_code: error.name || 'UNKNOWN',
            error_message: error.message,
            stack_trace: error.name === 'TypeError' ? error.stack : undefined,
            log_source: 'none'
        });
        await flushTelemetry();
        if (error.name === 'UnrecognizedClientException' || error.name === 'ExpiredTokenException') {
            handleAwsAuthError(error, s, options);
            return;
        }
        s.stop(color.red('❌ Diagnose failed.'));
        console.log(color.red(`✖ ${error.message || error}`));
        console.log(color.dim('Check your AWS credentials and region, then try again.'));
        process.exit(1);
    }
}

function highlightErrorLine(line) {
    if (/error|exception|failed|fatal|outofmemory|killed/i.test(line)) {
        return color.red(line);
    }
    if (/warn/i.test(line)) {
        return color.yellow(line);
    }
    return color.gray(line);
}
