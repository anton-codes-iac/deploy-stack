import { CloudWatchLogsClient, FilterLogEventsCommand, DescribeLogStreamsCommand } from '@aws-sdk/client-cloudwatch-logs';
import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';

export const DEFAULT_TAIL_LINES = 50;
export const DEFAULT_SINCE = '1h';
export const FOLLOW_POLL_INTERVAL_MS = 2000;
export const FALLBACK_REGION = 'us-east-2';
export const ERROR_KEYWORDS = ['ERROR', 'FATAL', 'Exception', 'fail', '500', '502'];

const ERROR_PATTERN = /ERROR|FATAL|Exception|fail|500|502/i;
const HIGHLIGHT_ERROR_PATTERN = /error|fatal|exception|fail|5\d\d/i;
const WARN_PATTERN = /warn/i;

const SINCE_RE = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/i;
const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };

function readFileSafe(filePath) {
    try {
        if (fsSync.existsSync(filePath)) return fsSync.readFileSync(filePath, 'utf8');
    } catch {
        // Fall through to defaults
    }
    return null;
}

export function readTerraformRegion(cwd = process.cwd()) {
    const mainTf = readFileSafe(path.join(cwd, 'terraform', 'main.tf'));
    if (!mainTf) return null;
    const match = mainTf.match(/region\s*=\s*"([^"]+)"/);
    if (!match || match[1].includes('{{')) return null;
    return match[1];
}

export function readTerraformAppName(cwd = process.cwd()) {
    const mainTf = readFileSafe(path.join(cwd, 'terraform', 'main.tf'));
    if (!mainTf) return null;
    const match = mainTf.match(/app_name\s*=\s*"([^"]+)"/);
    if (!match || match[1].includes('{{')) return null;
    return match[1].replace(/\$\{.*$/, '').replace(/[-_]$/, '');
}

export function resolveRegion(options = {}, cwd = process.cwd()) {
    if (typeof options.region === 'string' && options.region.trim()) {
        return options.region.trim();
    }
    if (typeof process.env.AWS_REGION === 'string' && process.env.AWS_REGION.trim()) {
        return process.env.AWS_REGION.trim();
    }
    return readTerraformRegion(options.cwd || cwd) || FALLBACK_REGION;
}

export function resolveProjectName(options = {}, cwd = process.cwd()) {
    const base = options.cwd || cwd;
    if (typeof options.projectName === 'string' && options.projectName.trim()) {
        return options.projectName.trim();
    }
    return readTerraformAppName(base) || path.basename(path.resolve(base));
}

export function resolveLogGroup(options = {}, cwd = process.cwd()) {
    if (typeof options.logGroup === 'string' && options.logGroup.trim()) {
        return options.logGroup.trim();
    }
    if (typeof options.logGroupName === 'string' && options.logGroupName.trim()) {
        return options.logGroupName.trim();
    }
    if (typeof process.env.ECS_LOG_GROUP === 'string' && process.env.ECS_LOG_GROUP.trim()) {
        return process.env.ECS_LOG_GROUP.trim();
    }
    return `/ecs/${resolveProjectName(options, cwd)}`;
}

export function resolveServiceName(options = {}, cwd = process.cwd()) {
    for (const key of ['service', 'serviceName', 'container']) {
        if (typeof options[key] === 'string' && options[key].trim()) {
            return options[key].trim();
        }
    }
    return resolveProjectName(options, cwd);
}

export function hasExplicitService(options = {}) {
    return ['service', 'serviceName', 'container'].some(
        (key) => typeof options[key] === 'string' && options[key].trim()
    );
}

export function normalizeTailLines(value) {
    const n = typeof value === 'string' && value.trim() === '' ? NaN : parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_TAIL_LINES;
    return n;
}

export function parseSinceDuration(input) {
    if (input === undefined || input === null || input === '') return UNIT_MS.h;
    if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, input * 1000);
    const match = String(input).trim().match(SINCE_RE);
    if (!match) return UNIT_MS.h;
    const amount = parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase()[0];
    return amount * (UNIT_MS[unit] || UNIT_MS.h);
}

