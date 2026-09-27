import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    SESSION_MANAGER_PLUGIN_URL,
    resolveContainer,
    hasSessionManagerPlugin,
    printAwsCliGuidance,
    printSessionManagerGuidance,
    printNoTasksGuidance,
} from '../src/utils/ecs.js';

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ECS_CONTAINER;
});

function capturedOutput(fn) {
    const lines = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
        lines.push(args.join(' '));
    });
    fn();
    return lines.join('\n');
}

describe('ecs shared module', () => {
    it('exposes the Session Manager plugin install URL', () => {
        expect(SESSION_MANAGER_PLUGIN_URL).toContain('session-manager-working-with-install-plugin.html');
    });

    it('resolveContainer prefers explicit flags, then ECS_CONTAINER, then project default', () => {
        expect(resolveContainer({ projectName: 'myapp' }, '/tmp')).toBe('myapp-container');
        expect(resolveContainer({ projectName: 'myapp', container: '  web  ' }, '/tmp')).toBe('web');
        expect(resolveContainer({ projectName: 'myapp', containerName: 'api' }, '/tmp')).toBe('api');
        process.env.ECS_CONTAINER = 'from-env';
        expect(resolveContainer({ projectName: 'myapp' }, '/tmp')).toBe('from-env');
    });

    it('hasSessionManagerPlugin reports ENOENT and spawn failures as missing', () => {
        const enoent = new Error('not found');
        enoent.code = 'ENOENT';
        expect(hasSessionManagerPlugin({ spawnSyncImpl: () => { throw new Error('boom'); } })).toBe(false);
        expect(hasSessionManagerPlugin({ spawnSyncImpl: () => ({ error: enoent }) })).toBe(false);
        expect(hasSessionManagerPlugin({ spawnSyncImpl: () => ({}) })).toBe(true);
    });

    it('printAwsCliGuidance defaults to exec wording', () => {
        const out = capturedOutput(() => printAwsCliGuidance());
        expect(out).toContain('exec');
        expect(out).toContain('to open a shell in your container.');
        expect(out).toContain(SESSION_MANAGER_PLUGIN_URL);
    });

    it('printAwsCliGuidance accepts per-command wording', () => {
        const out = capturedOutput(() => printAwsCliGuidance({
            commandName: 'db connect',
            purpose: 'to open a secure tunnel to your database',
        }));
        expect(out).toContain('db connect');
        expect(out).toContain('to open a secure tunnel to your database.');
    });

    it('printSessionManagerGuidance defaults to exec wording', () => {
        const out = capturedOutput(() => printSessionManagerGuidance());
        expect(out).toContain('exec');
        expect(out).toContain('to securely tunnel into your container.');
    });

    it('printSessionManagerGuidance accepts per-command wording', () => {
        const out = capturedOutput(() => printSessionManagerGuidance({
            commandName: 'db connect',
            purpose: 'to securely tunnel to your database',
        }));
        expect(out).toContain('db connect');
        expect(out).toContain('to securely tunnel to your database.');
    });

    it('printNoTasksGuidance names the service, cluster, and reason', () => {
        const out = capturedOutput(() => printNoTasksGuidance('svc', 'clu'));
        expect(out).toContain('svc');
        expect(out).toContain('clu');
        expect(out).toContain('to open an interactive shell.');
        const dbOut = capturedOutput(() => printNoTasksGuidance('svc', 'clu', 'to act as a jump host for the tunnel'));
        expect(dbOut).toContain('to act as a jump host for the tunnel.');
    });
});
