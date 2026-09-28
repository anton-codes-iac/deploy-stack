import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TELEMETRY_ENDPOINT = 'https://eu.i.posthog.com/capture/';
const POSTHOG_API_KEY = 'phc_o2wgA3jVT9rVDiGSDzFAR42zZeiVGhhCY53HXVHUcYGT';
const pendingRequests = [];

const CLI_ENTRY_BASENAMES = ['cli.js', 'deploy-stack'];

let cachedDistinctId = null;

export function resetTelemetryIdentityCache() {
    cachedDistinctId = null;
}

function sha16(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex').substring(0, 16);
}

// An env var counts as active only when defined with a meaningful value.
// This keeps CI='false', CI='0', and CI='' from masquerading as CI.
export function isActiveEnvValue(value) {
    if (value === undefined || value === null) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

// Distinguishes real CI pipelines from local shells/agents that set CI=true.
// Precedence: specific providers first, then generic CI, then none.
export function detectCiProvider(env = process.env) {
    if (isActiveEnvValue(env.GITHUB_ACTIONS)) return 'github_actions';
    if (isActiveEnvValue(env.GITLAB_CI)) return 'gitlab_ci';
    if (isActiveEnvValue(env.CIRCLECI)) return 'circleci';
    if (isActiveEnvValue(env.JENKINS_URL)) return 'jenkins';
    if (isActiveEnvValue(env.CI) || isActiveEnvValue(env.CONTINUOUS_INTEGRATION)) return 'generic_ci';
    return 'none';
}

export function isTestEnv(env = process.env) {
    return Boolean(env.VITEST || env.NODE_ENV === 'test');
}

function defaultTelemetryIdPath() {
    return path.join(os.homedir(), '.deploy-stack', 'telemetry-id');
}

// Branch A: deterministic machine/CI fingerprint for ephemeral runners.
// Cwd is deliberately excluded so commands from different directories on
// the same runner share one Person within a run.
function fingerprintDistinctId() {
    return sha16([
        os.hostname(),
        os.platform(),
        os.arch(),
        process.env.GITHUB_REPOSITORY || '',
        process.env.GITHUB_RUN_ID || '',
        process.env.GITLAB_PROJECT_PATH || '',
    ].join(':'));
}

// Branch B: persistent random UUID, created on first use. Any filesystem
// failure falls back to the Branch A fingerprint so telemetry never throws.
function persistentDistinctId(idPath) {
    try {
        let raw = '';
        try {
            raw = fs.readFileSync(idPath, 'utf-8').trim();
        } catch {
            raw = '';
        }
        if (!raw) {
            raw = crypto.randomUUID();
            fs.mkdirSync(path.dirname(idPath), { recursive: true });
            fs.writeFileSync(idPath, `${raw}\n`, 'utf-8');
        }
        return sha16(raw);
    } catch {
        return fingerprintDistinctId();
    }
}

export function resolveDistinctId({ ciProvider = detectCiProvider(), testEnv = isTestEnv() } = {}) {
    if (cachedDistinctId) return cachedDistinctId;
    const overridePath = process.env.DEPLOY_STACK_TELEMETRY_ID_PATH;
    let resolved;
    if (typeof overridePath === 'string' && overridePath.trim() !== '') {
        resolved = persistentDistinctId(overridePath);
    } else if (ciProvider !== 'none' || testEnv) {
        resolved = fingerprintDistinctId();
    } else {
        resolved = persistentDistinctId(defaultTelemetryIdPath());
    }
    cachedDistinctId = resolved;
    return resolved;
}

export function trackEvent(eventName, properties) {
    // 1. Respect privacy standards
    if (process.env.DO_NOT_TRACK === '1' || process.env.DO_NOT_TRACK === 'true') {
        return;
    }

    // 2. Keep all events: drop only missing, blank, or non-serializable
    // (object/function) names; normalize the rest so strings like
    // 'cli-error' plus booleans and numbers serialize safely.
    if (
        eventName === undefined ||
        eventName === null ||
        typeof eventName === 'object' ||
        typeof eventName === 'function' ||
        String(eventName).trim() === ''
    ) {
        return;
    }
    const normalizedEvent = String(eventName);

    // 3. Protect the PostHog column schema: only spread plain objects.
    // Primitives and arrays are wrapped so e.g. a string never spreads its
    // character indices (0, 1, 2, ...) as top-level columns.
    let eventProps;
    if (properties === undefined || properties === null) {
        eventProps = {};
    } else if (typeof properties === 'object' && !Array.isArray(properties)) {
        eventProps = { ...properties };
    } else {
        eventProps = { raw_properties: properties };
    }

    // 4. Resolve context first: provider before is_ci, entry before command.
    const ciProvider = detectCiProvider();
    const testEnv = isTestEnv();
    const isCi = isActiveEnvValue(process.env.CI) || ciProvider !== 'none';
    const isCliEntry = CLI_ENTRY_BASENAMES.includes(path.basename(process.argv?.[1] || ''));

    // 5. Machine-scoped Person identity, stable across commands in this env.
    const distinctId = resolveDistinctId({ ciProvider, testEnv });

    // 6. Project-scoped grouping stays in the payload as a hash. Coerce
    // first so non-string projectName values can never throw inside
    // createHash; fall back to the working directory name when omitted.
    let rawProjectName = eventProps.projectName;
    if (rawProjectName === undefined || rawProjectName === null || rawProjectName === '') {
        rawProjectName = path.basename(process.cwd()) || 'unknown';
    }
    const projectId = sha16(rawProjectName);

    // 7. Strip the raw name out of the payload
    delete eventProps.projectName;

    const payload = {
        api_key: POSTHOG_API_KEY,
        event: normalizedEvent,
        distinct_id: distinctId,
        properties: {
            os: process.platform,
            node_version: process.version,
            is_ci: isCi,
            ci_provider: ciProvider,
            is_test_env: testEnv,
            is_tty: Boolean(process.stdout && process.stdout.isTTY),
            is_cli_entry: isCliEntry,
            cli_command: isCliEntry
                ? (process.env.CLI_COMMAND || process.argv.slice(2).join(' ') || 'unknown')
                : 'module_import',
            project_id: projectId,
            framework: process.env.DEPLOY_STACK_FRAMEWORK || eventProps.framework || undefined,
            ...eventProps
        }
    };

    // 6. Fire and forget (No 'await' so we don't block the user's terminal)
    const request = fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).catch(() => {
        // Silently swallow network errors (e.g., user is offline)
    });

    pendingRequests.push(request);
}

