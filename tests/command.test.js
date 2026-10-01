import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// NOTE: helper imports must stay above src imports: vi.mock factories run
// during module evaluation and need the factories initialized.
import { telemetryMockFactory } from './helpers/telemetry.js';
import { mockConsoleTrio } from './helpers/console.js';
import { failCommand, failProjectNotInitialized } from '../src/utils/command.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';

vi.mock('../src/core/telemetry.js', (importOriginal) => telemetryMockFactory(importOriginal));

describe('failCommand', () => {
    let exitSpy;
    let logSpy;
    let errorSpy;
    let spies;

    beforeEach(() => {
        vi.clearAllMocks();
        spies = mockConsoleTrio();
        ({ exitSpy, logSpy, errorSpy } = spies);
    });

    afterEach(() => {
        spies.restore();
    });

    it('prints, tracks, flushes, exits, and returns the standard result', async () => {
        const result = await failCommand({
            message: '\n✖ Bad input.',
            hint: '  Fix it.',
            event: 'add_run',
            telemetry: { capability: 'x', error_code: 'BAD' },
            reason: 'bad-input',
            resultExtra: { capability: 'x' },
        });
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Bad input.'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Fix it.'));
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            capability: 'x',
            error_code: 'BAD',
            success: false,
        });
        expect(flushTelemetry).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(result).toEqual({ ok: false, reason: 'bad-input', capability: 'x' });
    });

    it('supports custom printers, error stream, and tones', async () => {
        const print = vi.fn();
        await failCommand({ print, exitCode: 2 });
        expect(print).toHaveBeenCalledTimes(1);
        expect(logSpy).not.toHaveBeenCalled();
        expect(trackEvent).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(2);

        await failCommand({ message: 'warn', tone: 'yellow', useErrorStream: true, exitCode: null });
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('warn'));
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    it('skips telemetry, exit, and reason when omitted', async () => {
        const result = await failCommand({ message: 'soft', exitCode: null });
        expect(trackEvent).not.toHaveBeenCalled();
        expect(flushTelemetry).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(result).toEqual({ ok: false });
    });

    it('stamps errorCode and merges extra into telemetry', async () => {
        await failCommand({
            message: 'failed',
            event: 'db_migrate_run',
            telemetry: { cmd_source: 'explicit' },
            errorCode: 'MIGRATION_TASK_FAILED',
            extra: { exit_code: 3 },
            reason: 'migration-task-failed',
            exitCode: 3,
        });
        expect(trackEvent).toHaveBeenCalledWith('db_migrate_run', {
            cmd_source: 'explicit',
            error_code: 'MIGRATION_TASK_FAILED',
            exit_code: 3,
            success: false,
        });
        expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('failProjectNotInitialized emits the structured not-initialized failure', async () => {
        const result = await failProjectNotInitialized({ event: 'logs_streamed' });
        expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
        expect(trackEvent).toHaveBeenCalledWith('logs_streamed', {
            error_code: 'PROJECT_NOT_INITIALIZED',
            success: false,
        });
        expect(flushTelemetry).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Could not determine the project'));
    });
});
