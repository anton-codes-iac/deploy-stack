import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDiagnose } from '../src/commands/diagnose.js';

// Mock the AWS SDK clients (no real credentials needed)
const {
    mockEcsSend,
    mockLogsSend,
    MockECSClient,
    MockListTasksCommand,
    MockDescribeTasksCommand,
    MockLogsClient,
    MockFilterLogEventsCommand
} = vi.hoisted(() => {
    const ecsSend = vi.fn();
    const logsSend = vi.fn();
    return {
        mockEcsSend: ecsSend,
        mockLogsSend: logsSend,
        MockECSClient: vi.fn(function () {
            this.send = ecsSend;
        }),
        MockListTasksCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
        MockDescribeTasksCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
        MockLogsClient: vi.fn(function () {
            this.send = logsSend;
        }),
        MockFilterLogEventsCommand: vi.fn(function (input) {
            Object.assign(this, input);
        })
    };
});

vi.mock('@aws-sdk/client-ecs', () => {
    return {
        ECSClient: MockECSClient,
        DescribeTasksCommand: MockDescribeTasksCommand,
        ListTasksCommand: MockListTasksCommand
    };
});

vi.mock('@aws-sdk/client-cloudwatch-logs', () => {
    return {
        CloudWatchLogsClient: MockLogsClient,
        FilterLogEventsCommand: MockFilterLogEventsCommand
    };
});

// Silence interactive prompts and telemetry during tests
vi.mock('@clack/prompts', () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })
}));

vi.mock('../src/core/telemetry.js', () => ({
    trackEvent: vi.fn(),
    flushTelemetry: vi.fn().mockResolvedValue()
}));

describe('Command: diagnose', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEcsSend.mockReset();
        mockLogsSend.mockReset();
    });

    it('should extract and format the stoppedReason from a failed ECS task', async () => {
        const stoppedReason = 'OutOfMemoryError: Container killed due to memory usage';

        // 1. ListTasks -> one stopped task; DescribeTasks -> failed task detail
        mockEcsSend
            .mockResolvedValueOnce({
                taskArns: ['arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc123']
            })
            .mockResolvedValueOnce({
                tasks: [
                    {
                        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/abc123',
                        stoppedReason,
                        stoppedAt: new Date().toISOString(),
                        containers: [
                            { name: 'app', exitCode: 137, reason: 'Essential container in task exited' }
                        ]
                    }
                ]
            });

        // 2. CloudWatch -> 55 events, only the last 50 should be used
        const events = Array.from({ length: 55 }, (_, i) => ({
            message: i === 54 ? `FATAL ${stoppedReason}` : `log line ${i + 1}`
        }));
        mockLogsSend.mockResolvedValueOnce({ events });

        // 3. Capture formatted console output
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runDiagnose({
                cluster: 'test-cluster',
                region: 'us-east-2',
                logGroup: '/ecs/test'
            });

            // Return value carries the extracted reason
            expect(result.stoppedReason).toBe(stoppedReason);
            // Last-50-lines limit honored
            expect(result.logs).toHaveLength(50);
            // Formatted output highlights the exact error
            expect(output.join('\n')).toContain(stoppedReason);
            // Log fetch asked CloudWatch for the last 50 lines
            expect(MockFilterLogEventsCommand).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 50 })
            );
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('should report healthy when there are no stopped tasks', async () => {
        mockEcsSend.mockResolvedValueOnce({ taskArns: [] });

        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });

        try {
            const result = await runDiagnose({ cluster: 'test-cluster', region: 'us-east-2' });
            expect(result.healthy).toBe(true);
            expect(mockLogsSend).not.toHaveBeenCalled();
            expect(output.join('\n')).toMatch(/healthy|No stopped tasks/i);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('should exit gracefully on UnrecognizedClientException instead of throwing', async () => {
        const error = new Error('Invalid token');
        error.name = 'UnrecognizedClientException';
        mockEcsSend.mockRejectedValueOnce(error);

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        try {
            await runDiagnose({ cluster: 'test-cluster', region: 'us-east-1', spawnSyncImpl: () => ({ status: 0 }) });
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('AWS Session Expired'));
            expect(exitSpy).toHaveBeenCalledWith(1);
        } finally {
            exitSpy.mockRestore();
            consoleSpy.mockRestore();
        }
    });
});
