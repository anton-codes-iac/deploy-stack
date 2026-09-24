import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { ECSClient, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { spawn } from 'child_process';
import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { hasAwsCli, AWS_CLI_INSTALL_URL, handleAwsAuthError } from '../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveCluster, resolveService } from '../utils/resolvers.js';
import { hasSessionManagerPlugin, SESSION_MANAGER_PLUGIN_URL, resolveContainer } from './exec.js';

export const DEFAULT_LOCAL_PORT = '5432';
export const MASKED_PASSWORD = '********';

function readFileSafe(filePath) {
    try {
        if (fsSync.existsSync(filePath)) return fsSync.readFileSync(filePath, 'utf8');
    } catch {
        // Fall through to defaults
    }
    return null;
}

export function parseDbArgs(argv = []) {
    const args = [...argv];
    if (args[0] === 'db') args.shift();
    if (args[0] === 'connect') args.shift();
    const options = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--port' && i + 1 < args.length) {
            options.port = args[++i];
        } else if (arg.startsWith('--port=')) {
            options.port = arg.slice('--port='.length);
        } else if (arg === '--show-credentials') {
            options.showCredentials = true;
        } else if (arg.startsWith('--show-credentials=')) {
            options.showCredentials = arg.slice('--show-credentials='.length) === 'true';
        } else if (arg === '--region' && i + 1 < args.length) {
            options.region = args[++i];
        } else if (arg.startsWith('--region=')) {
            options.region = arg.slice('--region='.length);
        } else if (arg === '--cluster' && i + 1 < args.length) {
            options.cluster = args[++i];
        } else if (arg.startsWith('--cluster=')) {
            options.cluster = arg.slice('--cluster='.length);
        } else if (arg === '--service' && i + 1 < args.length) {
            options.service = args[++i];
        } else if (arg.startsWith('--service=')) {
            options.service = arg.slice('--service='.length);
        } else if (arg === '--workspace' && i + 1 < args.length) {
            options.workspace = args[++i];
        } else if (arg.startsWith('--workspace=')) {
            options.workspace = arg.slice('--workspace='.length);
        }
    }
    return options;
}

export function isValidPort(port) {
    if (typeof port !== 'string' || !/^\d+$/.test(port)) return false;
    const num = parseInt(port, 10);
    return num >= 1 && num <= 65535;
}

// Reads the local Terraform workspace (e.g. a PR-preview environment).
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

export function resolveDbIdentifier(options = {}, cwd = process.cwd()) {
    const base = resolveProjectName(options, cwd);
    return `${base}${resolveWorkspaceSuffix(options, cwd)}-db`;
}

function resolveNamespacedProject(options = {}, cwd = process.cwd()) {
    return `${resolveProjectName(options, cwd)}${resolveWorkspaceSuffix(options, cwd)}`;
}

export function buildConnectionString({ username, password, localPort, dbName, showCredentials = false }) {
    // Percent-encode credentials ONLY for the URI: AWS-generated passwords can
    // contain characters like @ [ / : that break connection-string parsers.
    // The standalone Password: line stays unencoded so it can be copied verbatim.
    const secret = showCredentials ? encodeURIComponent(password) : MASKED_PASSWORD;
    return `postgresql://${encodeURIComponent(username)}:${secret}@localhost:${localPort}/${dbName}`;
}

export function formatConnectionInfo({ localPort, dbName, username, password, showCredentials = false }) {
    const lines = [
        `  ${color.dim('Local Host:')} ${color.cyan('localhost')}`,
        `  ${color.dim('Local Port:')} ${color.cyan(localPort)}`,
        `  ${color.dim('Database:')} ${color.cyan(dbName)}`,
        `  ${color.dim('Username:')} ${color.cyan(username)}`,
        `  ${color.dim('Password:')} ${showCredentials ? color.yellow(password) : color.dim(MASKED_PASSWORD)}`,
        '',
        `  ${color.dim('Connection string:')}`,
        `  ${color.green(buildConnectionString({ username, password, localPort, dbName, showCredentials }))}`,
    ];
    if (!showCredentials) {
        lines.push(`  ${color.dim('Re-run with --show-credentials to reveal the password.')}`);
    }
    return lines.join('\n');
}

