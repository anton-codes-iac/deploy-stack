import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { parseCliArgs } from '../src/core/parser.js';
import { getProjectConfig, getTargetDirectory } from '../src/utils/prompts.js';
import { mainStack } from '../src/commands/init.js';

// Deep-mock the interactive prompt library. The CLI only uses
// `@clack/prompts` for interactive mode (verified: no `inquirer` or
// `commander` prompt calls exist under src/ or bin/), so mocking every
// `@clack/prompts` export is the correct automation guard. `inquirer` is
// not a dependency, so there is nothing to mock there.
const clack = vi.hoisted(() => ({
    mockText: vi.fn(),
    mockSelect: vi.fn(),
    mockMultiselect: vi.fn(),
    mockConfirm: vi.fn(),
    mockGroup: vi.fn(),
    mockCancel: vi.fn(),
    mockIsCancel: vi.fn(() => false),
    mockIntro: vi.fn(),
    mockOutro: vi.fn(),
    mockNote: vi.fn(),
    mockLogSuccess: vi.fn(),
    mockLogWarn: vi.fn(),
    mockLogError: vi.fn(),
    mockLogInfo: vi.fn(),
    mockSpinnerStart: vi.fn(),
    mockSpinnerStop: vi.fn(),
    mockSpinnerMessage: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
    text: clack.mockText,
    select: clack.mockSelect,
    multiselect: clack.mockMultiselect,
    confirm: clack.mockConfirm,
    group: clack.mockGroup,
    cancel: clack.mockCancel,
    isCancel: clack.mockIsCancel,
    intro: clack.mockIntro,
    outro: clack.mockOutro,
    note: clack.mockNote,
    log: {
        success: clack.mockLogSuccess,
        warn: clack.mockLogWarn,
        error: clack.mockLogError,
        info: clack.mockLogInfo,
        message: clack.mockLogInfo,
    },
    spinner: vi.fn(() => ({
        start: clack.mockSpinnerStart,
        stop: clack.mockSpinnerStop,
        message: clack.mockSpinnerMessage,
    })),
}));

// Never touch the real environment: fake terraform presence and AWS.
vi.mock('../src/utils/system.js', () => ({
    checkDependency: vi.fn(async () => true),
}));

vi.mock('../src/utils/aws.js', () => ({
    checkAwsCredentials: vi.fn(async (region) => ({
        accountId: '123456789012',
        awsAccountId: '123456789012',
        region: region || 'us-east-1',
    })),
    provisionStateBucket: vi.fn(async () => ({
        awsAccountId: '123456789012',
        stateBucketName: 'mock-tf-state-bucket',
    })),
    teardownStateBucket: vi.fn(async () => true),
}));

// Silence telemetry so tests never hit the network.
vi.mock('../src/core/telemetry.js', () => ({
    trackEvent: vi.fn(),
    flushTelemetry: vi.fn(async () => {}),
}));

function expectNoInteractivePrompts() {
    expect(clack.mockText).not.toHaveBeenCalled();
    expect(clack.mockSelect).not.toHaveBeenCalled();
    expect(clack.mockMultiselect).not.toHaveBeenCalled();
    expect(clack.mockConfirm).not.toHaveBeenCalled();
    expect(clack.mockGroup).not.toHaveBeenCalled();
}

describe('Headless contract (automation-safe)', () => {
    const originalCwd = process.cwd();
    const originalArgv = [...process.argv];
    const originalDoNotTrack = process.env.DO_NOT_TRACK;
    let tmpDir;

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env.DO_NOT_TRACK = '1';
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-stack-headless-'));
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        process.argv = [...originalArgv];
        if (originalDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
        else process.env.DO_NOT_TRACK = originalDoNotTrack;
        if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('parses --headless with flag values for automation wrappers', () => {
        const result = parseCliArgs([
            '--headless',
            '--framework=nestjs',
            '--port=3000',
            '--region=eu-west-1',
        ]);

        expect(result.isHeadless).toBe(true);
        expect(result.headlessOptions.framework).toBe('nestjs');
        expect(result.headlessOptions.port).toBe('3000');
        expect(result.headlessOptions.region).toBe('eu-west-1');
    });

    it('resolves the target directory without prompting in headless mode', async () => {
        const config = await getTargetDirectory(true, { dir: '.' });

        expect(config.targetDir).toBe(process.cwd());
        expectNoInteractivePrompts();
    });

    it('applies flag values instead of interactive defaults in headless mode', async () => {
        const config = await getProjectConfig(
            true,
            { framework: 'nestjs', port: '3000', region: 'eu-west-1' },
            tmpDir,
            null,
        );

        expect(config.framework).toBe('nestjs');
        expect(config.port).toBe('3000');
        expect(config.region).toBe('eu-west-1');
        expect(config.setupType).toBe('headless');
        expectNoInteractivePrompts();
    });

    it('runs mainStack --headless --preconfigured end to end without hanging on prompts', async () => {
        // Simulate: npx deploy-stack --headless --preconfigured
        //   --framework=nestjs --port=3000 --region=eu-west-1
        // Run inside the temp dir so no Terraform files pollute the repo.
        process.chdir(tmpDir);
        process.argv = [
            process.argv[0],
            'deploy-stack',
            '--headless',
            '--preconfigured',
            '--framework=nestjs',
            '--port=3000',
            '--region=eu-west-1',
        ];

        const parsed = parseCliArgs(process.argv.slice(2));
        expect(parsed.isHeadless).toBe(true);

        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            await mainStack({
                isHeadless: parsed.isHeadless,
                headlessOptions: { ...parsed.headlessOptions, dir: '.' },
            });

            // Automation guarantee: no interactive prompt ever fired.
            expectNoInteractivePrompts();
            expect(exitSpy).not.toHaveBeenCalled();

            // Flag values win over interactive defaults in generated output.
            const mainTf = await fs.readFile(path.join(tmpDir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).toContain('containerPort = 3000');
            expect(mainTf).toContain('region = "eu-west-1"');

            const dockerfile = await fs.readFile(path.join(tmpDir, 'Dockerfile'), 'utf-8');
            expect(dockerfile).toContain('EXPOSE 3000');
        } finally {
            exitSpy.mockRestore();
            logSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });
});