export async function flushTelemetry() {
    if (pendingRequests.length > 0) {
        await Promise.all(pendingRequests);
    }
}

// Stamps the success flag onto wrapper properties using trackEvent's own
// normalization: plain objects merge, missing values send the flag alone,
// and anything else (strings, numbers, arrays) wraps as raw_properties so
// a primitive can never spread its indices as top-level columns.
function withSuccessFlag(properties, success) {
    if (properties === undefined || properties === null) {
        return { success };
    }
    if (typeof properties === 'object' && !Array.isArray(properties)) {
        return { ...properties, success };
    }
    return { raw_properties: properties, success };
}

// Reports a successful command outcome: tracks the event stamped
// `success: true` and flushes immediately, so a subsequent exit or
// long-lived process never loses it. Single definition for the
// track+flush pair every command repeats on its happy path.
export async function trackSuccess(eventName, properties = {}) {
    trackEvent(eventName, withSuccessFlag(properties, true));
    await flushTelemetry();
}

// Reports a failed command outcome without terminating: tracks the event
// stamped `success: false` and flushes immediately. Companion to
// trackSuccess for catch blocks that must keep branching (auth recovery,
// not-found guidance) after reporting — failCommand covers terminal failures.
export async function trackFailure(eventName, properties = {}) {
    trackEvent(eventName, withSuccessFlag(properties, false));
    await flushTelemetry();
}
