import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { resolveProjectName, resolveWorkspaceSuffix } from './resolvers.js';
import { normalizeOptions } from './args.js';

// Error names the RDS API returns for a missing instance across SDK shapes.
const NOT_FOUND_NAMES = new Set(['DBInstanceNotFound', 'DBInstanceNotFoundFault']);

// Shared RDS instance lookup for every `db` subcommand: exact identifier
// match, `null` when the project has no database, unexpected errors rethrown.
export async function findDbInstance(rdsClient, dbIdentifier) {
    try {
        const resp = await rdsClient.send(
            new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbIdentifier })
        );
        return (resp.DBInstances || [])[0] || null;
    } catch (error) {
        if (error && NOT_FOUND_NAMES.has(error.name)) return null;
        throw error;
    }
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

// Default manual snapshot id: `<db>-manual-YYYYMMDD-HHmmss` in UTC.
// Lowercased so project names with uppercase stay RDS-safe.
export function generateSnapshotId(dbIdentifier, now = new Date()) {
    const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`
        + `-${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
    return `${dbIdentifier}-manual-${stamp}`.toLowerCase();
}

// RDS snapshot identifier rules: starts with a letter, letters/digits/hyphens
// after that, no consecutive hyphens, no trailing hyphen, max 255 chars.
export function isValidSnapshotId(id) {
    if (typeof id !== 'string') return false;
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,254}$/.test(id)) return false;
    if (id.includes('--') || id.endsWith('-')) return false;
    return true;
}

// Database identifier for the current project/workspace. An explicit
// `--db-identifier` override wins; otherwise `<appName>-db`.
export function resolveDbIdentifier(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.dbIdentifier === 'string' && opts.dbIdentifier.trim()) {
        return opts.dbIdentifier.trim();
    }
    const base = resolveProjectName(opts, cwd);
    return `${base}${resolveWorkspaceSuffix(opts, cwd)}-db`;
}
