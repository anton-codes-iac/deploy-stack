import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

// --- Deep mock for child_process.spawn (no real terraform binary) ---
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execSync: vi.fn(),
}));

// --- Silence interactive UI ---
const clack = vi.hoisted(() => ({
  mockIntro: vi.fn(),
  mockOutro: vi.fn(),
  mockConfirm: vi.fn(),
  mockCancel: vi.fn(),
  mockIsCancel: vi.fn(() => false),
  mockSpinnerStart: vi.fn(),
  mockSpinnerStop: vi.fn(),
  mockSpinnerMessage: vi.fn(),
  mockLogSuccess: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockLogMessage: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  intro: clack.mockIntro,
  outro: clack.mockOutro,
  confirm: clack.mockConfirm,
  cancel: clack.mockCancel,
  isCancel: clack.mockIsCancel,
  spinner: vi.fn(() => ({
    start: clack.mockSpinnerStart,
    stop: clack.mockSpinnerStop,
    message: clack.mockSpinnerMessage,
  })),
  log: {
    success: clack.mockLogSuccess,
    warn: clack.mockLogWarn,
    error: clack.mockLogError,
    message: clack.mockLogMessage,
  },
}));

// --- Never hit network / AWS ---
vi.mock('../src/core/telemetry.js', () => ({
  trackEvent: vi.fn(),
  flushTelemetry: vi.fn().mockResolvedValue(),
}));

vi.mock('../src/utils/aws.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    provisionStateBucket: vi.fn().mockResolvedValue({
      awsAccountId: '123456789012',
      stateBucketName: 'mock-tf-state-bucket',
    }),
  };
});

// Keep the real parseTerraformConfig (pure file reads) but stub the
// interactive preview so tests stay headless.
vi.mock('../src/utils/visualizer.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renderDryRunPreview: vi.fn().mockResolvedValue(true),
  };
});

import { applyStack } from '../src/commands/apply.js';
import { renderDryRunPreview } from '../src/utils/visualizer.js';
import { provisionStateBucket } from '../src/utils/aws.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';

const COST_PROPS_SHAPE = {
  projectName: expect.any(String),
  estimated_monthly_usd: expect.any(Number),
  cpu: expect.any(Number),
  memory: expect.any(Number),
  has_db: expect.any(Boolean),
  has_worker: expect.any(Boolean),
  addons: expect.any(Array),
  addon_count: expect.any(Number),
};

