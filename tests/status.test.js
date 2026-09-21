import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runStatus, parseStatusArgs, getServiceHealth, DEGRADED_MESSAGE } from '../src/commands/status.js';
import { runDiagnose } from '../src/commands/diagnose.js';

vi.mock('../src/commands/diagnose.js', () => ({
    runDiagnose: vi.fn().mockResolvedValue({ healthy: false }),
}));

vi.mock('@clack/prompts', () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

vi.mock('../src/core/telemetry.js', () => ({
    trackEvent: vi.fn(),
    flushTelemetry: vi.fn().mockResolvedValue(),
}));

function mockEcsClient(serviceDesc) {
    return { send: vi.fn().mockResolvedValue({ services: [serviceDesc] }) };
}

function mockCloudWatchClient(alarms = []) {
    return { send: vi.fn().mockResolvedValue({ MetricAlarms: alarms, CompositeAlarms: [] }) };
}

const healthyService = {
    serviceName: 'myapp-service',
    status: 'ACTIVE',
    desiredCount: 2,
    runningCount: 2,
    pendingCount: 0,
};

describe('status: CLI args', () => {
    it('parses --region and --json', () => {
        expect(parseStatusArgs(['status', '--region', 'eu-west-1', '--json'])).toEqual({
            region: 'eu-west-1',
            json: true,
        });
        expect(parseStatusArgs(['status', '--region=us-west-2'])).toEqual({ region: 'us-west-2' });
        expect(parseStatusArgs(['status'])).toEqual({});
    });
});

describe('status: health calculation', () => {
    it('is healthy when running matches desired and alarms are OK', () => {
        const health = getServiceHealth(healthyService, [{ AlarmName: 'a', StateValue: 'OK' }]);
        expect(health.healthy).toBe(true);
        expect(health.alarmed).toHaveLength(0);
    });

    it('is unhealthy when running is below desired', () => {
        const health = getServiceHealth({ ...healthyService, runningCount: 1 }, []);
        expect(health.healthy).toBe(false);
    });

    it('is unhealthy when any alarm is in ALARM state', () => {
        const health = getServiceHealth(healthyService, [{ AlarmName: 'x', StateValue: 'ALARM' }]);
        expect(health.healthy).toBe(false);
        expect(health.alarmed).toHaveLength(1);
    });
});

describe('Command: status (mocked ECS + CloudWatch)', () => {
    const savedEnv = { ...process.env };
    let exitSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.AWS_REGION;
        delete process.env.ECS_CLUSTER;
        delete process.env.ECS_SERVICE;
        delete process.env.ECS_LOG_GROUP;
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
    });

    afterEach(() => {
        process.env = { ...savedEnv };
        exitSpy.mockRestore();
    });

    it('exits cleanly with a green dashboard when healthy', async () => {
        const ecsClient = mockEcsClient(healthyService);
        const cloudWatchClient = mockCloudWatchClient([{ AlarmName: 'myapp-high-5xx-errors', StateValue: 'OK' }]);

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runStatus({ projectName: 'myapp', region: 'us-east-2', ecsClient, cloudWatchClient });
            expect(result.healthy).toBe(true);
            expect(result.service.runningCount).toBe(2);
            expect(result.service.desiredCount).toBe(2);
            expect(runDiagnose).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
            const text = output.join('\n');
            expect(text).toContain('myapp-service');
            expect(text).toContain('2/2');
            expect(text).toContain('[OK]');
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('runs automated diagnostics and exits 1 on a crash loop', async () => {
        const ecsClient = mockEcsClient({ ...healthyService, runningCount: 1, pendingCount: 1 });
        const cloudWatchClient = mockCloudWatchClient([]);

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runStatus({ projectName: 'myapp', region: 'us-east-2', ecsClient, cloudWatchClient });
            expect(result.healthy).toBe(false);
            expect(output.join('\n')).toContain(DEGRADED_MESSAGE);
            expect(runDiagnose).toHaveBeenCalledWith(
                expect.objectContaining({ cluster: 'myapp-cluster', region: 'us-east-2', logGroup: '/ecs/myapp' })
            );
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('hands off to diagnose when a 5XX alarm fires', async () => {
        const ecsClient = mockEcsClient(healthyService);
        const cloudWatchClient = mockCloudWatchClient([
            { AlarmName: 'myapp-high-5xx-errors', StateValue: 'ALARM' },
        ]);

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runStatus({ projectName: 'myapp', region: 'us-east-2', ecsClient, cloudWatchClient });
            expect(result.healthy).toBe(false);
            expect(runDiagnose).toHaveBeenCalledTimes(1);
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('--json prints the raw payload and disables auto-diagnose', async () => {
        const ecsClient = mockEcsClient({ ...healthyService, runningCount: 0 });
        const cloudWatchClient = mockCloudWatchClient([]);

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runStatus({ projectName: 'myapp', region: 'us-east-2', json: true, ecsClient, cloudWatchClient });
            expect(runDiagnose).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
            const payload = JSON.parse(output.join('\n'));
            expect(payload.healthy).toBe(false);
            expect(payload.service.runningCount).toBe(0);
            expect(result.healthy).toBe(false);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('prints SSO recovery guidance and exits 1 on expired sessions', async () => {
        const error = new Error('Invalid token');
        error.name = 'UnrecognizedClientException';
        const ecsClient = { send: vi.fn().mockRejectedValue(error) };
        const cloudWatchClient = mockCloudWatchClient([]);

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            await runStatus({ projectName: 'myapp', region: 'us-east-2', ecsClient, cloudWatchClient });
            expect(output.join('\n')).toContain('aws sso login');
            expect(runDiagnose).not.toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('is wired into bin/cli.js with diagnose hidden from help', () => {
        const cliPath = path.resolve(__dirname, '../bin/cli.js');
        const content = fs.readFileSync(cliPath, 'utf8');
        expect(content).toContain('runStatus');
        expect(content).toContain("'status'");

        const helpBlock = content.match(/HELP_TEXT = \[([\s\S]*?)\];/);
        expect(helpBlock).not.toBeNull();
        expect(helpBlock[1]).toContain('status');
        expect(helpBlock[1]).not.toContain('diagnose');
        expect(helpBlock[1]).not.toContain('wtf');
    });

    it('exits 0 and prints guidance when the service does not exist', async () => {
        const ecsClient = { send: vi.fn().mockResolvedValue({ services: [] }) };
        const cloudWatchClient = mockCloudWatchClient([]);

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            await runStatus({ projectName: 'myapp', region: 'us-east-2', ecsClient, cloudWatchClient });

            const text = output.join('\n');
            expect(text).toContain('does not exist or is inactive');
            expect(text).toContain('npx deploy-stack apply');

            expect(runDiagnose).not.toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(0);
        } finally {
            consoleSpy.mockRestore();
        }
    });
});
