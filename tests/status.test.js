import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runStatus, runLambdaStatus, parseStatusArgs, getServiceHealth, getLambdaHealth, DEGRADED_MESSAGE } from '../src/commands/status.js';
import { runDiagnose } from '../src/commands/diagnose.js';
import { trackEvent } from '../src/core/telemetry.js';

vi.mock('../src/commands/diagnose.js', () => ({
    runDiagnose: vi.fn().mockResolvedValue({ healthy: false }),
}));

vi.mock('@clack/prompts', () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

vi.mock('../src/core/telemetry.js', () => {
    const trackEvent = vi.fn();
    const flushTelemetry = vi.fn().mockResolvedValue();
    // Mirrors the real trackSuccess delegation so success-path assertions
    // keep observing trackEvent (the real helper is unit-tested separately).
    const trackSuccess = vi.fn(async (event, properties) => {
        trackEvent(event, { ...properties, success: true });
        await flushTelemetry();
    });
    const trackFailure = vi.fn(async (event, properties) => {
        trackEvent(event, { ...properties, success: false });
        await flushTelemetry();
    });
    return { trackEvent, flushTelemetry, trackSuccess, trackFailure };
});

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
            await runStatus({ projectName: 'myapp', region: 'us-east-2', ecsClient, cloudWatchClient, spawnSyncImpl: () => ({ status: 0 }) });
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
            expect(text).toContain('npx grada-run apply');

            expect(runDiagnose).not.toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(0);
        } finally {
            consoleSpy.mockRestore();
        }
    });
});

describe('status: fuzzer hardening', () => {
    let exitSpy;
    let consoleSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    it('routes unresolvable projects through PROJECT_NOT_INITIALIZED', async () => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('deleted'); });
        try {
            const result = await runStatus(null);
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(trackEvent).toHaveBeenCalledWith('status_run', expect.objectContaining({
                success: false,
                error_code: 'PROJECT_NOT_INITIALIZED',
            }));
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it.each([null, 42, true, { port: 'string' }])('parseStatusArgs(%s) returns defaults', (bad) => {
        expect(parseStatusArgs(bad)).toEqual({});
    });
});

describe('status: lambda target (mocked AWS CLI)', () => {
    let exitSpy;
    let consoleSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    const ACTIVE = JSON.stringify({
        Configuration: {
            State: 'Active',
            LastUpdateStatus: 'Successful',
            LastModified: '2026-01-01T00:00:00Z',
            MemorySize: 512,
            Timeout: 30,
            Code: { ImageUri: '123.dkr.ecr.us-east-2.amazonaws.com/myapp-repo:abc1234' },
        },
    });

    function cliWith(stdout, status = 0) {
        return vi.fn(() => ({ status, stdout, stderr: '' }));
    }

    it('judges health from function State and LastUpdateStatus', () => {
        expect(getLambdaHealth({ State: 'Active', LastUpdateStatus: 'Successful' }).healthy).toBe(true);
        expect(getLambdaHealth({ State: 'Active', LastUpdateStatus: 'Failed' }).healthy).toBe(false);
        expect(getLambdaHealth({ State: 'Pending', LastUpdateStatus: 'Successful' }).healthy).toBe(false);
        expect(getLambdaHealth({}).healthy).toBe(false);
    });

    it('reports a healthy function without touching ECS', async () => {
        const spawnSyncImpl = cliWith(ACTIVE);
        const result = await runLambdaStatus({ projectName: 'myapp', region: 'us-east-2', spawnSyncImpl });
        expect(result.healthy).toBe(true);
        expect(result.computeTarget).toBe('lambda');
        expect(result.function.name).toBe('myapp-fn');
        expect(spawnSyncImpl).toHaveBeenCalledWith(
            'aws',
            expect.arrayContaining(['lambda', 'get-function', '--function-name', 'myapp-fn']),
            expect.anything()
        );
        expect(trackEvent).toHaveBeenCalledWith('status_run', expect.objectContaining({ healthy: true, success: true }));
    });

    it('supports --json and explicit function names', async () => {
        const spawnSyncImpl = cliWith(ACTIVE);
        const result = await runLambdaStatus({ projectName: 'myapp', region: 'us-east-2', functionName: 'custom-fn', json: true, spawnSyncImpl });
        expect(result.function.name).toBe('custom-fn');
        expect(spawnSyncImpl.mock.calls[0][1]).toContain('custom-fn');
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"computeTarget": "lambda"'));
    });

    it('runs diagnostics and exits 1 when degraded', async () => {
        const failed = JSON.stringify({ Configuration: { State: 'Active', LastUpdateStatus: 'Failed' } });
        const result = await runLambdaStatus({ projectName: 'myapp', region: 'us-east-2', spawnSyncImpl: cliWith(failed) });
        expect(result.healthy).toBe(false);
        expect(runDiagnose).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('guides missing functions to apply and missing CLIs to install', async () => {
        const missing = vi.fn(() => ({ status: 254, stdout: '', stderr: 'ResourceNotFoundException' }));
        const result = await runLambdaStatus({ projectName: 'myapp', region: 'us-east-2', json: true, spawnSyncImpl: missing });
        expect(result).toMatchObject({ healthy: false, missing: true });

        const noCli = vi.fn(() => ({ error: { code: 'ENOENT' } }));
        await runLambdaStatus({ projectName: 'myapp', region: 'us-east-2', spawnSyncImpl: noCli });
        expect(trackEvent).toHaveBeenCalledWith('status_run', expect.objectContaining({ error_code: 'AWS_CLI_MISSING' }));
    });

    it('dispatches lambda projects from runStatus', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-lambda-test-'));
        try {
            fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'terraform', 'main.tf'),
                'locals {\n  app_name = "myapp${local.env_suffix}"\n}\nresource "aws_lambda_function" "app" {}\n'
            );
            const result = await runStatus({ cwd: dir, region: 'us-east-2', spawnSyncImpl: cliWith(ACTIVE) });
            expect(result.healthy).toBe(true);
            expect(result.computeTarget).toBe('lambda');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