// Build a fake terraform child process: stdout/stderr EventEmitters
// plus close/error on the child itself, matching apply.js usage.
function makeChild({ code = 0, stdout = '', stderr = '', error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

function exitError(code) {
  return Object.assign(new Error(`process.exit:${code}`), { exitCode: code });
}

describe('Command: apply (mocked terraform spawn)', () => {
  const originalCwd = process.cwd();
  let tmpDir;
  let exitSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    clack.mockConfirm.mockResolvedValue(true);
    clack.mockIsCancel.mockReturnValue(false);
    // process.exit throws so execution halts like the real runtime.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw exitError(code);
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-test-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeProject(files = {}) {
    fs.mkdirSync(path.join(tmpDir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'terraform', 'main.tf'), '# fake stack\n');
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    process.chdir(tmpDir);
  }

  it('exits 1 when no terraform directory exists', async () => {
    process.chdir(tmpDir); // empty tmpdir: no terraform/main.tf
    await expect(applyStack({})).rejects.toMatchObject({ exitCode: 1 });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('dry run renders preview and exits 0 without spawning terraform', async () => {
    writeProject();
    await expect(applyStack({ isDryRun: true })).rejects.toMatchObject({ exitCode: 0 });
    expect(renderDryRunPreview).toHaveBeenCalledWith(expect.anything(), true);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_dry_run',
      expect.objectContaining({ success: true, ...COST_PROPS_SHAPE })
    );
    expect(flushTelemetry).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('provisions successfully: init + apply exit 0 and prints CDN/ALB outputs', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      expect(cmd).toBe('terraform');
      if (args[0] === 'init') return makeChild({ code: 0, stdout: 'init ok' });
      if (args[0] === 'apply') return makeChild({ code: 0, stdout: 'apply complete' });
      if (args[0] === 'output')
        return makeChild({
          code: 0,
          stdout: JSON.stringify({
            cloudfront_url: { value: 'https://d123.cloudfront.net' },
            alb_direct_url: { value: 'http://alb-123.us-east-2.elb.amazonaws.com' },
          }),
        });
      return makeChild({ code: 0 });
    });

    const outroSpy = clack.mockOutro;
    // Success exit(0) lives INSIDE applyStack's try block, so a throwing
    // process.exit mock would be swallowed as a failure. Use a no-op here.
    exitSpy.mockImplementation(() => { });
    await applyStack({});

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(mockSpawn.mock.calls[0][1]).toEqual(['init', '-upgrade']);
    expect(mockSpawn.mock.calls[1][1]).toEqual(['apply', '-auto-approve']);
    expect(mockSpawn.mock.calls[2][1]).toEqual(['output', '-json']);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(outroSpy).toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: true, ...COST_PROPS_SHAPE })
    );
  });

  it('exits 1 and tracks failure when terraform apply exits non-zero', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0, stdout: 'init ok' });
      if (args[0] === 'apply')
        return makeChild({ code: 1, stderr: 'Error: generic apply boom' });
      return makeChild({ code: 0, stdout: '{}' });
    });

    await expect(applyStack({})).rejects.toMatchObject({ exitCode: 1 });
    expect(clack.mockLogError).toHaveBeenCalled();
    expect(provisionStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false, ...COST_PROPS_SHAPE })
    );
  });

  it('recovers from a missing state bucket: recreates bucket and resumes', async () => {
    writeProject();
    let applyCalls = 0;
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0, stdout: 'init ok' });
      if (args[0] === 'apply') {
        applyCalls += 1;
        if (applyCalls === 1)
          return makeChild({ code: 1, stderr: 'NoSuchBucket: state bucket does not exist' });
        return makeChild({ code: 0, stdout: 'apply complete' });
      }
      if (args[0] === 'output')
        return makeChild({ code: 0, stdout: '{}' });
      return makeChild({ code: 0 });
    });
    clack.mockConfirm.mockResolvedValue(true); // accept recovery prompt

    // Final success exit(0) is inside try: use no-op exit so it is not swallowed.
    exitSpy.mockImplementation(() => { });
    await applyStack({});

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(provisionStateBucket).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('recovery_accepted', expect.anything());
    expect(trackEvent).toHaveBeenCalledWith('recovery_successful', expect.anything());
    expect(applyCalls).toBe(2);
    // Initial confirm-mode preview plus the print-only preview on the
    // autoApprove recovery resume.
    expect(renderDryRunPreview).toHaveBeenCalledTimes(2);
    expect(renderDryRunPreview).toHaveBeenNthCalledWith(1, expect.anything(), false);
    expect(renderDryRunPreview).toHaveBeenNthCalledWith(2, expect.anything(), true);
  });

  it('still prints the preview in print-only mode when autoApprove is true', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'output') return makeChild({ code: 0, stdout: '{}' });
      return makeChild({ code: 0 });
    });

    // Success exit(0) lives inside the try block: no-op exit like above.
    exitSpy.mockImplementation(() => { });
    await applyStack({ autoApprove: true });

    expect(renderDryRunPreview).toHaveBeenCalledTimes(1);
    expect(renderDryRunPreview).toHaveBeenCalledWith(expect.anything(), true);
    expect(clack.mockConfirm).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('aborts when the user declines state-bucket recovery', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0 });
      return makeChild({ code: 1, stderr: 'NoSuchBucket: gone' });
    });
    clack.mockConfirm.mockResolvedValue(false); // decline recovery

    await expect(applyStack({})).rejects.toMatchObject({ exitCode: 1 });
    expect(provisionStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('recovery_declined', expect.anything());
  });

  it('prints OIDC guidance when the GitHub provider already exists', async () => {
    writeProject();
    mockSpawn.mockImplementation((cmd, args = []) => {
      if (args[0] === 'init') return makeChild({ code: 0 });
      return makeChild({
        code: 1,
        stderr: 'EntityAlreadyExists: token.actions.githubusercontent.com provider exists',
      });
    });

    await expect(applyStack({})).rejects.toMatchObject({ exitCode: 1 });
    expect(clack.mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('OIDC')
    );
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false })
    );
  });

  it('treats spawn errors (missing binary) as apply failure without AWS calls', async () => {
    writeProject();
    mockSpawn.mockImplementation(() =>
      makeChild({ error: new Error('spawn terraform ENOENT') })
    );

    await expect(applyStack({})).rejects.toMatchObject({ exitCode: 1 });
    expect(provisionStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_applied',
      expect.objectContaining({ success: false })
    );
  });

  it('is wired into bin/cli.js', () => {
    const cliPath = path.resolve(process.cwd(), 'bin/cli.js');
    // tests run from repo root after chdir restore; resolve from original cwd
    const resolved = path.isAbsolute(cliPath) ? cliPath : path.join(originalCwd, 'bin/cli.js');
    const content = fs.readFileSync(path.join(originalCwd, 'bin/cli.js'), 'utf8');
    expect(resolved).toContain('cli.js');
    expect(content).toContain('applyStack');
    expect(content).toContain("'apply'");
  });
});
