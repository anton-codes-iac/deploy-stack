import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    parseTerraformConfig,
    estimateMonthlyCost,
    renderDryRunPreview,
    syncDocCostEstimate,
    buildCostTelemetryProps,
    COST_ESTIMATE_MARKER,
} from '../src/utils/visualizer.js';
import { ADDON_REGISTRY } from '../src/utils/addons.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';
import { confirm } from '@clack/prompts';

const { mockNote } = vi.hoisted(() => ({ mockNote: vi.fn() }));

vi.mock('@clack/prompts', () => ({
    note: mockNote,
    confirm: vi.fn(),
    isCancel: (value) => typeof value === 'symbol',
    cancel: vi.fn(),
}));

vi.mock('../src/core/telemetry.js', () => ({
    trackEvent: vi.fn(),
    flushTelemetry: vi.fn().mockResolvedValue(),
}));

let tmpDirs = [];

function makeTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visualizer-test-'));
    tmpDirs.push(dir);
    return dir;
}

function writeTf(dir, files = {}) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, 'terraform', name), content);
    }
}

const MAIN_TF_MICRO = [
    'resource "aws_ecs_task_definition" "app" {',
    '  cpu                      = "256"',
    '  memory                   = "512"',
    '}',
    '',
].join('\n');

const MAIN_TF_SMALL = [
    'resource "aws_ecs_task_definition" "app" {',
    '  cpu                      = "512"',
    '  memory                   = "1024"',
    '}',
    '',
].join('\n');

// picocolors wraps words in ANSI escapes; strip them before asserting text.
function stripAnsi(text) {
    return String(text).replace(/\[[0-9;]*m/g, '');
}

beforeEach(() => {
    tmpDirs = [];
    vi.clearAllMocks();
});

afterEach(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('parseTerraformConfig', () => {
    it('extracts rendered cpu and memory from main.tf', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_SMALL });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.cpu).toBe(512);
        expect(config.memory).toBe(1024);
    });

    it('lets terraform.tfvars override rendered values', () => {
        const dir = makeTmp();
        writeTf(dir, {
            'main.tf': MAIN_TF_SMALL,
            'terraform.tfvars': 'container_cpu = 1024\ncontainer_memory = 2048\n',
        });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.cpu).toBe(1024);
        expect(config.memory).toBe(2048);
    });

    it('falls back to micro defaults when neither source specifies sizes', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': 'provider "aws" {}\n' });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.cpu).toBe(256);
        expect(config.memory).toBe(512);
    });

    it('detects secrets.tf existence and registry addons', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_MICRO, 'secrets.tf': '# secrets\n', 's3.tf': '# s3\n', 'dynamodb.tf': '# dynamodb\n' });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.hasSecrets).toBe(true);
        expect(config.addons).toEqual(['storage:s3', 'db:dynamodb']);
    });

    it('reports hasSecrets false and empty addons when files are absent', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_MICRO });
        const config = parseTerraformConfig(path.join(dir, 'terraform'));
        expect(config.hasSecrets).toBe(false);
        expect(config.addons).toEqual([]);
    });
});

describe('estimateMonthlyCost', () => {
    it('adds $0.40 for the base app secret', () => {
        const cost = estimateMonthlyCost({ hasSecrets: true, hasDb: false });
        expect(cost.secretsMonthly).toBe('0.40');
    });

    it('adds $0.80 when the RDS master password secret also exists', () => {
        const cost = estimateMonthlyCost({ hasSecrets: true, hasDb: true });
        expect(cost.secretsMonthly).toBe('0.80');
    });

    it('charges $0.00 secrets with no secrets file and no database', () => {
        const cost = estimateMonthlyCost({ hasSecrets: false, hasDb: false });
        expect(cost.secretsMonthly).toBe('0.00');
    });

    it('keeps the object return shape with two-decimal strings', () => {
        const cost = estimateMonthlyCost({});
        for (const key of ['fargateMonthly', 'albMonthly', 'dbMonthly', 'secretsMonthly', 'totalMonthly']) {
            expect(cost[key]).toMatch(/^\d+\.\d{2}$/);
        }
    });

    it('ignores unknown addon keys instead of throwing', () => {
        expect(() => estimateMonthlyCost({ addons: ['unknown:foo'] })).not.toThrow();
    });
});

