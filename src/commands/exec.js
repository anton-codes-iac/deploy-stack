import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { spawn, spawnSync } from 'child_process';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { hasAwsCli, AWS_CLI_INSTALL_URL, handleAwsAuthError } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCluster, resolveService } from '../utils/resolvers.js';

export const DEFAULT_SHELL = '/bin/sh';
export const SESSION_MANAGER_PLUGIN_URL = 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html';

export function resolveContainer(options = {}, cwd = process.cwd()) {
    if (typeof options.container === 'string' && options.container.trim()) return options.container.trim();
    if (typeof options.containerName === 'string' && options.containerName.trim()) {
        return options.containerName.trim();
    }
    if (typeof process.env.ECS_CONTAINER === 'string' && process.env.ECS_CONTAINER.trim()) {
        return process.env.ECS_CONTAINER.trim();
    }
    return `${resolveProjectName(options, cwd)}-container`;
}

export function resolveShellCommand(options = {}) {
    if (typeof options.command === 'string' && options.command.trim()) return options.command.trim();
    if (typeof options.shell === 'string' && options.shell.trim()) return options.shell.trim();
    return DEFAULT_SHELL;
}

export function parseExecArgs(argv = []) {
    const args = [...argv];
    if (args[0] === 'exec') args.shift();
    const options = {};
    const positionals = [];
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
        } else if (arg === '--container' && i + 1 < args.length) {
            options.container = args[++i];
        } else if (arg.startsWith('--container=')) {
            options.container = arg.slice('--container='.length);
        } else if (arg === '--command' && i + 1 < args.length) {
            options.command = args[++i];
        } else if (arg.startsWith('--command=')) {
            options.command = arg.slice('--command='.length);
        } else if (arg === '--region' && i + 1 < args.length) {
            options.region = args[++i];
        } else if (arg.startsWith('--region=')) {
            options.region = arg.slice('--region='.length);
        } else if (!arg.startsWith('-')) {
            positionals.push(arg);
        }
    }
    if (positionals.length > 0 && !options.service) options.service = positionals[0];
    return options;
}

export function buildExecuteCommandArgs({ cluster, taskArn, container, command = DEFAULT_SHELL, region }) {
    const args = [
        'ecs', 'execute-command',
        '--cluster', cluster,
        '--task', taskArn,
        '--container', container,
        '--interactive',
        '--command', command,
    ];
    if (region) args.push('--region', region);
    return args;
}

export function hasSessionManagerPlugin(options = {}) {
    const runSync = options.spawnSyncImpl || spawnSync;
    try {
        const result = runSync('session-manager-plugin', ['--version'], { stdio: 'ignore' });
        if (result && result.error && result.error.code === 'ENOENT') return false;
        return true;
    } catch {
        return false;
    }
}

function pickContainerName(task, fallback) {
    const containers = task?.containers || [];
    if (containers.length === 0) return fallback;
    const exact = containers.find((c) => c.name === fallback);
    if (exact) return exact.name;
    const running = containers.find((c) => c.lastStatus === 'RUNNING');
    if (running?.name) return running.name;
    if (containers[0]?.name) return containers[0].name;
    return fallback;
}

export async function findRunningTask(ecsClient, { cluster, service }) {
    const listResp = await ecsClient.send(
        new ListTasksCommand({ cluster, serviceName: service, desiredStatus: 'RUNNING', maxResults: 10 })
    );
    const taskArns = listResp.taskArns || [];
    if (taskArns.length === 0) return null;
    const descResp = await ecsClient.send(
        new DescribeTasksCommand({ cluster, tasks: taskArns.slice(0, 1) })
    );
    const tasks = descResp.tasks || [];
    if (tasks.length === 0) return { taskArn: taskArns[0], containerName: null };
    return { taskArn: tasks[0].taskArn || taskArns[0], containerName: tasks[0].containers?.[0]?.name || null, task: tasks[0] };
}

function printAwsCliGuidance() {
    console.log(color.red('\n✖ AWS CLI not found.'));
    console.log(`  ${color.bold('exec')} needs the AWS CLI (plus the Session Manager plugin) to open a shell in your container.`);
    console.log(`  Install the AWS CLI: ${color.blue(color.underline(AWS_CLI_INSTALL_URL))}`);
    console.log(`  Install the Session Manager plugin: ${color.blue(color.underline(SESSION_MANAGER_PLUGIN_URL))}`);
    console.log(color.dim('  Then run `aws sso login` (or `aws configure`) and try again.\n'));
}

function printSessionManagerGuidance() {
    console.log(color.red('\n✖ AWS Session Manager plugin not found.'));
    console.log(`  ${color.bold('exec')} requires a system-level AWS plugin to securely tunnel into your container.`);
    console.log(color.yellow('\n  To install it:'));

    if (process.platform === 'darwin') {
        console.log(`  Mac:   ${color.cyan('brew install session-manager-plugin')}`);
    } else if (process.platform === 'win32') {
        console.log(`  Win:   Download from ${color.blue(color.underline('https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html#install-plugin-windows'))}`);
    } else {
        console.log(`  Linux: See ${color.blue(color.underline('https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html#install-plugin-linux'))}`);
    }
    console.log('');
}