export function buildSsmArgs({ cluster, taskId, runtimeId, dbHost, localPort, region }) {
    const args = [
        'ssm', 'start-session',
        '--target', `ecs:${cluster}_${taskId}_${runtimeId}`,
        '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
        '--parameters', `{"host":["${dbHost}"],"portNumber":["5432"],"localPortNumber":["${localPort}"]}`,
    ];
    if (region) args.push('--region', region);
    return args;
}

// Mirror exec's container preference: expected name first, then first RUNNING.
export function pickRuntimeContainer(task, expectedName) {
    const containers = task?.containers || [];
    if (containers.length === 0) return null;
    const exact = containers.find((c) => c.name === expectedName);
    if (exact) return exact;
    const running = containers.find((c) => c.lastStatus === 'RUNNING');
    if (running) return running;
    return containers[0];
}

function printAwsCliGuidance() {
    console.log(color.red('\n✖ AWS CLI not found.'));
    console.log(`  ${color.bold('db connect')} needs the AWS CLI (plus the Session Manager plugin) to open a secure tunnel to your database.`);
    console.log(`  Install the AWS CLI: ${color.blue(color.underline(AWS_CLI_INSTALL_URL))}`);
    console.log(`  Install the Session Manager plugin: ${color.blue(color.underline(SESSION_MANAGER_PLUGIN_URL))}`);
    console.log(color.dim('  Then run `aws sso login` (or `aws configure`) and try again.\n'));
}