// Alias kept for convenience; both names are part of the public surface.
export const parseSince = parseSinceDuration;

export function isErrorLine(line) {
    return ERROR_PATTERN.test(String(line ?? ''));
}

// Alias kept for convenience.
export const matchesErrorFilter = isErrorLine;

export function extractTaskId(logStreamName) {
    if (!logStreamName) return '';
    const parts = String(logStreamName).split('/');
    return parts[parts.length - 1] || '';
}

export function formatLogLine(event = {}) {
    const timestamp = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
    const taskId = extractTaskId(event.logStreamName);
    const message = String(event.message ?? '').replace(/\n$/, '');
    let body = message;
    if (HIGHLIGHT_ERROR_PATTERN.test(message)) {
        body = color.red(message);
    } else if (WARN_PATTERN.test(message)) {
        body = color.yellow(message);
    }
    return taskId ? `${color.dim(timestamp)} ${color.dim(taskId)} ${body}` : `${color.dim(timestamp)} ${body}`;
}

// Alias kept for convenience.
export const formatLogEvent = formatLogLine;

export function parseLogsArgs(argv = []) {
    const args = [...argv];
    if (args[0] === 'logs') args.shift();
    const options = {};
    const positionals = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--follow' || arg === '-f') {
            options.follow = true;
        } else if (arg === '--error') {
            options.error = true;
        } else if (arg === '--tail' && i + 1 < args.length) {
            options.tail = Number(args[++i]);
        } else if (arg.startsWith('--tail=')) {
            options.tail = Number(arg.slice('--tail='.length));
        } else if (arg === '--since' && i + 1 < args.length) {
            options.since = args[++i];
        } else if (arg.startsWith('--since=')) {
            options.since = arg.slice('--since='.length);
        } else if (arg === '--region' && i + 1 < args.length) {
            options.region = args[++i];
        } else if (arg.startsWith('--region=')) {
            options.region = arg.slice('--region='.length);
        } else if (!arg.startsWith('-')) {
            positionals.push(arg);
        }
    }
    if (positionals.length > 0) options.service = positionals[0];
    return options;
}

function eventKey(event) {
    if (event.eventId) return `id:${event.eventId}`;
    return `${event.timestamp}:${event.message}`;
}

function isAuthError(error) {
    return error && (error.name === 'ExpiredTokenException' || error.name === 'UnrecognizedClientException');
}

function isNotFoundError(error) {
    return error && (
        error.name === 'ResourceNotFoundException' ||
        /log group .* (does not exist|not found|cannot be found)/i.test(error.message || '')
    );
}

function printSessionExpiredGuidance() {
    console.log(color.yellow('\n⚠️  AWS Session Expired / Invalid Credentials'));
    console.log(`Run ${color.cyan('aws sso login')} or ${color.cyan('aws configure')} to refresh your credentials.`);
}

