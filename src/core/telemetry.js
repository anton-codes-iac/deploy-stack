import crypto from 'crypto';

const TELEMETRY_ENDPOINT = 'https://eu.i.posthog.com/capture/';
const POSTHOG_API_KEY = 'phc_o2wgA3jVT9rVDiGSDzFAR42zZeiVGhhCY53HXVHUcYGT';
const pendingRequests = [];

const VALID_EVENT_SUBSTRINGS = ['_run', '_pushed', '_pull', '_audit', '_streamed', '_executed', '_provisioned', '_ejected', '_applied', '_destroyed', 'recovery_', 'cli-error'];

export function trackEvent(eventName, properties) {
    // 0. Drop rogue/junk events (stray bindings, bot traffic)
    if (typeof eventName !== 'string') {
        return;
    }
    if (!VALID_EVENT_SUBSTRINGS.some((validStr) => eventName.includes(validStr))) {
        return;
    }

    // 1. Respect privacy standards
    if (process.env.DO_NOT_TRACK === '1' || process.env.DO_NOT_TRACK === 'true') {
        return;
    }

    // 2. Hash the project name so it is completely anonymous
    const eventProps = { ...properties };

    const rawProjectName = eventProps.projectName || 'unknown';
    const anonymousProjectId = crypto.createHash('sha256').update(rawProjectName).digest('hex').substring(0, 16);

    // 3. Strip the raw name out of the payload
    delete eventProps.projectName;

    const payload = {
        api_key: POSTHOG_API_KEY,
        event: eventName,
        distinct_id: anonymousProjectId,
        properties: {
            os: process.platform,
            node_version: process.version,
            is_ci: Boolean(process.env.CI || process.env.CONTINUOUS_INTEGRATION),
            is_test_env: Boolean(process.env.VITEST || process.env.NODE_ENV === 'test'),
            cli_command: process.env.CLI_COMMAND || process.argv.slice(2).join(' ') || 'unknown',
            framework: process.env.DEPLOY_STACK_FRAMEWORK || eventProps.framework || undefined,
            ...eventProps
        }
    };

    // 4. Fire and forget (No 'await' so we don't block the user's terminal)
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