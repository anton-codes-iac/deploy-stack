import color from 'picocolors';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';

function paint(tone, fallback) {
    return typeof color[tone] === 'function' ? color[tone] : fallback;
}

// Shared failure path for CLI commands: prints the failure, records
// telemetry (always flushed before exit so failures are never lost),
// exits with the given code, and returns a standard `{ ok: false }`
// result for programmatic callers and unit tests.
//
// - `message`/`hint` cover the common red-message + dim-hint shape;
//   pass `print` for anything custom (guidance printers, Clack cancels).
// - Omit `event` to skip telemetry (early pre-flight guards).
// - Pass `exitCode: null` to return without exiting (soft failures).
// - `errorCode` stamps `error_code` into telemetry without repeating the
//   whole `telemetry` object; `extra` merges additional telemetry fields.
export async function failCommand({
    message = null,
    hint = null,
    tone = 'red',
    hintTone = 'dim',
    print = null,
    useErrorStream = false,
    event = null,
    telemetry = {},
    errorCode = null,
    extra = {},
    reason = null,
    resultExtra = {},
    exitCode = 1,
} = {}) {
    if (typeof print === 'function') {
        print();
    } else {
        const write = useErrorStream ? console.error : console.log;
        if (message !== null && message !== undefined) write(paint(tone, color.red)(message));
        if (hint) write(paint(hintTone, color.dim)(hint));
    }
    if (event) {
        trackEvent(event, {
            ...telemetry,
            ...(errorCode === null ? {} : { error_code: errorCode }),
            ...extra,
            success: false,
        });
        await flushTelemetry();
    }
    if (typeof exitCode === 'number') process.exit(exitCode);
    return { ok: false, ...(reason === null ? {} : { reason }), ...resultExtra };
}

// Shared project-resolution failure: when a command cannot determine even
// its working directory or project identity (uninitialized directory,
// deleted cwd, programmatic misuse), fail structured instead of throwing.
export async function failProjectNotInitialized({ event }) {
    return failCommand({
        message: '\n✖ Could not determine the project. Run this command from a directory initialized with deploy-stack.',
        hint: 'If the problem persists, re-run npx deploy-stack init.\n',
        event,
        errorCode: 'PROJECT_NOT_INITIALIZED',
        reason: 'project-not-initialized',
    });
}