function printSessionManagerGuidance() {
    console.log(color.red('\n✖ AWS Session Manager plugin not found.'));
    console.log(`  ${color.bold('db connect')} requires a system-level AWS plugin to securely tunnel to your database.`);
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

function printNoDatabaseGuidance(dbIdentifier) {
    console.log(color.yellow('\n⚠ No database found.'));
    console.log(`  No RDS instance named ${color.cyan(dbIdentifier)} exists in this environment.`);
    console.log('  This project was likely provisioned without a managed database.');
    console.log(`  Re-run ${color.green('npx deploy-stack init')} and answer "Yes" to the database prompt, then ${color.green('npx deploy-stack apply')}.\n`);
}

function printNoTasksGuidance(service, cluster) {
    console.log(color.yellow('\n⚠ No running containers found.'));
    console.log(`  The ECS service ${color.cyan(service)} in cluster ${color.cyan(cluster)} has no RUNNING tasks.`);
    console.log('  A running container is required to act as a jump host for the tunnel.');
    console.log(`  Check status with ${color.green('npx deploy-stack status')}, then run ${color.green('npx deploy-stack apply')} to start your service.\n`);
}

function isAuthError(error) {
    return !!error && (error.name === 'UnrecognizedClientException' || error.name === 'ExpiredTokenException');
}

export async function runDbConnect(options = {}) {
    const cwd = options.cwd || process.cwd();
    const region = resolveRegion(options, cwd);
    const showCredentials = options.showCredentials === true || options.showCredentials === 'true';
    const localPort = typeof options.port === 'string' && options.port.trim()
        ? options.port.trim()
        : DEFAULT_LOCAL_PORT;

    // Namespaced project name so PR-preview workspaces resolve correctly.
    const namespacedProject = resolveNamespacedProject(options, cwd);
    const namespacedOptions = { ...options, projectName: namespacedProject };
    const projectName = resolveProjectName(options, cwd);
    const cluster = resolveCluster(namespacedOptions, cwd);
    const service = resolveService(namespacedOptions, cwd);
    const expectedContainer = resolveContainer(namespacedOptions, cwd);
    const dbIdentifier = resolveDbIdentifier(options, cwd);

    const rdsClient = (options.rdsClient && typeof options.rdsClient.send === 'function')
        ? options.rdsClient
        : new RDSClient({ region });
    const ecsClient = (options.ecsClient && typeof options.ecsClient.send === 'function')
        ? options.ecsClient
        : new ECSClient({ region });
    const secretsClient = (options.secretsClient && typeof options.secretsClient.send === 'function')
        ? options.secretsClient
        : new SecretsManagerClient({ region });

    const spawnImpl = options.spawnImpl || spawn;
    const awsCliPresent = options.hasAwsCli ?? hasAwsCli({ spawnSyncImpl: options.spawnSyncImpl });
    const ssmPluginPresent = options.hasSsmPlugin ?? hasSessionManagerPlugin({ spawnSyncImpl: options.spawnSyncImpl });

    intro(color.bgCyan(color.black(' deploy-stack db 🛢️  ')));

    if (!isValidPort(localPort)) {
        console.log(color.red(`\n✖ Invalid --port "${localPort}". Use a number between 1 and 65535.\n`));
        trackEvent('db_connect_run', { projectName, success: false, error_code: 'INVALID_PORT' });
        await flushTelemetry();
        process.exit(1);
        return { ok: false, reason: 'invalid-port', cluster, service, region };
    }

    if (!awsCliPresent) {
        printAwsCliGuidance();
        trackEvent('db_connect_run', { projectName, success: false, error_code: 'AWS_CLI_MISSING' });
        await flushTelemetry();
        process.exit(1);
        return { ok: false, reason: 'aws-cli-missing', cluster, service, region };
    }

    if (!ssmPluginPresent) {
        printSessionManagerGuidance();
        trackEvent('db_connect_run', { projectName, success: false, error_code: 'SSM_PLUGIN_MISSING' });
        await flushTelemetry();
        process.exit(1);
        return { ok: false, reason: 'ssm-plugin-missing', cluster, service, region };
    }

    const s = spinner();
    s.start('Finding your database...');

    try {
        // 1. Find the RDS instance.
        let dbInstance;
        try {
            const dbResp = await rdsClient.send(
                new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbIdentifier })
            );
            dbInstance = (dbResp.DBInstances || [])[0] || null;
        } catch (error) {
            if (error && error.name === 'DBInstanceNotFound') dbInstance = null;
            else throw error;
        }

        if (!dbInstance) {
            s.stop(color.yellow('No database found.'));
            printNoDatabaseGuidance(dbIdentifier);
            trackEvent('db_connect_run', { projectName, success: false, error_code: 'NO_DATABASE' });
            await flushTelemetry();
            process.exit(1);
            return { ok: false, reason: 'no-database', cluster, service, region };
        }

        const dbHost = dbInstance?.Endpoint?.Address;
        const dbName = dbInstance?.DBName;
        const secretArn = dbInstance?.MasterUserSecret?.SecretArn;
        if (!dbHost || !dbName || !secretArn) {
            s.stop(color.red('Database details incomplete.'));
            console.log(color.red(`\n✖ The database ${color.cyan(dbIdentifier)} is missing its endpoint, name, or managed secret.`));
            trackEvent('db_connect_run', { projectName, success: false, error_code: 'DB_DETAILS_INCOMPLETE' });
            await flushTelemetry();
            process.exit(1);
            return { ok: false, reason: 'db-details-incomplete', cluster, service, region };
        }

        // 2. Fetch the managed credentials (never logged, never telemetered).
        s.message('Fetching database credentials...');
        const secretResp = await secretsClient.send(
            new GetSecretValueCommand({ SecretId: secretArn })
        );
        let username = null;
        let password = null;
        try {
            const parsed = JSON.parse(secretResp.SecretString || '{}');
            username = parsed.username || null;
            password = parsed.password || null;
        } catch {
            username = null;
            password = null;
        }
        if (!username || !password) {
            s.stop(color.red('Could not read database credentials.'));
            console.log(color.red('\n✖ The managed database secret did not contain a username and password.'));
            trackEvent('db_connect_run', { projectName, success: false, error_code: 'SECRET_MALFORMED' });
            await flushTelemetry();
            process.exit(1);
            return { ok: false, reason: 'secret-malformed', cluster, service, region };
        }

        // 3. Find a running ECS task to act as the jump host.
        s.message('Finding a running container...');
        const listResp = await ecsClient.send(
            new ListTasksCommand({ cluster, serviceName: service, desiredStatus: 'RUNNING', maxResults: 10 })
        );
        const taskArns = listResp.taskArns || [];
        if (taskArns.length === 0) {
            s.stop(color.yellow('No running tasks.'));
            printNoTasksGuidance(service, cluster);
            trackEvent('db_connect_run', { projectName, success: false, error_code: 'NO_RUNNING_TASKS' });
            await flushTelemetry();
            process.exit(1);
            return { ok: false, reason: 'no-running-tasks', cluster, service, region };
        }
        const descResp = await ecsClient.send(
            new DescribeTasksCommand({ cluster, tasks: taskArns.slice(0, 1) })
        );
        const task = (descResp.tasks || [])[0] || null;
        if (!task?.taskArn) {
            s.stop(color.yellow('No running tasks.'));
            printNoTasksGuidance(service, cluster);
            trackEvent('db_connect_run', { projectName, success: false, error_code: 'NO_RUNNING_TASKS' });
            await flushTelemetry();
            process.exit(1);
            return { ok: false, reason: 'no-running-tasks', cluster, service, region };
        }
        const container = pickRuntimeContainer(task, expectedContainer);
        const runtimeId = container?.runtimeId;
        if (!runtimeId) {
            s.stop(color.red('Container runtime ID unavailable.'));
            console.log(color.red('\n✖ The running container did not report a runtime ID, so the tunnel cannot attach.'));
            console.log(color.dim('Wait a moment for the task to stabilize, then try again.\n'));
            trackEvent('db_connect_run', { projectName, success: false, error_code: 'NO_RUNTIME_ID' });
            await flushTelemetry();
            process.exit(1);
            return { ok: false, reason: 'no-runtime-id', cluster, service, region };
        }
        const taskId = task.taskArn.split('/').pop();

        s.stop(color.green('Tunnel details ready.'));
        console.log(formatConnectionInfo({ localPort, dbName, username, password, showCredentials }));
        console.log(color.dim(`\n  Opening a tunnel via ${container?.name || expectedContainer} — press Ctrl+C to close.\n`));

        const ssmArgs = buildSsmArgs({
            cluster,
            taskId,
            runtimeId,
            dbHost,
            localPort,
            region,
        });

        // Telemetry carries only non-sensitive fields. Credentials never leave this process
        // except to the terminal above and the local SSM session below.
        trackEvent('db_connect_run', { projectName, success: true });
        await flushTelemetry();

        await new Promise((resolve) => {
            const child = spawnImpl('aws', ssmArgs, { stdio: 'inherit' });
            child.on('error', (err) => {
                console.log(color.red(`\n✖ Failed to start AWS CLI: ${err?.message || err}`));
                console.log(color.dim(`Install help: ${AWS_CLI_INSTALL_URL}`));
                resolve({ code: 1 });
            });
            child.on('close', (code) => resolve({ code: code ?? 0 }));
        }).then(async ({ code }) => {
            if (code === 0) {
                outro(color.green('Tunnel closed. 👋'));
            } else {
                console.log(color.yellow(`\nTunnel exited with code ${code}.`));
                console.log(color.dim('If the connection failed, ensure the Session Manager plugin is installed and your AWS session is fresh.'));
                outro(color.yellow('Db connect finished.'));
            }
        });

        return { ok: true, cluster, service, dbIdentifier, taskArn: task.taskArn, localPort, region };
    } catch (error) {
        // Only non-sensitive metadata is telemetered here. The password, username, and
        // connection string are never passed to trackEvent in any path.
        trackEvent('db_connect_run', {
            projectName,
            success: false,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        await flushTelemetry();
        if (isAuthError(error)) {
            handleAwsAuthError(error, s, options);
            return { ok: false, reason: 'error', cluster, service, region };
        }
        s.stop(color.red('❌ Db connect failed.'));
        console.log(color.red(`✖ ${error?.message || error}`));
        console.log(color.dim('Check your AWS credentials and region, then try again.'));
        process.exit(1);
        return { ok: false, reason: 'error', cluster, service, region };
    }
}

// Convenience alias mirroring the CLI verb.
export const dbCommand = runDbConnect;

export default runDbConnect;
