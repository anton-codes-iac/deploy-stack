import { describe, it, expect, vi, afterEach } from 'vitest';
import { trackEvent } from '../src/core/telemetry.js';

describe('trackEvent noise guard', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.DO_NOT_TRACK;
    });

    function mockFetch() {
        const fn = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fn);
        return fn;
    }

    it.each([
        'exec_run',
        'diagnose_run',
        'status_run',
        'gc_run',
        'doctor_run',
        'secrets_pushed',
        'secrets_pull',
        'secrets_audit',
        'logs_streamed',
        'sync_ai_executed',
        'project_provisioned',
        'project_ejected',
        'infrastructure_applied',
        'infrastructure_destroyed',
        'recovery_prompted',
        'recovery_failed',
        'cli-error',
    ])('sends legitimate event %s', (eventName) => {
        const fetchMock = mockFetch();
        trackEvent(eventName, { projectName: 'test' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['message', 'data', 'true'])('drops junk event %s', (eventName) => {
        const fetchMock = mockFetch();
        trackEvent(eventName, { projectName: 'test' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([undefined, null, 42, {}, true])('drops non-string event %s', (eventName) => {
        const fetchMock = mockFetch();
        trackEvent(eventName, { projectName: 'test' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
