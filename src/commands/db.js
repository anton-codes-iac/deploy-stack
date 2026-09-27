import color from 'picocolors';
import { failCommand } from '../utils/command.js';
import { normalizeOptions, normalizeArgv } from '../utils/args.js';
import { runDbConnect, parseDbArgs } from './db/connect.js';
import { runDbMigrate, parseDbMigrateArgs } from './db/migrate.js';
import { runDbBackup, parseDbBackupArgs } from './db/backup.js';
import { runDbRestore, parseDbRestoreArgs } from './db/restore.js';

// Dispatcher + re-export barrel for the `db` subcommands. Existing imports
// of `../src/commands/db.js` (bin/cli.js, tests) keep working unchanged.
export { runDbConnect, parseDbArgs } from './db/connect.js';
export {
    isValidPort,
    buildConnectionString,
    formatConnectionInfo,
    buildSsmArgs,
    DEFAULT_LOCAL_PORT,
    MASKED_PASSWORD,
    dbCommand,
} from './db/connect.js';
export { runDbMigrate, parseDbMigrateArgs } from './db/migrate.js';
export { runDbBackup, parseDbBackupArgs } from './db/backup.js';
export { runDbRestore, parseDbRestoreArgs, upsertSnapshotIdentifier } from './db/restore.js';
export { resolveDbIdentifier, findDbInstance, generateSnapshotId, isValidSnapshotId } from '../utils/rds.js';
export { pickRuntimeContainer } from '../utils/ecs.js';
export { detectMigrationCommand } from '../utils/detector.js';

export const DB_SUBCOMMANDS = ['connect', 'migrate', 'backup', 'restore'];

function printDbUsage() {
    console.log('Usage:');
    console.log('  deploy-stack db connect [--port <local-port>] [--show-credentials] [--workspace <name>] [--region <region>] [--cluster <name>] [--service <name>]');
    console.log('  deploy-stack db migrate [--cmd <command>] [--task-def <task-def>] [--timeout <seconds>] [--setup-ci] [--project-name <name>] [--workspace <name>] [--region <region>] [--cluster <name>] [--service <name>] [--container <name>]');
    console.log('  deploy-stack db backup [--id <snapshot-id>] [--timeout <seconds>] [--no-wait] [--project-name <name>] [--workspace <name>] [--region <region>] [--db-identifier <id>]');
    console.log('  deploy-stack db restore [<snapshot-id>] [--yes] [--project-name <name>] [--workspace <name>] [--region <region>] [--db-identifier <id>]');
}

export async function runDb(argv = [], extraOptions = {}) {
    const args = normalizeArgv(argv);
    const extra = normalizeOptions(extraOptions);
    if (args[0] === 'db') args.shift();
    const subcommand = args[0] && !String(args[0]).startsWith('-') ? args[0] : undefined;

    if (subcommand === 'connect') {
        return runDbConnect({ ...parseDbArgs(argv), ...extra });
    }
    if (subcommand === 'migrate') {
        return runDbMigrate({ ...parseDbMigrateArgs(argv), ...extra });
    }
    if (subcommand === 'backup') {
        return runDbBackup({ ...parseDbBackupArgs(argv), ...extra });
    }
    if (subcommand === 'restore') {
        return runDbRestore({ ...parseDbRestoreArgs(argv), ...extra });
    }

    return failCommand({
        print: () => {
            if (subcommand === undefined) {
                console.log(color.yellow('\n⚠ Missing db subcommand.'));
            } else {
                console.log(color.red(`\n✖ Unknown db subcommand "${subcommand}".`));
            }
            console.log('');
            printDbUsage();
            console.log('');
        },
        event: 'db_run',
        telemetry: {},
        errorCode: 'UNKNOWN_DB_SUBCOMMAND',
        reason: 'unknown-db-subcommand',
    });
}

export default runDbConnect;