function printMissingLogGroupGuidance(logGroup, service, region) {
    console.log(color.yellow(`\n⚠ No log group found for "${service}" (expected ${logGroup}).`));
    console.log(color.dim(`List matching groups with: aws logs describe-log-groups --log-group-name-prefix "/ecs/" --region ${region}`));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildClient(region, injected) {
    if (injected && typeof injected.send === 'function') return injected;
    return new CloudWatchLogsClient({ region });
}

export async function runLogs(options = {}) {
    const cwd = options.cwd || process.cwd();
    const region = resolveRegion(options, cwd);
    const service = resolveServiceName(options, cwd);
    const logGroup = resolveLogGroup(options, cwd);
    const tail = normalizeTailLines(options.tail ?? options.tailLines ?? options.lines);
    const follow = Boolean(options.follow ?? options.f);
    const onlyErrors = Boolean(options.error ?? options.onlyErrors ?? options.filterErrors);
    const explicitService = hasExplicitService(options);

    const sinceRaw = options.since ?? options.sinceDuration ?? (follow ? undefined : DEFAULT_SINCE);
    const startTime = sinceRaw === undefined ? undefined : Date.now() - parseSinceDuration(sinceRaw);

    const pollIntervalMs = options.pollIntervalMs ?? FOLLOW_POLL_INTERVAL_MS;
    const maxPolls = options.maxPolls ?? (follow ? Infinity : 1);

    if (process.env.CI_MOCK_AWS === 'true' && !options.logsClient && !options.client) {
        const mocked = ['INFO service started', 'ERROR mocked failure for offline mode'];
        const visible = onlyErrors ? mocked.filter(isErrorLine) : mocked;
        for (const line of visible.slice(-tail)) console.log(formatLogLine({ timestamp: Date.now(), message: line }));
        return { logs: visible.slice(-tail), logGroup, region, service, mocked: true };
    }

    const logsClient = buildClient(region, options.logsClient ?? options.client ?? options.cloudwatchClient);

    let stopped = false;
    const onSigint = () => {
        stopped = true;
        console.log(color.dim('\nStopped following logs.'));
    };
    if (follow) process.once('SIGINT', onSigint);

    try {
        try {
            await logsClient.send(new DescribeLogStreamsCommand({ logGroupName: logGroup, limit: 1 }));
        } catch (verifyError) {
            if (isAuthError(verifyError)) throw verifyError;
            if (isNotFoundError(verifyError)) {
                printMissingLogGroupGuidance(logGroup, service, region);
                return { logs: [], logGroup, region, service };
            }
            // Any other verification failure is non-fatal: the fetch below is authoritative.
        }

        const seen = new Set();
        const collected = [];
        let nextToken;
        let polls = 0;
        let firstPoll = true;

        do {
            const input = { logGroupName: logGroup, limit: Math.min(Math.max(tail, 1), 10000) };
            if (startTime !== undefined) input.startTime = startTime;
            if (explicitService) input.logStreamNamePrefix = service;
            if (nextToken) input.nextToken = nextToken;

            const resp = await logsClient.send(new FilterLogEventsCommand(input));
            if (resp.nextToken) nextToken = resp.nextToken;

            if (seen.size > 5000) seen.clear();

            let fresh = (resp.events || []).filter((e) => {
                const key = eventKey(e);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            if (onlyErrors) fresh = fresh.filter((e) => isErrorLine(e.message));
            if (firstPoll) fresh = fresh.slice(-tail);

            for (const event of fresh) {
                console.log(formatLogLine(event));
                collected.push(String(event.message ?? ''));
            }

            firstPoll = false;
            polls += 1;
            if (!follow || stopped || polls >= maxPolls) break;
            await sleep(pollIntervalMs);
        } while (true);

        if (collected.length === 0) {
            console.log(color.cyan(`\nℹ Waiting for logs...`));
            console.log(`  The log group "${logGroup}" exists, but no application logs have been written yet.`);
            console.log(`  This is perfectly normal immediately after running 'apply' while the container boots.`);
            console.log(`  Try again in a minute, or run ${color.green('npx deploy-stack logs -f')} to watch the stream live.\n`);
        }

        trackEvent('logs_streamed', {
            projectName: resolveProjectName(options, cwd),
            is_following: follow,
            filtered_errors: onlyErrors,
            tail_lines: tail,
            success: true
        });
        await flushTelemetry();

        return { logs: collected, logGroup, region, service };
    } catch (error) {

        trackEvent('logs_streamed', {
            projectName: resolveProjectName(options, cwd),
            success: false,
            error_type: error.name || 'UNKNOWN'
        });
        await flushTelemetry();

        if (isAuthError(error)) {
            printSessionExpiredGuidance();
            process.exit(1);
            return { logs: [], logGroup, region, service };
        }
        if (isNotFoundError(error)) {
            printMissingLogGroupGuidance(logGroup, service, region);
            return { logs: [], logGroup, region, service };
        }

        throw error;
    } finally {
        if (follow) process.removeListener('SIGINT', onSigint);
    }
}

// Convenience alias mirroring the CLI verb.
export const logsCommand = runLogs;

export default runLogs;
