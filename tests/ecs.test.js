import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    SESSION_MANAGER_PLUGIN_URL,
    resolveContainer,
    hasSessionManagerPlugin,
    fetchActiveService,
    pickRuntimeContainer,
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

    it('fetchActiveService returns the service only when ACTIVE', async () => {
        const active = { serviceName: 's', status: 'ACTIVE' };
        const seen = [];
        const client = {
            send: vi.fn((cmd) => {
                seen.push(cmd.input);
                return Promise.resolve({ services: [active] });
            }),
        };
        await expect(fetchActiveService(client, 'c', 's')).resolves.toBe(active);
        expect(seen[0]).toEqual({ cluster: 'c', services: ['s'] });

        const inactive = { send: vi.fn(() => Promise.resolve({ services: [{ status: 'INACTIVE' }] })) };
        await expect(fetchActiveService(inactive, 'c', 's')).resolves.toBeNull();
        const missing = { send: vi.fn(() => Promise.resolve({ services: [] })) };
        await expect(fetchActiveService(missing, 'c', 's')).resolves.toBeNull();
    });

    it('pickRuntimeContainer prefers the expected name, then RUNNING, then first', () => {
        const task = {
            containers: [
                { name: 'redis', lastStatus: 'RUNNING', runtimeId: 'rt-redis' },
                { name: 'myapp-container', lastStatus: 'RUNNING', runtimeId: 'rt-app' },
            ],
        };
        expect(pickRuntimeContainer(task, 'myapp-container').runtimeId).toBe('rt-app');
        expect(pickRuntimeContainer(task, 'missing').runtimeId).toBe('rt-redis');
        expect(pickRuntimeContainer({ containers: [{ name: 'only' }] }, 'missing').name).toBe('only');
        expect(pickRuntimeContainer({ containers: [] }, 'missing')).toBeNull();
    });

    it('pickRuntimeContainer also reads task-definition containerDefinitions', () => {
        const taskDef = { containerDefinitions: [{ name: 'a' }, { name: 'b' }] };
        expect(pickRuntimeContainer(taskDef, 'b').name).toBe('b');
        expect(pickRuntimeContainer(taskDef, 'missing').name).toBe('a');
        expect(pickRuntimeContainer({}, 'missing')).toBeNull();
    });

    it.each([null, undefined, 'string', 42, true, { port: 'string' }])('resolveContainer(%s) behaves like {}', (bad) => {
        expect(resolveContainer(bad)).toBe(resolveContainer({}));
        expect(resolveContainer(bad, 42)).toBe(resolveContainer({}));
    });
});
