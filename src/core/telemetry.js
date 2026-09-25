import crypto from 'crypto';
import path from 'path';

const TELEMETRY_ENDPOINT = 'https://eu.i.posthog.com/capture/';
const POSTHOG_API_KEY = 'phc_o2wgA3jVT9rVDiGSDzFAR42zZeiVGhhCY53HXVHUcYGT';
const pendingRequests = [];

const CLI_ENTRY_BASENAMES = ['cli.js', 'deploy-stack'];

export function trackEvent(eventName, properties) {
    // 1. Respect privacy standards
    if (process.env.DO_NOT_TRACK === '1' || process.env.DO_NOT_TRACK === 'true') {
        return;
    }

    // 2. Keep all events: drop only missing or blank names, normalize the rest
    // so booleans and numbers serialize safely.
    if (eventName === undefined || eventName === null || String(eventName).trim() === '') {
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

    // 4. Hash the project name so it is completely anonymous. Coerce first so
    // non-string projectName values can never throw inside createHash.
    const rawProjectName = eventProps.projectName ?? 'unknown';
    const anonymousProjectId = crypto.createHash('sha256').update(String(rawProjectName)).digest('hex').substring(0, 16);

    // 5. Strip the raw name out of the payload
    delete eventProps.projectName;

    const payload = {
        api_key: POSTHOG_API_KEY,
        event: normalizedEvent,
        distinct_id: anonymousProjectId,
        properties: {
            os: process.platform,
            node_version: process.version,
            is_ci: Boolean(process.env.CI || process.env.CONTINUOUS_INTEGRATION),
            is_test_env: Boolean(process.env.VITEST || process.env.NODE_ENV === 'test'),
            is_tty: Boolean(process.stdout && process.stdout.isTTY),
            is_cli_entry: Boolean(process.argv && typeof process.argv[1] === 'string' && CLI_ENTRY_BASENAMES.includes(path.basename(process.argv[1]))),
            cli_command: process.env.CLI_COMMAND || process.argv.slice(2).join(' ') || 'unknown',
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