function printNoTasksGuidance(service, cluster) {
    console.log(color.yellow('\n⚠ No running containers found.'));
    console.log(`  The ECS service ${color.cyan(service)} in cluster ${color.cyan(cluster)} has no RUNNING tasks.`);
    console.log('  A running container is required to open an interactive shell.');
    console.log(`  Check status with ${color.green('npx deploy-stack status')}, then run ${color.green('npx deploy-stack apply')} to start your service.\n`);
}

export async function runExec(options = {}) {
    const cwd = options.cwd || process.cwd();
    const region = resolveRegion(options, cwd);
    const projectName = resolveProjectName(options, cwd);
    const cluster = resolveCluster(options, cwd);
    const service = resolveService(options, cwd);
    const expectedContainer = resolveContainer(options, cwd);
    const shellCommand = resolveShellCommand(options);

    const ecsClient = (options.ecsClient && typeof options.ecsClient.send === 'function')
        ? options.ecsClient
        : new ECSClient({ region });

    const spawnImpl = options.spawnImpl || spawn;
    const awsCliPresent = options.hasAwsCli ?? hasAwsCli({ spawnSyncImpl: options.spawnSyncImpl });
    const ssmPluginPresent = options.hasSsmPlugin ?? hasSessionManagerPlugin({ spawnSyncImpl: options.spawnSyncImpl });

    intro(color.bgCyan(color.black(' deploy-stack exec 🐚 ')));

    if (!awsCliPresent) {
        printAwsCliGuidance();
        trackEvent('exec_run', { projectName, success: false, error_code: 'AWS_CLI_MISSING' });
        await flushTelemetry();
        process.exit(1);
        return { ok: false, reason: 'aws-cli-missing', cluster, service, region };
    }

    if (!ssmPluginPresent) {
        printSessionManagerGuidance();
        trackEvent('exec_run', { projectName, success: false, error_code: 'SSM_PLUGIN_MISSING' });
        await flushTelemetry();
        process.exit(1);
        return { ok: false, reason: 'ssm-plugin-missing', cluster, service, region };
    }

    const s = spinner();
    s.start('Finding a running container...');

    try {
        const found = await findRunningTask(ecsClient, { cluster, service });

        if (!found) {
            s.stop(color.yellow('No running tasks.'));
            printNoTasksGuidance(service, cluster);
            trackEvent('exec_run', { projectName, success: false, error_code: 'NO_RUNNING_TASKS' });
            await flushTelemetry();
            process.exit(1);
            return { ok: false, reason: 'no-running-tasks', cluster, service, region };
        }

        const container = found.containerName || expectedContainer;
        const taskArn = found.taskArn;
        // Prefer the exact expected container name when the task actually runs it.
        const resolvedContainer = found.task ? pickContainerName(found.task, expectedContainer) : container;

        s.stop(color.green('Container found. Connecting...'));
        console.log(`  ${color.dim('Cluster:')} ${color.cyan(cluster)}`);
        console.log(`  ${color.dim('Task:')} ${color.dim(taskArn)}`);
        console.log(`  ${color.dim('Container:')} ${color.yellow(resolvedContainer)}`);
        console.log(color.dim(`  Opening ${shellCommand} — type 'exit' to leave.\n`));

        const cliArgs = buildExecuteCommandArgs({
            cluster,
            taskArn,
            container: resolvedContainer,
            command: shellCommand,
            region,
        });

        trackEvent('exec_run', { projectName, success: true });
        await flushTelemetry();

        await new Promise((resolve) => {
            const child = spawnImpl('aws', cliArgs, { stdio: 'inherit' });
            child.on('error', (err) => {
                console.log(color.red(`\n✖ Failed to start AWS CLI: ${err?.message || err}`));
                console.log(color.dim(`Install help: ${AWS_CLI_INSTALL_URL}`));
                resolve({ code: 1 });
            });
            child.on('close', (code) => resolve({ code: code ?? 0 }));
        }).then(async ({ code }) => {
            if (code === 0) {
                outro(color.green('Shell session ended. 👋'));
            } else {
                console.log(color.yellow(`\nShell exited with code ${code}.`));
                console.log(color.dim(`If the connection failed, ensure ECS Exec is enabled (re-run ${color.green('npx deploy-stack apply')}) and the Session Manager plugin is installed.`));
                outro(color.yellow('Exec finished.'));
            }
        });

        return { ok: true, cluster, service, taskArn, container: resolvedContainer, region };
    } catch (error) {
        trackEvent('exec_run', {
            projectName,
            success: false,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        await flushTelemetry();
        if (error && (error.name === 'UnrecognizedClientException' || error.name === 'ExpiredTokenException')) {
            handleAwsAuthError(error, s, options);
            return { ok: false, reason: 'error', cluster, service, region };
        }
        s.stop(color.red('❌ Exec failed.'));
        console.log(color.red(`✖ ${error?.message || error}`));
        console.log(color.dim('Check your AWS credentials and region, then try again.'));
        process.exit(1);
        return { ok: false, reason: 'error', cluster, service, region };
    }
}

// Convenience alias mirroring the CLI verb.
export const execCommand = runExec;

export default runExec;