describe('renderDryRunPreview', () => {
    it('labels the fixed baseline with the us-east-2 caveat and secrets breakdown', async () => {
        await renderDryRunPreview({ hasSecrets: true, hasDb: true }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('Fixed Baseline:');
        expect(output).not.toContain('Est. Fixed Baseline:');
        expect(output).toContain('(Fargate: $');
        expect(output).toContain('[Secrets Manager (2 secrets)]');
        expect(output).toContain(', Secrets: $0.80');
        expect(output).toContain('(us-east-2 rates)');
        expect(output).not.toContain('Est. Monthly Cost:');
    });

    it('omits the Secrets Manager node when there are no secrets', async () => {
        await renderDryRunPreview({ hasSecrets: false, hasDb: false }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).not.toContain('Secrets Manager');
        expect(output).not.toContain('Secrets: $');
    });

    it('renders addon tree nodes with a compact counted usage line', async () => {
        await renderDryRunPreview({ hasSecrets: true, addons: ['storage:s3', 'db:dynamodb'] }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('[S3 + CloudFront OAC]');
        expect(output).toContain('[DynamoDB (On-Demand + PITR)]');
        expect(output).toContain('+ Usage-based (2 addons): $0/mo fixed');
        // Verbose per-addon summaries stay out of the box (no repeated lists).
        expect(output).not.toContain('Usage-Based Addons:');
        expect(output).not.toContain(ADDON_REGISTRY['storage:s3'].cost.summary);
        expect(output).not.toContain(ADDON_REGISTRY['db:dynamodb'].cost.summary);
    });

    it('uses the singular form for a single addon', async () => {
        await renderDryRunPreview({ addons: ['storage:s3'] }, true);
        const output = stripAnsi(mockNote.mock.calls[0][0]);
        expect(output).toContain('+ Usage-based (1 addon):');
    });

    it('fits the maximal box inside the IDE viewport budget', async () => {
        await renderDryRunPreview(
            { hasDb: true, hasWorker: true, hasSecrets: true, addons: ['storage:s3', 'db:dynamodb'] },
            true
        );
        const lines = stripAnsi(mockNote.mock.calls[0][0]).split('\n');
        expect(lines.length).toBeLessThanOrEqual(14);
        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(90);
        }
    });

    it('skips unknown addon keys instead of throwing', async () => {
        await expect(renderDryRunPreview({ addons: ['unknown:foo'] }, true)).resolves.toBe(true);
    });
});

describe('buildCostTelemetryProps', () => {
    it('returns the shared numeric cost/shape payload', () => {
        const props = buildCostTelemetryProps(
            { projectName: 'myapp', cpu: 512, memory: 1024, hasDb: true, hasWorker: true, addons: ['storage:s3'] },
            { totalMonthly: '58.07' }
        );
        expect(props).toEqual({
            projectName: 'myapp',
            estimated_monthly_usd: 58.07,
            cpu: 512,
            memory: 1024,
            has_db: true,
            has_worker: true,
            addons: ['storage:s3'],
            addon_count: 1,
        });
    });

    it('falls back to basename, micro defaults, and empty addons', () => {
        const props = buildCostTelemetryProps({}, { totalMonthly: '31.28' });
        expect(props.projectName).toBe(path.basename(process.cwd()));
        expect(props.cpu).toBe(256);
        expect(props.memory).toBe(512);
        expect(props.addons).toEqual([]);
        expect(props.addon_count).toBe(0);
    });
});

describe('preview cancel telemetry (real decline path)', () => {
    let exitSpy;

    beforeEach(() => {
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    });

    afterEach(() => {
        exitSpy.mockRestore();
    });

    it('emits cancelled_at_preview with cost props when confirm is declined', async () => {
        vi.mocked(confirm).mockResolvedValue(false);
        await renderDryRunPreview({ projectName: 'myapp', hasSecrets: true }, false);
        expect(trackEvent).toHaveBeenCalledWith(
            'infrastructure_applied',
            expect.objectContaining({
                success: false,
                status: 'cancelled_at_preview',
                projectName: 'myapp',
                estimated_monthly_usd: expect.any(Number),
            })
        );
        expect(flushTelemetry).toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('emits the same event when the prompt is cancelled via symbol', async () => {
        vi.mocked(confirm).mockResolvedValue(Symbol('clack:cancel'));
        await renderDryRunPreview({ projectName: 'myapp' }, false);
        expect(trackEvent).toHaveBeenCalledWith(
            'infrastructure_applied',
            expect.objectContaining({ success: false, status: 'cancelled_at_preview' })
        );
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});

describe('templates/README.md marker', () => {
    it('literally contains COST_ESTIMATE_MARKER so template and constant cannot drift', () => {
        const template = fs.readFileSync(
            path.join(process.cwd(), 'templates', 'README.md'),
            'utf-8'
        );
        expect(template).toContain(COST_ESTIMATE_MARKER);
    });
});

describe('syncDocCostEstimate', () => {
    it('preserves non-default CPU/memory from main.tf in the synced baseline', () => {
        const dir = makeTmp();
        writeTf(dir, { 'main.tf': MAIN_TF_SMALL, 'secrets.tf': '# secrets\n' });
        fs.writeFileSync(path.join(dir, 'README.md'), `# myapp\n\n* **${COST_ESTIMATE_MARKER}** ~$0.00/month\n`);
        const target = syncDocCostEstimate(dir);
        expect(target).toBe(path.join(dir, 'README.md'));
        const expected = estimateMonthlyCost(parseTerraformConfig(path.join(dir, 'terraform')));
        expect(fs.readFileSync(target, 'utf-8')).toContain(`~$${expected.totalMonthly}/month`);
    });
});
