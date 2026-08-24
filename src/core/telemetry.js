import crypto from 'crypto';

const TELEMETRY_ENDPOINT = 'https://eu.i.posthog.com/capture/';

const POSTHOG_API_KEY = 'phc_o2wgA3jVT9rVDiGSDzFAR42zZeiVGhhCY53HXVHUcYGT';

const pendingRequests = [];

export function trackEvent(eventName, properties) {
    // 1. Respect privacy standards
    if (process.env.DO_NOT_TRACK === '1' || process.env.DO_NOT_TRACK === 'true') {
        return;
    }

    // 2. Hash the project name so it is completely anonymous
    const rawProjectName = properties.projectName || 'unknown';
    const anonymousProjectId = crypto.createHash('sha256').update(rawProjectName).digest('hex').substring(0, 16);

    // 3. Strip the raw name out of the payload
    delete properties.projectName;

    const payload = {
        api_key: POSTHOG_API_KEY,
        event: eventName,
        distinct_id: anonymousProjectId,
        properties: {
            os: process.platform,
            node_version: process.version,
            ...properties
        }
    };

    // 4. Fire and forget (No 'await' so we don't block the user's terminal)
    const request = fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).catch((err) => {
        // Silently swallow network errors (e.g., user is offline)
    });

    pendingRequests.push(request);
}

export async function flushTelemetry() {
    if (pendingRequests.length > 0) {
        await Promise.all(pendingRequests);
    }
}