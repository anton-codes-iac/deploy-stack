import fsSync from 'fs';
import path from 'path';
import { normalizeOptions } from './args.js';
import { resolveProjectName, resolveWorkspaceSuffix, resolveCluster, resolveService, resolveCwd } from './resolvers.js';
import { resolveDbIdentifier, resolveDbClusterIdentifier } from './rds.js';

export const SLEEP_STATE_DIRNAME = '.deploy-stack';
export const SLEEP_STATE_FILENAME = 'sleep-state.json';
export const RDS_AUTO_RESTART_DAYS = 7;
export const RDS_AUTO_RESTART_MS = RDS_AUTO_RESTART_DAYS * 24 * 60 * 60 * 1000;

// Environment aliases that address the default/production environment.
// Returns the canonical env name, or null when no env was requested.
export function normalizeSleepEnv(rawEnv) {
    if (typeof rawEnv !== 'string') return null;
    const trimmed = rawEnv.trim();
    if (trimmed === '') return null;
    const lowered = trimmed.toLowerCase();
    if (lowered === 'default' || lowered === 'prod' || lowered === 'production') return 'default';
    return trimmed;
}

// Shared target resolution for `sleep` / `wake`: an explicit `--workspace`
// wins over the positional `[env]`; either beats the
// `.terraform/environment` auto-detect; otherwise the default environment.
// Explicit `--cluster` / `--service` / `--db-identifier` overrides still win
// inside the resolvers. Returns `{ envKey, envKind, requiresConfirm,
// appPrefix, cluster, appService, workerService, dbIdentifier,
// dbClusterIdentifier }`.
export function resolveSleepTarget(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    const base = resolveCwd(opts, cwd);
    const projectName = resolveProjectName(opts, base);
    const rawEnv = (typeof opts.workspace === 'string' && opts.workspace.trim() !== '')
        ? opts.workspace
        : opts.env;
    const env = normalizeSleepEnv(rawEnv);
    const scoped = { ...opts, workspace: env === null ? opts.workspace : env };
    const suffix = resolveWorkspaceSuffix(scoped, base);
    const appPrefix = `${projectName}${suffix}`;
    const prefixed = { ...scoped, projectName: appPrefix };
    const unprefixed = { ...scoped, projectName };
    return {
        envKey: suffix === '' ? 'default' : suffix.slice(1),
        envKind: suffix === '' ? 'default' : 'named',
        // The production guard fires unless an explicit non-default env was
        // passed — an auto-detected named workspace still prompts, since the
        // user never named it on the command line.
        requiresConfirm: env === null || env === 'default',
        appPrefix,
        cluster: resolveCluster(prefixed, base),
        appService: resolveService(prefixed, base),
        workerService: `${appPrefix}-worker-service`,
        dbIdentifier: resolveDbIdentifier(unprefixed, base),
        dbClusterIdentifier: resolveDbClusterIdentifier(unprefixed, base),
    };
}

export function sleepStatePath(cwd = process.cwd()) {
    return path.join(resolveCwd({}, cwd), SLEEP_STATE_DIRNAME, SLEEP_STATE_FILENAME);
}

// Reads the per-env sleep ledger (`{ [env]: entry }`). Missing or corrupt
// files read as empty so a hand-edited file never crashes wake/sleep.
export function readSleepState(cwd = process.cwd()) {
    try {
        const parsed = JSON.parse(fsSync.readFileSync(sleepStatePath(cwd), 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
        // Fall through to the empty ledger.
    }
    return {};
}

export function writeSleepState(cwd = process.cwd(), state = {}) {
    const filePath = sleepStatePath(cwd);
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function removeSleepStateEntry(cwd = process.cwd(), envKey = 'default') {
    const state = readSleepState(cwd);
    if (!Object.prototype.hasOwnProperty.call(state, envKey)) return false;
    delete state[envKey];
    writeSleepState(cwd, state);
    return true;
}

// Keeps the advisory sleep ledger out of git. Returns true when the file was
// created or amended, false when the rule already existed or the write failed.
export function ensureSleepGitignore(cwd = process.cwd()) {
    const base = resolveCwd({}, cwd);
    const file = path.join(base, '.gitignore');
    let content = null;
    try {
        if (fsSync.existsSync(file)) content = fsSync.readFileSync(file, 'utf8');
    } catch {
        content = null;
    }
    if (typeof content === 'string' && content.split('\n').some((line) => line.trim() === `${SLEEP_STATE_DIRNAME}/`)) {
        return false;
    }
    const entry = `# Local deploy-stack runtime state (sleep/wake)\n${SLEEP_STATE_DIRNAME}/\n`;
    try {
        if (content === null) {
            fsSync.writeFileSync(file, entry, 'utf8');
        } else {
            fsSync.appendFileSync(file, content.endsWith('\n') ? `\n${entry}` : `\n\n${entry}`, 'utf8');
        }
    } catch {
        return false;
    }
    return true;
}

// AWS automatically restarts stopped RDS instances and Aurora clusters after
// 7 consecutive days. Pure over an injectable clock for unit tests.
export function computeAutoRestartAt(nowMs = Date.now()) {
    return new Date(nowMs + RDS_AUTO_RESTART_MS);
}

export function formatUtcTimestamp(date) {
    const d = date instanceof Date ? date : new Date(date);
    const pad = (value) => String(value).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
        + ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
