import { spawnSync } from 'child_process';
import color from 'picocolors';
import { resolveProjectName } from './resolvers.js';
import { AWS_CLI_INSTALL_URL } from './aws.js';

export const SESSION_MANAGER_PLUGIN_URL = 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html';

// The container name an interactive command (exec, db connect) expects to
// find: explicit flag first, then ECS_CONTAINER, then the project default.
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
    console.log(`  Check status with ${color.green('npx deploy-stack status')}, then run ${color.green('npx deploy-stack apply')} to start your service.\n`);
}
