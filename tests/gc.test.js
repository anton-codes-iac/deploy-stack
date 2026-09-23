import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    runGc,
    parseGcArgs,
    filterUntaggedImages,
    filterUnattachedAddresses,
    discoverOrphanedResources,
    deleteDiscoveredResources,
    chunkArray,
    ECR_BATCH_DELETE_LIMIT,
    CONFIRM_MESSAGE,
} from '../src/commands/gc.js';

// --- Mock AWS SDK: ECR ---
const { mockEcrSend, MockECRClient, MockDescribeRepositoriesCommand, MockDescribeImagesCommand, MockBatchDeleteImageCommand } = vi.hoisted(() => {
    const send = vi.fn();
    const makeCommand = (name) =>
        vi.fn(function (input) {
            this.commandName = name;
            Object.assign(this, input);
        });
    return {
        mockEcrSend: send,
        MockECRClient: vi.fn(function () {
            this.send = send;
        }),
        MockDescribeRepositoriesCommand: makeCommand('DescribeRepositoriesCommand'),
        MockDescribeImagesCommand: makeCommand('DescribeImagesCommand'),
        MockBatchDeleteImageCommand: makeCommand('BatchDeleteImageCommand'),
    };
});

vi.mock('@aws-sdk/client-ecr', () => ({
    ECRClient: MockECRClient,
    DescribeRepositoriesCommand: MockDescribeRepositoriesCommand,
    DescribeImagesCommand: MockDescribeImagesCommand,
    BatchDeleteImageCommand: MockBatchDeleteImageCommand,
}));

// --- Mock AWS SDK: CloudWatch Logs ---
const { mockLogsSend, MockLogsClient, MockDescribeLogGroupsCommand, MockDeleteLogGroupCommand } = vi.hoisted(() => {
    const send = vi.fn();
    const makeCommand = (name) =>
        vi.fn(function (input) {
            this.commandName = name;
            Object.assign(this, input);
        });
    return {
        mockLogsSend: send,
        MockLogsClient: vi.fn(function () {
            this.send = send;
        }),
        MockDescribeLogGroupsCommand: makeCommand('DescribeLogGroupsCommand'),
        MockDeleteLogGroupCommand: makeCommand('DeleteLogGroupCommand'),
    };
});

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
    CloudWatchLogsClient: MockLogsClient,
    DescribeLogGroupsCommand: MockDescribeLogGroupsCommand,
    DeleteLogGroupCommand: MockDeleteLogGroupCommand,
}));

// --- Mock AWS SDK: EC2 ---
const { mockEc2Send, MockEC2Client, MockDescribeAddressesCommand, MockReleaseAddressCommand } = vi.hoisted(() => {
    const send = vi.fn();
    const makeCommand = (name) =>
        vi.fn(function (input) {
            this.commandName = name;
            Object.assign(this, input);
        });
    return {
        mockEc2Send: send,
        MockEC2Client: vi.fn(function () {
            this.send = send;
        }),
        MockDescribeAddressesCommand: makeCommand('DescribeAddressesCommand'),
        MockReleaseAddressCommand: makeCommand('ReleaseAddressCommand'),
    };
});

vi.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: MockEC2Client,
    DescribeAddressesCommand: MockDescribeAddressesCommand,
    ReleaseAddressCommand: MockReleaseAddressCommand,
}));

// --- Mock interactive prompts (controllable confirm) ---
const clack = vi.hoisted(() => ({
    mockIntro: vi.fn(),
    mockOutro: vi.fn(),
    mockConfirm: vi.fn(),
    mockCancel: vi.fn(),
    mockSpinnerStart: vi.fn(),
    mockSpinnerStop: vi.fn(),
    mockSpinnerMessage: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
    intro: clack.mockIntro,
    outro: clack.mockOutro,
    confirm: clack.mockConfirm,
    cancel: clack.mockCancel,
    spinner: vi.fn(() => ({
        start: clack.mockSpinnerStart,
        stop: clack.mockSpinnerStop,
        message: clack.mockSpinnerMessage,
    })),
}));

vi.mock('../src/core/telemetry.js', () => ({
    trackEvent: vi.fn(),
    flushTelemetry: vi.fn(() => Promise.resolve()),
}));

