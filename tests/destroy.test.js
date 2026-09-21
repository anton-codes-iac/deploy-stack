import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

// --- Deep mock for child_process.spawn (no real terraform binary) ---
const { mockSpawn, mockExecSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execSync: mockExecSync,
}));

// --- Silence interactive UI; confirm is controllable per test ---
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

// --- Never touch AWS or the network ---
vi.mock('../src/utils/aws.js', () => ({
  checkAwsCredentials: vi.fn().mockResolvedValue({
    accountId: '123456789012',
    awsAccountId: '123456789012',
    region: 'us-east-2',
  }),
  provisionStateBucket: vi.fn().mockResolvedValue({
    awsAccountId: '123456789012',
    stateBucketName: 'mock-tf-state-bucket',
  }),
  teardownStateBucket: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/utils/system.js', () => ({
  checkDependency: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/core/telemetry.js', () => ({
  trackEvent: vi.fn(),
  flushTelemetry: vi.fn().mockResolvedValue(),
}));

import { destroyStack } from '../src/commands/destroy.js';
import { teardownStateBucket } from '../src/utils/aws.js';
import { checkDependency } from '../src/utils/system.js';
import { trackEvent } from '../src/core/telemetry.js';

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

describe('Command: destroy (mocked terraform spawn)', () => {
  const originalCwd = process.cwd();
  let tmpDir;
  let exitSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    checkDependency.mockResolvedValue(true);
    teardownStateBucket.mockResolvedValue(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw exitError(code);
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'destroy-test-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBackend(bucket = 'myapp-tfstate-123', region = 'us-east-2') {
    fs.mkdirSync(path.join(tmpDir, 'terraform'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'terraform', 'backend.tf'),
      `terraform {\n  backend "s3" {\n    bucket = "${bucket}"\n    region = "${region}"\n  }\n}\n`
    );
    process.chdir(tmpDir);
  }

  it('exits 1 when terraform/backend.tf is missing', async () => {
    process.chdir(tmpDir); // empty tmpdir
    await expect(destroyStack()).rejects.toMatchObject({ exitCode: 1 });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when terraform is not installed', async () => {
    writeBackend();
    checkDependency.mockResolvedValue(false);
    await expect(destroyStack()).rejects.toMatchObject({ exitCode: 1 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('cancels cleanly when the user declines the confirm prompt', async () => {
    writeBackend();
    clack.mockConfirm.mockResolvedValue(false);
    await expect(destroyStack()).rejects.toMatchObject({ exitCode: 0 });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(teardownStateBucket).not.toHaveBeenCalled();
    expect(clack.mockCancel).toHaveBeenCalled();
  });

  it('destroys compute and retains the state bucket when declined', async () => {
    writeBackend('retain-bucket-123', 'eu-west-1');
    clack.mockConfirm
      .mockResolvedValueOnce(true) // proceed with destroy
      .mockResolvedValueOnce(false); // retain bucket
    mockSpawn.mockImplementation((cmd, args = []) => {
      expect(cmd).toBe('terraform');
      expect(args).toEqual(['destroy', '-auto-approve']);
      return makeChild({ code: 0, stdout: 'destroy complete' });
    });

    await destroyStack(); // success path calls outro, not process.exit

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(teardownStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: true, retained_state_bucket: true })
    );
    expect(clack.mockOutro).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('destroys compute and deletes the state bucket when confirmed', async () => {
    writeBackend('delete-me-123', 'us-east-2');
    clack.mockConfirm
      .mockResolvedValueOnce(true) // proceed
      .mockResolvedValueOnce(true); // delete bucket
    mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));

    await destroyStack();

    expect(teardownStateBucket).toHaveBeenCalledWith('us-east-2', 'delete-me-123');
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: true, retained_state_bucket: false })
    );
  });

  it('exits 1 and tracks failure when terraform destroy exits non-zero', async () => {
    writeBackend();
    clack.mockConfirm.mockResolvedValueOnce(true);
    mockSpawn.mockImplementation(() =>
      makeChild({ code: 1, stderr: 'Error: destroy failed dramatically' })
    );

    await expect(destroyStack()).rejects.toMatchObject({ exitCode: 1 });
    expect(teardownStateBucket).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: false })
    );
  });

  it('treats spawn errors (missing binary) as destroy failure', async () => {
    writeBackend();
    clack.mockConfirm.mockResolvedValueOnce(true);
    mockSpawn.mockImplementation(() =>
      makeChild({ error: new Error('spawn terraform ENOENT') })
    );

    await expect(destroyStack()).rejects.toMatchObject({ exitCode: 1 });
    expect(trackEvent).toHaveBeenCalledWith(
      'infrastructure_destroyed',
      expect.objectContaining({ success: false })
    );
  });

  it('survives S3 bucket deletion errors and still reports success', async () => {
    writeBackend('flaky-bucket', 'us-east-2');
    clack.mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy ok' }));
    teardownStateBucket.mockRejectedValueOnce(new Error('AccessDenied'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await destroyStack();
      expect(teardownStateBucket).toHaveBeenCalled();
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: true })
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('is wired into bin/cli.js', () => {
    const content = fs.readFileSync(path.join(originalCwd, 'bin/cli.js'), 'utf8');
    expect(content).toContain('destroyStack');
    expect(content).toContain("'destroy'");
  });
});
