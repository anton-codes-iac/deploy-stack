import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { trackEvent } from '../src/core/telemetry.js';

describe('trackEvent capture', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.DO_NOT_TRACK;
    });

    function mockFetch() {
        const fn = vi.fn().mockResolvedValue({});
        vi.stubGlobal('fetch', fn);
        return fn;
    }

    function lastPayload(fetchMock) {
        const [, { body }] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
        return JSON.parse(body);
    }

    it.each([
        'exec_run',
        'diagnose_run',
        'status_run',
        'gc_run',
        'doctor_run',
        'rollback_run',
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

    it.each(['message', 'data', 'true', true, 1])('captures unexpected event %s without dropping it', (eventName) => {
        const fetchMock = mockFetch();
        trackEvent(eventName, { projectName: 'test' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lastPayload(fetchMock).event).toBe(String(eventName));
    });

    it.each([undefined, null, '', '   '])('drops missing or blank event %s', (eventName) => {
        const fetchMock = mockFetch();
        trackEvent(eventName, { projectName: 'test' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([['test', 'test'], [['a', 'b'], ['a', 'b']]])(
        'wraps non-object properties without spreading indexed keys',
        (eventName, properties) => {
            const fetchMock = mockFetch();
            trackEvent(eventName, properties);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const payload = lastPayload(fetchMock);
            expect(payload.properties.raw_properties).toEqual(properties);
            expect(payload.properties).not.toHaveProperty('0');
        }
    );

    it('hashes a non-string projectName cleanly without throwing', () => {
        const fetchMock = mockFetch();
        expect(() => trackEvent('test', { projectName: 42 })).not.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const expectedId = crypto.createHash('sha256').update('42').digest('hex').substring(0, 16);
        expect(lastPayload(fetchMock).distinct_id).toBe(expectedId);
    });

    it('tags automated test runs without blocking them', () => {
        const fetchMock = mockFetch();
        trackEvent('exec_run', { projectName: 'test' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const payload = lastPayload(fetchMock);
        // VITEST is set by the runner itself, so this must be true here.
        expect(payload.properties.is_test_env).toBe(true);
        expect(typeof payload.properties.is_tty).toBe('boolean');
        expect(typeof payload.properties.is_cli_entry).toBe('boolean');
    });

    it.each([
        ['/repo/bin/cli.js', true],
        ['/opt/tools/deploy-stack', true],
        ['/repo/node_modules/vitest/vitest.mjs', false],
    ])('detects CLI entry from argv[1] %s as %s', (entry, expected) => {
        const savedArgv = process.argv;
        process.argv = ['node', entry];
        try {
            const fetchMock = mockFetch();
            trackEvent('exec_run', { projectName: 'test' });
            expect(lastPayload(fetchMock).properties.is_cli_entry).toBe(expected);
        } finally {
            process.argv = savedArgv;
        }
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