const PROJECT = 'myapp';

function setupMixedDiscoveryFixtures() {
    mockEcrSend.mockImplementation(async (cmd) => {
        if (cmd instanceof MockDescribeRepositoriesCommand) {
            return {
                repositories: [
                    { repositoryName: `${PROJECT}-web` },
                    { repositoryName: `${PROJECT}-worker` },
                    { repositoryName: 'unrelated-repo' },
                ],
            };
        }
        if (cmd instanceof MockDescribeImagesCommand) {
            if (cmd.repositoryName === `${PROJECT}-web`) {
                return {
                    imageDetails: [
                        { imageDigest: 'sha256:tagged', imageTags: ['latest'] },
                        { imageDigest: 'sha256:orphan1' },
                        { imageDigest: 'sha256:orphan2', imageTags: [] },
                    ],
                };
            }
            return { imageDetails: [{ imageDigest: 'sha256:worker-tagged', imageTags: ['v1'] }] };
        }
        if (cmd instanceof MockBatchDeleteImageCommand) return { imageIds: cmd.imageIds };
        throw new Error(`Unexpected ECR command: ${cmd?.commandName}`);
    });

    mockLogsSend.mockImplementation(async (cmd) => {
        if (cmd instanceof MockDescribeLogGroupsCommand) {
            expect(cmd.logGroupNamePrefix).toBe(`/ecs/${PROJECT}-`);
            return {
                logGroups: [
                    { logGroupName: `/ecs/${PROJECT}-pr-123` },
                    { logGroupName: `/ecs/${PROJECT}-pr-456` },
                ],
            };
        }
        if (cmd instanceof MockDeleteLogGroupCommand) return {};
        throw new Error(`Unexpected Logs command: ${cmd?.commandName}`);
    });

    mockEc2Send.mockImplementation(async (cmd) => {
        if (cmd instanceof MockDescribeAddressesCommand) {
            return {
                Addresses: [
                    { PublicIp: '1.2.3.4', AllocationId: 'eipalloc-attached', AssociationId: 'eipassoc-1', InstanceId: 'i-123' },
                    { PublicIp: '5.6.7.8', AllocationId: 'eipalloc-orphan' },
                ],
            };
        }
        if (cmd instanceof MockReleaseAddressCommand) return {};
        throw new Error(`Unexpected EC2 command: ${cmd?.commandName}`);
    });
}

function deleteCommandCalls() {
    const batchDeletes = MockBatchDeleteImageCommand.mock.calls.length;
    const logDeletes = MockDeleteLogGroupCommand.mock.calls.length;
    const releases = MockReleaseAddressCommand.mock.calls.length;
    return batchDeletes + logDeletes + releases;
}

