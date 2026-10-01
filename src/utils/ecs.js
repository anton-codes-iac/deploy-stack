import { spawnSync } from 'child_process';
import color from 'picocolors';
import { DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { resolveProjectName } from './resolvers.js';
import { normalizeOptions } from './args.js';
import { AWS_CLI_INSTALL_URL } from './aws.js';

export const SESSION_MANAGER_PLUGIN_URL = 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html';

// The container name an interactive command (exec, db connect) expects to
// find: explicit flag first, then ECS_CONTAINER, then the project default.
export function resolveContainer(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.container === 'string' && opts.container.trim()) return opts.container.trim();
    if (typeof opts.containerName === 'string' && opts.containerName.trim()) {
        return opts.containerName.trim();
    }
    if (typeof process.env.ECS_CONTAINER === 'string' && process.env.ECS_CONTAINER.trim()) {
        return process.env.ECS_CONTAINER.trim();
    }
    return `${resolveProjectName(opts, cwd)}-container`;
}

// Shared active-service lookup: the service object when it exists and is
// ACTIVE, otherwise null. Never throws for a missing/inactive service;
// unexpected AWS errors propagate to the caller's catch block.
export async function fetchActiveService(ecsClient, clusterName, serviceName) {
    const resp = await ecsClient.send(
        new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] })
    );
    const service = (resp.services || [])[0] || null;
    if (!service || service.status !== 'ACTIVE') return null;
    return service;
}

// Container preference shared by the interactive commands: the expected
// name first, then the first RUNNING container, then the first entry.
// Works for both live tasks and task-definition `containerDefinitions`
// (which simply never match the RUNNING step).
export function pickRuntimeContainer(task, expectedName) {
    const containers = task?.containers || task?.containerDefinitions || [];
    if (containers.length === 0) return null;
    const exact = containers.find((c) => c.name === expectedName);
    if (exact) return exact;
    const running = containers.find((c) => c.lastStatus === 'RUNNING');
    if (running) return running;
    return containers[0];
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

// Shared pre-flight guidance for the interactive ECS commands. `commandName`
// is the CLI verb shown in bold (`exec`, `db connect`); `purpose` completes
// the sentence ("needs the AWS CLI ... <purpose>.").
export function printAwsCliGuidance({ commandName = 'exec', purpose = 'to open a shell in your container' } = {}) {
    console.log(color.red('\n✖ AWS CLI not found.'));
    console.log(`  ${color.bold(commandName)} needs the AWS CLI (plus the Session Manager plugin) ${purpose}.`);
    console.log(`  Install the AWS CLI: ${color.blue(color.underline(AWS_CLI_INSTALL_URL))}`);
    console.log(`  Install the Session Manager plugin: ${color.blue(color.underline(SESSION_MANAGER_PLUGIN_URL))}`);
    console.log(color.dim('  Then run `aws sso login` (or `aws configure`) and try again.\n'));
}

export function printSessionManagerGuidance({ commandName = 'exec', purpose = 'to securely tunnel into your container' } = {}) {
    console.log(color.red('\n✖ AWS Session Manager plugin not found.'));
    console.log(`  ${color.bold(commandName)} requires a system-level AWS plugin ${purpose}.`);
    console.log(color.yellow('\n  To install it:'));

    if (process.platform === 'darwin') {
        console.log(`  Mac:   ${color.cyan('brew install session-manager-plugin')}`);
    } else if (process.platform === 'win32') {
        console.log(`  Win:   Download from ${color.blue(color.underline(`${SESSION_MANAGER_PLUGIN_URL}#install-plugin-windows`))}`);
    } else {
        console.log(`  Linux: See ${color.blue(color.underline(`${SESSION_MANAGER_PLUGIN_URL}#install-plugin-linux`))}`);
    }
    console.log('');
}

export function printNoTasksGuidance(service, cluster, reason = 'to open an interactive shell') {
    console.log(color.yellow('\n⚠ No running containers found.'));
    console.log(`  The ECS service ${color.cyan(service)} in cluster ${color.cyan(cluster)} has no RUNNING tasks.`);
    console.log(`  A running container is required ${reason}.`);
    console.log(`  Check status with ${color.green('npx grada-run status')}, then run ${color.green('npx grada-run apply')} to start your service.\n`);
}
