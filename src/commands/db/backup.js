import { RDSClient, CreateDBSnapshotCommand, DescribeDBSnapshotsCommand } from '@aws-sdk/client-rds';
import color from 'picocolors';
import { intro, outro, spinner } from '@clack/prompts';
import { trackSuccess, trackFailure } from '../../core/telemetry.js';
import { failCommand, failProjectNotInitialized } from '../../utils/command.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../../utils/args.js';
import { handleAuthErrorBranch, resolveClient } from '../../utils/aws.js';
import { resolveRegion, resolveProjectName, resolveAppName, resolveCwd } from '../../utils/resolvers.js';
import { findDbInstance, generateSnapshotId, isValidSnapshotId, resolveDbIdentifier } from '../../utils/rds.js';
import { pollUntil, parseTimeoutSeconds } from '../../utils/system.js';

export const DEFAULT_BACKUP_TIMEOUT_SECONDS = 900;
export const DEFAULT_BACKUP_POLL_INTERVAL_MS = 5000;

const SNAPSHOT_NOT_FOUND_NAMES = new Set(['DBSnapshotNotFound', 'DBSnapshotNotFoundFault']);

export function parseDbBackupArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'db') args.shift();
    if (args[0] === 'backup') args.shift();
    const { options, rest } = parseFlags(args, {
        string: [
            { name: 'id', key: 'snapshotId' },
            { name: 'timeout', key: 'timeout' },
            { name: 'project-name', key: 'projectName' },
            { name: 'region', key: 'region' },
            { name: 'workspace', key: 'workspace' },
            { name: 'db-identifier', key: 'dbIdentifier' },
        ],
        boolean: ['no-wait', 'headless'],
    });
    const positionals = rest.filter((arg) => typeof arg === 'string' && !arg.startsWith('-'));
    if (positionals.length > 0) options.unexpectedPositionals = positionals;
    return options;
}

