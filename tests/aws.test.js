import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { provisionStateBucket, handleAwsAuthError } from '../src/utils/aws.js';

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
