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

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: mockSpawn,
    execSync: mockExecSync,
  };
});

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
  // Tests that inject no client exercise the no-database path (the
  // pre-destroy hook no-ops); hook tests inject a scripted client.
  resolveClient: (injected) => injected ?? {
    send: async (command) => {
      const name = command.constructor.name;
      if (name === 'DescribeDBInstancesCommand') {
        throw Object.assign(new Error('DBInstanceNotFound'), { name: 'DBInstanceNotFound' });
      }
      if (name === 'DescribeDBClustersCommand') {
        throw Object.assign(new Error('DBClusterNotFoundFault'), { name: 'DBClusterNotFoundFault' });
      }
      throw new Error(`unexpected command ${name}`);
    },
  },
}));

vi.mock('../src/utils/system.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    checkDependency: vi.fn().mockResolvedValue(true),
    pollUntil: actual.pollUntil,
  };
});

vi.mock('../src/core/telemetry.js', () => {
  const trackEvent = vi.fn();
  const flushTelemetry = vi.fn().mockResolvedValue();
  // Mirrors the real trackSuccess delegation so success-path assertions
  // keep observing trackEvent (the real helper is unit-tested separately).
  const trackSuccess = vi.fn(async (event, properties) => {
    trackEvent(event, { ...properties, success: true });
    await flushTelemetry();
  });
  return { trackEvent, flushTelemetry, trackSuccess };
});

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

  describe('pre-destroy database wake hook', () => {
    const noopSleep = async () => {};

    // Scripted RDS client: `statuses` is the Status sequence returned by
    // Describe calls (first call feeds findDbTarget, the rest feed the
    // wait loops); Start calls are recorded in `seen`.
    function scriptedRdsClient({ kind = 'instance', statuses = [] } = {}) {
      const seen = [];
      let calls = 0;
      const nextStatus = () => statuses[Math.min(calls++, statuses.length - 1)];
      return {
        seen,
        send: vi.fn(async (command) => {
          const name = command.constructor.name;
          seen.push(name);
          if (name === 'DescribeDBInstancesCommand') {
            if (kind !== 'instance') {
              throw Object.assign(new Error('DBInstanceNotFound'), { name: 'DBInstanceNotFound' });
            }
            return { DBInstances: [{ Status: nextStatus(), Engine: 'postgres' }] };
          }
          if (name === 'DescribeDBClustersCommand') {
            if (kind !== 'cluster') {
              throw Object.assign(new Error('DBClusterNotFoundFault'), { name: 'DBClusterNotFoundFault' });
            }
            return { DBClusters: [{ Status: nextStatus(), Engine: 'aurora-postgresql' }] };
          }
          if (name === 'StartDBInstanceCommand' || name === 'StartDBClusterCommand') return {};
          throw new Error(`unexpected command ${name}`);
        }),
      };
    }

    function confirmDestroy() {
      clack.mockConfirm
        .mockResolvedValueOnce(true) // proceed with destroy
        .mockResolvedValueOnce(false); // retain bucket
      mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));
    }

    it('starts a stopped instance and waits for available before destroying', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['stopped', 'starting', 'available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep });

      expect(rdsClient.seen).toContain('StartDBInstanceCommand');
      expect(rdsClient.seen).not.toContain('StartDBClusterCommand');
      expect(clack.mockSpinnerStart).toHaveBeenCalledWith('Waking database before destruction...');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(clack.mockOutro).toHaveBeenCalled();
    });

    it('settles a stopping cluster to stopped before starting it', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'cluster', statuses: ['stopping', 'stopping', 'stopped', 'starting', 'available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep });

      // Start fires only after the settle loop observed `stopped`
      // (describe, describe, describe, start, ...).
      expect(rdsClient.seen.indexOf('StartDBClusterCommand')).toBeGreaterThan(2);
      expect(rdsClient.seen).not.toContain('StartDBInstanceCommand');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('waits for a starting database without sending Start', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['starting', 'available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep });

      expect(rdsClient.seen).not.toContain('StartDBInstanceCommand');
      expect(rdsClient.seen).not.toContain('StartDBClusterCommand');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('skips the hook when the database is already available', async () => {
      writeBackend();
      confirmDestroy();
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['available'] });

      await destroyStack({ rdsClient, sleepFn: noopSleep });

      expect(rdsClient.seen).not.toContain('StartDBInstanceCommand');
      expect(clack.mockSpinnerStart).not.toHaveBeenCalledWith('Waking database before destruction...');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('aborts destroy when the database never becomes available', async () => {
      writeBackend();
      clack.mockConfirm.mockResolvedValueOnce(true);
      mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));
      const rdsClient = scriptedRdsClient({ kind: 'instance', statuses: ['stopped'] });

      await expect(destroyStack({ rdsClient, sleepFn: noopSleep, timeoutMs: 0 })).rejects.toMatchObject({ exitCode: 1 });
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'RDS_DESTROY_PREFLIGHT_TIMEOUT' })
      );
    });

    it('aborts destroy when the database lookup fails', async () => {
      writeBackend();
      clack.mockConfirm.mockResolvedValueOnce(true);
      mockSpawn.mockImplementation(() => makeChild({ code: 0, stdout: 'destroy complete' }));
      const rdsClient = { send: vi.fn(async () => { throw new Error('boom'); }) };

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(destroyStack({ rdsClient, sleepFn: noopSleep })).rejects.toMatchObject({ exitCode: 1 });
      } finally {
        consoleSpy.mockRestore();
      }
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(trackEvent).toHaveBeenCalledWith(
        'infrastructure_destroyed',
        expect.objectContaining({ success: false, error_code: 'RDS_DESTROY_PREFLIGHT_FAILED' })
      );
    });
  });
});
