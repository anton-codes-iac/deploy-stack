import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';

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

function pickMostRecentTask(tasks) {
    if (!tasks || tasks.length === 0) return null;
    return [...tasks].sort((a, b) => {
        const aTime = a.stoppedAt ? new Date(a.stoppedAt).getTime() : 0;
        const bTime = b.stoppedAt ? new Date(b.stoppedAt).getTime() : 0;
        return bTime - aTime;
    })[0];
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

    const region = options.region || process.env.AWS_REGION || 'us-east-2';
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
                maxResults: 10
            })
        );

        const taskArns = listResp.taskArns || [];

        if (taskArns.length === 0) {
            s.stop('No stopped tasks found.');
            console.log(color.green('✅ No stopped tasks — your service looks healthy.'));
            outro(color.green('Diagnose complete. Nothing to fix!'));
            trackEvent('diagnose_run', { success: true, healthy: true });
            await flushTelemetry();
            return { healthy: true, stoppedReason: null, logs: [] };
        }

        s.message(`Describing ${Math.min(taskArns.length, 5)} stopped task(s)...`);
        const descResp = await ecsClient.send(
            new DescribeTasksCommand({
                cluster,
                tasks: taskArns.slice(0, 5)
            })
        );

        const tasks = descResp.tasks || [];
        if (tasks.length === 0) {
            s.stop('No task details returned.');
            console.log(color.yellow('⚠ Stopped task ARNs were listed, but ECS returned no task details.'));
            outro(color.yellow('Diagnose finished with no details.'));
            trackEvent('diagnose_run', { success: false, error_code: 'NO_TASK_DETAILS' });
            await flushTelemetry();
            return { healthy: false, stoppedReason: null, logs: [] };
        }

        const failedTask = pickMostRecentTask(tasks);
        const stoppedReason = extractStoppedReason(failedTask);
        const failingContainer = getFailingContainer(failedTask);
        const containerName = failingContainer.name || 'unknown';
        const exitCode = failingContainer.exitCode;
        const containerReason = failingContainer.reason;

        s.message(`Fetching last ${LOG_FETCH_LIMIT} log lines for "${containerName}"...`);
        let logs = [];
        try {
            const logsResp = await logsClient.send(
                new FilterLogEventsCommand({
                    logGroupName: logGroup,
                    limit: LOG_FETCH_LIMIT
                })
            );
            const events = logsResp.events || [];
            logs = events.slice(-LOG_FETCH_LIMIT).map((e) => e.message);
        } catch (logError) {
            logs = [];
        }

        s.stop('Diagnosis complete.\n');

        console.log(`  ${color.red(color.bold('✖ Stopped reason:'))} ${color.red(stoppedReason)}`);
        console.log(`  ${color.dim('Cluster:')} ${color.cyan(cluster)}`);
        console.log(`  ${color.dim('Task:')} ${color.dim(failedTask.taskArn || taskArns[0])}`);
        console.log(`  ${color.dim('Container:')} ${color.yellow(containerName)}${exitCode !== undefined ? color.dim(` (exit code ${exitCode})`) : ''}`);
        if (containerReason && containerReason !== stoppedReason) {
            console.log(`  ${color.dim('Container reason:')} ${color.yellow(containerReason)}`);
        }

        if (logs.length > 0) {
            console.log(`\n  ${color.bold(`Last ${logs.length} log lines (${color.cyan(logGroup)}):`)}`);
            for (const line of logs) {
                console.log(`  ${color.dim('│')} ${highlightErrorLine(line)}`);
            }
        } else {
            console.log(color.dim(`\n  No recent log events found in ${logGroup}.`));
        }

        outro(color.green('Diagnose complete. Fix the error above, then redeploy. 🚀'));

        trackEvent('diagnose_run', { success: true, healthy: false });
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
        s.stop(color.red('❌ Diagnose failed.'));

        if (error.name === 'UnrecognizedClientException' || error.name === 'ExpiredTokenException') {
            console.log(color.yellow('\n⚠️  AWS Session Expired / Invalid Credentials'));
            console.log(`Run ${color.cyan('aws sso login')} or ${color.cyan('aws configure')} to refresh your credentials.`);
            console.log(color.blue(`\n📘 Troubleshooting Guide: ${color.underline('https://github.com/anton-codes-iac/deploy-stack/blob/main/apps/docs/src/content/docs/guides/aws-credentials.md')}\n`));
        } else {
            console.log(color.red(`✖ ${error.message || error}`));
            console.log(color.dim('Check your AWS credentials and region, then try again.'));
        }

        trackEvent('diagnose_run', {
            success: false,
            error_code: error.name || 'UNKNOWN',
            error_message: error.message,
            stack_trace: error.name === 'TypeError' ? error.stack : undefined
        });
        await flushTelemetry();
        throw error;
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
