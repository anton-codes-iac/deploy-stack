import util from 'util';
import { exec } from 'child_process';

const execAsync = util.promisify(exec);

export async function checkDependency(command) {
    try {
        await execAsync(`${command} --version`);
        return true;
    } catch (error) {
        return false;
    }
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parses a `--timeout` flag value (seconds). Returns the default when the
// flag is omitted, the positive integer when valid, or null when invalid.
export function parseTimeoutSeconds(value, defaultSeconds) {
    if (value === undefined || value === null || String(value).trim() === '') return defaultSeconds;
    if (!/^\d+$/.test(String(value).trim())) return null;
    const seconds = Number(String(value).trim());
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
    return seconds;
}

// Shared polling loop: runs `onTick({ elapsedMs })` immediately, then every
// `intervalMs`, until it resolves `{ done: true, value }` or `timeoutMs`
// elapses. Resolves `{ done: true, value }` or `{ timedOut: true }`.
// `sleepFn`/`nowFn` are injectable so tests never wait on real timers.
export async function pollUntil({ intervalMs = 2000, timeoutMs = 600000, sleepFn = sleep, nowFn = Date.now, onTick }) {
    const startTime = nowFn();
    for (;;) {
        const elapsedMs = nowFn() - startTime;
        if (elapsedMs >= timeoutMs) return { timedOut: true };
        const outcome = await onTick({ elapsedMs });
        if (outcome && outcome.done) return { done: true, value: outcome.value };
        await sleepFn(intervalMs);
    }
}