export async function runDbBackup(input = {}) {
    const options = normalizeOptions(input);
    let cwd;
    let region;
    let projectName;
    let dbIdentifier;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
        const appName = resolveAppName(projectName, options.workspace, cwd);
        dbIdentifier = resolveDbIdentifier({ ...options, projectName }, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'db_backup_run' });
    }
    const noWait = options.noWait === true || options.noWait === 'true';

    intro(color.bgCyan(color.black(' deploy-stack db backup 📸 ')));

    if (Array.isArray(options.unexpectedPositionals) && options.unexpectedPositionals.length > 0) {
        return failCommand({
            message: `\n✖ Unexpected argument "${options.unexpectedPositionals[0]}". Set the snapshot id with --id <snapshot-id>.\n`,
            event: 'db_backup_run',
            telemetry: { projectName },
            errorCode: 'UNEXPECTED_POSITIONAL_ARGS',
            reason: 'unexpected-positional-args',
            resultExtra: { dbIdentifier, region },
        });
    }

    if (options.snapshotId !== undefined && !isValidSnapshotId(options.snapshotId)) {
        return failCommand({
            message: `\n✖ Invalid --id "${options.snapshotId}". Snapshot ids start with a letter, use letters/digits/hyphens (no "--", no trailing "-").\n`,
            event: 'db_backup_run',
            telemetry: { projectName },
            errorCode: 'INVALID_SNAPSHOT_ID',
            reason: 'invalid-snapshot-id',
            resultExtra: { dbIdentifier, region },
        });
    }

    const timeoutSeconds = parseTimeoutSeconds(options.timeout, DEFAULT_BACKUP_TIMEOUT_SECONDS);
    if (timeoutSeconds === null) {
        return failCommand({
            message: `\n✖ Invalid --timeout "${options.timeout}". Use a positive number of seconds (default ${DEFAULT_BACKUP_TIMEOUT_SECONDS}).\n`,
            event: 'db_backup_run',
            telemetry: { projectName },
            errorCode: 'INVALID_TIMEOUT',
            reason: 'invalid-timeout',
            resultExtra: { dbIdentifier, region },
        });
    }

    const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_BACKUP_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? timeoutSeconds * 1000;

    const s = spinner();
    s.start('Finding your database...');

    try {
        const dbInstance = await findDbInstance(rdsClient, dbIdentifier);
        if (!dbInstance) {
            s.stop();
            return failCommand({
                print: () => {
                    console.log(color.yellow('\n⚠ No database found.'));
                    console.log(`  No RDS instance named ${color.cyan(dbIdentifier)} exists in this environment.`);
                    console.log(`  Re-run ${color.green('npx deploy-stack init')} and answer "Yes" to the database prompt, then ${color.green('npx deploy-stack apply')}.\n`);
                },
                event: 'db_backup_run',
                telemetry: { projectName },
                errorCode: 'RDS_INSTANCE_NOT_FOUND',
                reason: 'rds-instance-not-found',
                resultExtra: { dbIdentifier, region },
            });
        }

        const snapshotId = (typeof options.snapshotId === 'string' && options.snapshotId.trim())
            ? options.snapshotId.trim()
            : generateSnapshotId(dbIdentifier);

        s.message(`Creating snapshot ${snapshotId}...`);
        await rdsClient.send(new CreateDBSnapshotCommand({
            DBInstanceIdentifier: dbIdentifier,
            DBSnapshotIdentifier: snapshotId,
            Tags: [
                { Key: 'ManagedBy', Value: 'deploy-stack' },
                { Key: 'Project', Value: projectName },
            ],
        }));

        if (noWait) {
            s.stop(color.green('Snapshot creation started.'));
            console.log(`\n  Snapshot ${color.cyan(snapshotId)} is being created (status: creating).`);
            console.log(color.dim(`  Restore it later with: npx deploy-stack db restore ${snapshotId}\n`));
            await trackSuccess('db_backup_run', { projectName, waited: false });
            outro(color.green('Done.'));
            return { ok: true, snapshotId, status: 'creating' };
        }

        s.message(`Waiting for snapshot ${snapshotId} to become available...`);
        const outcome = await pollUntil({
            intervalMs: pollIntervalMs,
            timeoutMs,
            onTick: async ({ elapsedMs }) => {
                let snapshots = [];
                try {
                    const resp = await rdsClient.send(
                        new DescribeDBSnapshotsCommand({ DBSnapshotIdentifier: snapshotId })
                    );
                    snapshots = resp.DBSnapshots || [];
                } catch (error) {
                    // The snapshot is not describable for a moment right after
                    // creation (eventual consistency), so keep polling.
                    if (error && SNAPSHOT_NOT_FOUND_NAMES.has(error.name)) {
                        s.message(`Waiting for snapshot ${snapshotId}... [${Math.floor(elapsedMs / 1000)}s]`);
                        return { done: false };
                    }
                    throw error;
                }
                const snapshot = snapshots[0] || null;
                if (snapshot && snapshot.Status === 'available') {
                    return { done: true, value: snapshot };
                }
                s.message(`Waiting for snapshot ${snapshotId}... [${Math.floor(elapsedMs / 1000)}s]`);
                return { done: false };
            },
        });

        if (outcome.timedOut) {
            s.stop(color.yellow('Snapshot still creating.'));
            return failCommand({
                print: () => {
                    console.log(color.yellow(`\n⚠ Snapshot ${snapshotId} did not become available within ${timeoutSeconds}s.`));
                    console.log('  Creation continues in the background — check status in the AWS console or retry with a larger --timeout.');
                    console.log(color.dim(`  Restore it once available with: npx deploy-stack db restore ${snapshotId}\n`));
                },
                event: 'db_backup_run',
                telemetry: { projectName, waited: true },
                errorCode: 'SNAPSHOT_TIMEOUT',
                reason: 'snapshot-timeout',
                resultExtra: { dbIdentifier, region, snapshotId },
            });
        }

        s.stop(color.green('Snapshot available.'));
        console.log(`\n  Snapshot ${color.cyan(snapshotId)} is ready.`);
        console.log(color.dim(`  Restore it with: npx deploy-stack db restore ${snapshotId}\n`));
        await trackSuccess('db_backup_run', { projectName, waited: true });
        outro(color.green('Done.'));
        return { ok: true, snapshotId, status: 'available' };
    } catch (error) {
        await trackFailure('db_backup_run', {
            projectName,
            error_code: error?.name || 'UNKNOWN',
            error_message: error?.message,
        });
        if (handleAuthErrorBranch(error, s, options)) {
            return { ok: false, reason: 'error', dbIdentifier, region };
        }
        try { s.stop(color.red('❌ Db backup failed.')); } catch { /* spinner already stopped */ }
        return failCommand({
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            reason: 'error',
            resultExtra: { dbIdentifier, region },
        });
    }
}

export default runDbBackup;
