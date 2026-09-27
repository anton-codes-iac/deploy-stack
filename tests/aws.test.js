import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provisionStateBucket, handleAwsAuthError, isAuthError, handleAuthErrorBranch, resolveClient, hasAwsCli, resetAwsCliCache } from '../src/utils/aws.js';

const { mockSpawnSync } = vi.hoisted(() => ({ mockSpawnSync: vi.fn() }));

vi.mock('child_process', () => ({
  spawnSync: mockSpawnSync,
}));

const {
  mockS3Send,
  mockStsSend,
  MockS3Client,
  MockSTSClient,
  MockGetCallerIdentityCommand,
  MockCreateBucketCommand,
  MockPutBucketVersioningCommand,
  MockPutBucketTaggingCommand,
} = vi.hoisted(() => {
  const s3Send = vi.fn();
  const stsSend = vi.fn();
  const mockCommand = (input) => Object.assign({}, input);
  return {
    mockS3Send: s3Send,
    mockStsSend: stsSend,
    MockS3Client: vi.fn(function () {
      this.send = s3Send;
    }),
    MockSTSClient: vi.fn(function () {
      this.send = stsSend;
    }),
    MockGetCallerIdentityCommand: vi.fn(function (input) {
      Object.assign(this, mockCommand(input));
    }),
    MockCreateBucketCommand: vi.fn(function (input) {
      Object.assign(this, mockCommand(input));
    }),
    MockPutBucketVersioningCommand: vi.fn(function (input) {
      Object.assign(this, mockCommand(input));
    }),
    MockPutBucketTaggingCommand: vi.fn(function (input) {
      Object.assign(this, mockCommand(input));
    }),
  };
});

vi.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: MockS3Client,
    CreateBucketCommand: MockCreateBucketCommand,
    PutBucketVersioningCommand: MockPutBucketVersioningCommand,
    PutBucketTaggingCommand: MockPutBucketTaggingCommand,
  };
});

vi.mock('@aws-sdk/client-sts', () => {
  return {
    STSClient: MockSTSClient,
    GetCallerIdentityCommand: MockGetCallerIdentityCommand,
  };
});

describe('provisionStateBucket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send.mockReset().mockResolvedValue({});
    mockStsSend.mockReset().mockResolvedValue({ Account: '123456789012' });
  });

  it("when region is 'us-east-1', CreateBucketConfiguration is undefined", async () => {
    await provisionStateBucket('us-east-1', 'my-project');

    expect(MockCreateBucketCommand).toHaveBeenCalledWith(
      expect.objectContaining({ CreateBucketConfiguration: undefined }),
    );
    expect(MockCreateBucketCommand.mock.calls[0][0].CreateBucketConfiguration).toBeUndefined();
  });

  it("when region is 'us-east-2', CreateBucketConfiguration has LocationConstraint 'us-east-2'", async () => {
    await provisionStateBucket('us-east-2', 'my-project');

    expect(MockCreateBucketCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        CreateBucketConfiguration: { LocationConstraint: 'us-east-2' },
      }),
    );
    expect(MockCreateBucketCommand.mock.calls[0][0].CreateBucketConfiguration).toEqual({
      LocationConstraint: 'us-east-2',
    });
  });
});

describe('handleAwsAuthError', () => {
  let exitSpy;
  let consoleSpy;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('stops the spinner, prints install guidance, and exits 1 when the AWS CLI is missing', () => {
    const spinner = { stop: vi.fn() };

    handleAwsAuthError({ name: 'ExpiredTokenException' }, spinner, {
      spawnSyncImpl: () => {
        throw new Error('ENOENT');
      },
    });

    expect(spinner.stop).toHaveBeenCalledWith(expect.stringContaining('AWS session expired'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('AWS CLI not found'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('aws-credentials.md'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints sso login guidance when the AWS CLI is present', () => {
    const spinner = { stop: vi.fn() };

    handleAwsAuthError({ name: 'UnrecognizedClientException' }, spinner, {
      spawnSyncImpl: () => ({ status: 0 }),
    });

    expect(spinner.stop).toHaveBeenCalledWith(expect.stringContaining('AWS session expired'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('aws sso login'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('aws-credentials.md'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('tolerates a null spinner', () => {
    expect(() =>
      handleAwsAuthError({ name: 'ExpiredTokenException' }, null, {
        spawnSyncImpl: () => ({ status: 0 }),
      }),
    ).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('aws sso login'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('isAuthError', () => {
  it('matches expired/invalid credential errors only', () => {
    expect(isAuthError({ name: 'ExpiredTokenException' })).toBe(true);
    expect(isAuthError({ name: 'UnrecognizedClientException' })).toBe(true);
    expect(isAuthError({ name: 'ResourceNotFoundException' })).toBe(false);
    expect(isAuthError({})).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe('handleAuthErrorBranch', () => {
  let exitSpy;
  let consoleSpy;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('handles auth errors and reports true', () => {
    const handled = handleAuthErrorBranch({ name: 'ExpiredTokenException' }, null, {
      spawnSyncImpl: () => ({ status: 0 }),
    });

    expect(handled).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('aws sso login'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('ignores non-auth errors and reports false without exiting', () => {
    const handled = handleAuthErrorBranch({ name: 'ResourceNotFoundException', message: 'nope' }, null, {
      spawnSyncImpl: () => ({ status: 0 }),
    });

    expect(handled).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('resolveClient', () => {
  class FakeClient {
    constructor(options) {
      this.options = options;
    }
  }

  it('returns the injected client when it has a send method', () => {
    const injected = { send: () => {} };
    expect(resolveClient(injected, FakeClient, { region: 'us-east-2' })).toBe(injected);
  });

  it('constructs the client when nothing usable is injected', () => {
    const built = resolveClient(undefined, FakeClient, { region: 'eu-west-1' });
    expect(built).toBeInstanceOf(FakeClient);
    expect(built.options).toEqual({ region: 'eu-west-1' });
  });

  it('constructs the client when the injected value has no send method', () => {
    expect(resolveClient({ not: 'a-client' }, FakeClient)).toBeInstanceOf(FakeClient);
    expect(resolveClient(null, FakeClient)).toBeInstanceOf(FakeClient);
  });
});

describe('hasAwsCli result cache', () => {
  beforeEach(() => {
    resetAwsCliCache();
    mockSpawnSync.mockReset().mockReturnValue({ status: 0 });
  });

  it('spawns once for repeated default calls within the TTL', () => {
    expect(hasAwsCli()).toBe(true);
    expect(hasAwsCli()).toBe(true);
    expect(hasAwsCli({})).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockSpawnSync).toHaveBeenCalledWith('aws', ['--version'], { stdio: 'ignore' });
  });

  it('spawns again after resetAwsCliCache()', () => {
    expect(hasAwsCli()).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    resetAwsCliCache();
    expect(hasAwsCli()).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache for custom spawnSyncImpl without polluting it', () => {
    expect(hasAwsCli({ spawnSyncImpl: () => ({ status: 1 }) })).toBe(false);
    expect(hasAwsCli({ spawnSyncImpl: () => ({ status: 0 }) })).toBe(true);
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(hasAwsCli()).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });
});
