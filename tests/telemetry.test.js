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

    it('tags automated test runs without blocking them', () => {
        const fetchMock = mockFetch();
        trackEvent('exec_run', { projectName: 'test' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, { body }] = fetchMock.mock.calls[0];
        const payload = JSON.parse(body);
        // VITEST is set by the runner itself, so this must be true here.
        expect(payload.properties.is_test_env).toBe(true);
    });

    it('marks interactive runs as non-test environments', () => {
        const savedVitest = process.env.VITEST;
        const savedNodeEnv = process.env.NODE_ENV;
        delete process.env.VITEST;
        process.env.NODE_ENV = 'production';
        try {
            const fetchMock = mockFetch();
            trackEvent('exec_run', { projectName: 'test' });
            const [, { body }] = fetchMock.mock.calls[0];
            expect(JSON.parse(body).properties.is_test_env).toBe(false);
        } finally {
            if (savedVitest === undefined) delete process.env.VITEST;
            else process.env.VITEST = savedVitest;
            if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = savedNodeEnv;
        }
    });
});
