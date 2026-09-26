import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runDoctor, installHint, DOCTOR_CHECKS } from '../src/commands/doctor.js';
import { checkDependency } from '../src/utils/system.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';

vi.mock('../src/utils/system.js', () => ({
    checkDependency: vi.fn(),
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

const realPlatform = process.platform;

function setPlatform(platform) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function mockBinaries({ terraform = true, aws = true, docker = true, git = true } = {}) {
    const availability = { terraform, aws, docker, git };
    vi.mocked(checkDependency).mockImplementation(async (binary) => availability[binary] ?? false);
}

function captureLog() {
    const output = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        output.push(args.join(' '));
    });
    return { output, restore: () => spy.mockRestore() };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockBinaries();
});

afterEach(() => {
    setPlatform(realPlatform);
});

describe('installHint', () => {
    it('returns Homebrew hints by default', () => {
        expect(installHint('terraform')).toContain('brew install terraform');
    });

    it('returns platform-aware Linux hints without Homebrew', () => {
        setPlatform('linux');
        expect(installHint('terraform')).not.toContain('brew');
        expect(installHint('terraform')).toContain('hashicorp.com');
        expect(installHint('aws_cli')).toContain('docs.aws.amazon.com');
        expect(installHint('docker')).toContain('docs.docker.com');
        expect(installHint('git')).toContain('apt-get');
        expect(installHint('git')).toContain('dnf');
    });

    it('returns winget hints on native Windows', () => {
        setPlatform('win32');
        expect(installHint('terraform')).toBe('Install via winget: winget install Hashicorp.Terraform');
        expect(installHint('aws_cli')).toBe('Install via winget: winget install Amazon.AWSCLI');
        expect(installHint('docker')).toBe('Install via winget: winget install Docker.DockerDesktop');
        expect(installHint('git')).toBe('Install via winget: winget install Git.Git');
    });

    it('returns empty string for unknown check IDs', () => {
        expect(installHint('nope')).toBe('');
    });
});

describe('runDoctor', () => {
    it('reports all passing checks with empty failed arrays', async () => {
        const { output, restore } = captureLog();
        try {
            await runDoctor();
            expect(trackEvent).toHaveBeenCalledWith(
                'doctor_run',
                expect.objectContaining({
                    success: true,
                    passed_checks: ['terraform', 'aws_cli', 'docker', 'git'],
                    failed_checks: [],
                    total_failed: 0,
                })
            );
            expect(flushTelemetry).toHaveBeenCalled();
            expect(output.join('\n')).not.toContain('Try:');
        } finally {
            restore();
        }
    });

    it('reports failed checks by stable ID with no sensitive data', async () => {
        mockBinaries({ terraform: false, aws: true, docker: false, git: true });
        const { output, restore } = captureLog();
        try {
            await runDoctor();
            expect(trackEvent).toHaveBeenCalledWith(
                'doctor_run',
                expect.objectContaining({
                    success: false,
                    passed_checks: ['aws_cli', 'git'],
                    failed_checks: ['terraform', 'docker'],
                    total_failed: 2,
                })
            );
            const [event, props] = vi.mocked(trackEvent).mock.calls[0];
            expect(event).toBe('doctor_run');
            expect(JSON.stringify(props)).not.toMatch(/[0-9]{12}|arn:aws|\/home\/|\/Users\/|Error/);
            expect(output.join('\n')).toContain('Try:');
        } finally {
            restore();
        }
    });

    it('prints Linux install hints on Linux and brew hints elsewhere', async () => {
        mockBinaries({ terraform: false, aws: true, docker: true, git: true });

        setPlatform('linux');
        const linuxRun = captureLog();
        try {
            await runDoctor();
            expect(linuxRun.output.join('\n')).toContain('hashicorp.com');
            expect(linuxRun.output.join('\n')).not.toContain('brew install terraform');
        } finally {
            linuxRun.restore();
        }

        vi.clearAllMocks();
        mockBinaries({ terraform: false, aws: true, docker: true, git: true });
        setPlatform('darwin');
        const macRun = captureLog();
        try {
            await runDoctor();
            expect(macRun.output.join('\n')).toContain('brew install terraform');
        } finally {
            macRun.restore();
        }
    });

    it('exposes exactly the four binary checks', () => {
        expect(DOCTOR_CHECKS.map((check) => check.id)).toEqual(['terraform', 'aws_cli', 'docker', 'git']);
    });
});