beforeEach(() => {
    vi.clearAllMocks();
    setupMixedDiscoveryFixtures();
    delete process.env.AWS_REGION;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('gc: CLI args', () => {
    it('parses --region and --project-name', () => {
        expect(parseGcArgs(['gc', '--region', 'eu-west-1'])).toEqual({ region: 'eu-west-1' });
        expect(parseGcArgs(['gc', '--region=us-west-2'])).toEqual({ region: 'us-west-2' });
        expect(parseGcArgs(['gc'])).toEqual({});
    });

    it('offers no --yes bypass flag', () => {
        expect(parseGcArgs(['gc', '--yes'])).toEqual({});
        expect(parseGcArgs(['gc', '--yes', '--region', 'us-east-1'])).toEqual({ region: 'us-east-1' });
    });

    it('uses the spec confirmation wording', () => {
        expect(CONFIRM_MESSAGE).toContain('Are you sure you want to permanently delete these orphaned resources? (y/N)');
    });
});

describe('gc: orphan filters', () => {
    it('counts only untagged ECR images', () => {
        const images = [
            { imageDigest: 'sha256:a', imageTags: ['latest'] },
            { imageDigest: 'sha256:b' },
            { imageDigest: 'sha256:c', imageTags: [] },
        ];
        expect(filterUntaggedImages(images).map((i) => i.imageDigest)).toEqual(['sha256:b', 'sha256:c']);
    });

    it('counts only unattached Elastic IPs', () => {
        const addresses = [
            { PublicIp: '1.2.3.4', AssociationId: 'eipassoc-1' },
            { PublicIp: '5.6.7.8', AllocationId: 'eipalloc-2' },
        ];
        expect(filterUnattachedAddresses(addresses)).toHaveLength(1);
        expect(filterUnattachedAddresses(addresses)[0].PublicIp).toBe('5.6.7.8');
    });
});

describe('gc: dry-run discovery', () => {
    it('counts only orphaned resources across all three targets', async () => {
        clack.mockConfirm.mockResolvedValue(false);
        const output = [];
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2' });
            expect(result.untaggedImages).toHaveLength(2);
            expect(result.orphanedLogGroups).toHaveLength(2);
            expect(result.unattachedEips).toHaveLength(1);
            expect(result.totalCount).toBe(5);
            expect(result.deleted).toBe(false);
            const text = output.join('\n');
            expect(text).toContain('Untagged ECR images: 2');
            expect(text).toContain('Orphaned log groups: 2');
            expect(text).toContain('Unattached Elastic IPs: 1');
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('ignores repos outside the project prefix', async () => {
        const ecrClient = { send: mockEcrSend };
        const logsClient = { send: mockLogsSend };
        const ec2Client = { send: mockEc2Send };
        const result = await discoverOrphanedResources({ ecrClient, logsClient, ec2Client, projectName: PROJECT });
        expect(result.untaggedImages.every((i) => i.repositoryName.startsWith(`${PROJECT}-`))).toBe(true);
        expect(result.untaggedImages).toHaveLength(2);
    });

    it('follows nextToken through paginated ECR responses', async () => {
        const ecrSend = vi.fn(async (cmd) => {
            if (cmd instanceof MockDescribeRepositoriesCommand) {
                if (cmd.nextToken === undefined) {
                    return { repositories: [{ repositoryName: `${PROJECT}-web` }], nextToken: 'repos-page-2' };
                }
                return { repositories: [{ repositoryName: `${PROJECT}-worker` }] };
            }
            if (cmd instanceof MockDescribeImagesCommand) {
                if (cmd.nextToken === undefined) {
                    return { imageDetails: [{ imageDigest: 'sha256:page1-orphan' }], nextToken: 'images-page-2' };
                }
                return { imageDetails: [{ imageDigest: 'sha256:page2-orphan' }] };
            }
            throw new Error('unexpected');
        });
        const result = await discoverOrphanedResources({
            ecrClient: { send: ecrSend },
            logsClient: { send: mockLogsSend },
            ec2Client: { send: mockEc2Send },
            projectName: PROJECT,
        });
        expect(result.untaggedImages).toHaveLength(4);
        const repoCalls = ecrSend.mock.calls.filter((call) => call[0] instanceof MockDescribeRepositoriesCommand);
        expect(repoCalls).toHaveLength(2);
        const imageCalls = ecrSend.mock.calls.filter((call) => call[0] instanceof MockDescribeImagesCommand);
        expect(imageCalls).toHaveLength(4);
    });
});

describe('gc: safety guards', () => {
    it('never fires Delete commands when confirmation is rejected', async () => {
        clack.mockConfirm.mockResolvedValue(false);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2' });
            expect(clack.mockConfirm).toHaveBeenCalledTimes(1);
            expect(result.deleted).toBe(false);
            expect(deleteCommandCalls()).toBe(0);
            expect(clack.mockCancel).toHaveBeenCalled();
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('treats a cancelled prompt as rejection', async () => {
        clack.mockConfirm.mockResolvedValue(Symbol.for('clack:cancel'));
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2' });
            expect(result.deleted).toBe(false);
            expect(deleteCommandCalls()).toBe(0);
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('deletes all discovered resources only after explicit confirmation', async () => {
        clack.mockConfirm.mockResolvedValue(true);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2' });
            expect(result.deleted).toBe(true);
            expect(result.deletedImages).toBe(2);
            expect(result.deletedLogGroups).toBe(2);
            expect(result.releasedEips).toBe(1);
            expect(MockBatchDeleteImageCommand).toHaveBeenCalledWith(
                expect.objectContaining({ repositoryName: `${PROJECT}-web` })
            );
            expect(MockDeleteLogGroupCommand).toHaveBeenCalledWith(
                expect.objectContaining({ logGroupName: `/ecs/${PROJECT}-pr-123` })
            );
            expect(MockReleaseAddressCommand).toHaveBeenCalledWith(
                expect.objectContaining({ AllocationId: 'eipalloc-orphan' })
            );
            // The attached EIP must never be released.
            const releasedIds = MockReleaseAddressCommand.mock.calls.map((c) => c[0].AllocationId);
            expect(releasedIds).not.toContain('eipalloc-attached');
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('reports cleanly when nothing is orphaned without prompting', async () => {
        mockEcrSend.mockImplementation(async (cmd) => {
            if (cmd instanceof MockDescribeRepositoriesCommand) return { repositories: [] };
            throw new Error('unexpected');
        });
        mockLogsSend.mockImplementation(async (cmd) => {
            if (cmd instanceof MockDescribeLogGroupsCommand) return { logGroups: [] };
            throw new Error('unexpected');
        });
        mockEc2Send.mockImplementation(async (cmd) => {
            if (cmd instanceof MockDescribeAddressesCommand) return { Addresses: [] };
            throw new Error('unexpected');
        });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        try {
            const result = await runGc({ projectName: PROJECT, region: 'us-east-2' });
            expect(result.totalCount).toBe(0);
            expect(result.deleted).toBe(false);
            expect(clack.mockConfirm).not.toHaveBeenCalled();
            expect(deleteCommandCalls()).toBe(0);
        } finally {
            consoleSpy.mockRestore();
        }
    });
});

describe('gc: ECR batch-delete chunking', () => {
    it('exposes the 100-image AWS limit', () => {
        expect(ECR_BATCH_DELETE_LIMIT).toBe(100);
    });

    it('chunks arrays into batches of at most 100', () => {
        expect(chunkArray([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
        expect(chunkArray([], 100)).toEqual([]);
    });

    it('splits more than 100 untagged images into multiple BatchDelete requests', async () => {
        const untaggedImages = Array.from({ length: 250 }, (_, i) => ({
            repositoryName: `${PROJECT}-web`,
            imageDigest: `sha256:orphan-${i}`,
        }));
        const ecrSend = vi.fn().mockResolvedValue({});
        const logsSend = vi.fn().mockResolvedValue({});
        const ec2Send = vi.fn().mockResolvedValue({});

        const summary = await deleteDiscoveredResources(
            { ecrClient: { send: ecrSend }, logsClient: { send: logsSend }, ec2Client: { send: ec2Send } },
            { untaggedImages, orphanedLogGroups: [], unattachedEips: [] }
        );

        expect(summary.deletedImages).toBe(250);
        expect(ecrSend).toHaveBeenCalledTimes(3);
        const batchSizes = ecrSend.mock.calls.map((call) => call[0].imageIds.length);
        expect(batchSizes).toEqual([100, 100, 50]);
        for (const call of ecrSend.mock.calls) {
            expect(call[0].imageIds.length).toBeLessThanOrEqual(100);
            expect(call[0].repositoryName).toBe(`${PROJECT}-web`);
        }
        const sentDigests = ecrSend.mock.calls.flatMap((call) => call[0].imageIds.map((id) => id.imageDigest));
        expect(sentDigests).toHaveLength(250);
        expect(new Set(sentDigests).size).toBe(250);
    });

    it('sends exactly one request for 100 images', async () => {
        const untaggedImages = Array.from({ length: 100 }, (_, i) => ({
            repositoryName: `${PROJECT}-web`,
            imageDigest: `sha256:orphan-${i}`,
        }));
        const ecrSend = vi.fn().mockResolvedValue({});

        const summary = await deleteDiscoveredResources(
            { ecrClient: { send: ecrSend }, logsClient: { send: vi.fn() }, ec2Client: { send: vi.fn() } },
            { untaggedImages, orphanedLogGroups: [], unattachedEips: [] }
        );

        expect(summary.deletedImages).toBe(100);
        expect(ecrSend).toHaveBeenCalledTimes(1);
        expect(ecrSend.mock.calls[0][0].imageIds).toHaveLength(100);
    });
});
