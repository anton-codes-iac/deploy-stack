import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import {
    runDbConnect,
    parseDbArgs,
    isValidPort,
    resolveWorkspaceSuffix,
    resolveDbIdentifier,
    buildConnectionString,
    formatConnectionInfo,
    buildSsmArgs,
    pickRuntimeContainer,
    DEFAULT_LOCAL_PORT,
    MASKED_PASSWORD,
} from '../src/commands/db.js';

vi.mock('@clack/prompts', () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

const { mockTrackEvent } = vi.hoisted(() => ({
    mockTrackEvent: vi.fn(),
}));

vi.mock('../src/core/telemetry.js', () => ({
    trackEvent: mockTrackEvent,
    flushTelemetry: vi.fn(() => Promise.resolve()),
}));

const {
    MockDescribeDBInstancesCommand,
    MockListTasksCommand,
    MockDescribeTasksCommand,
    MockGetSecretValueCommand,
} = vi.hoisted(() => ({
    MockDescribeDBInstancesCommand: vi.fn(function (input) { Object.assign(this, input); }),
    MockListTasksCommand: vi.fn(function (input) { Object.assign(this, input); }),
    MockDescribeTasksCommand: vi.fn(function (input) { Object.assign(this, input); }),
    MockGetSecretValueCommand: vi.fn(function (input) { Object.assign(this, input); }),
}));

vi.mock('@aws-sdk/client-rds', () => ({
    RDSClient: vi.fn(function () { this.send = vi.fn(); }),
    DescribeDBInstancesCommand: MockDescribeDBInstancesCommand,
}));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn(function () { this.send = vi.fn(); }),
    ListTasksCommand: MockListTasksCommand,
    DescribeTasksCommand: MockDescribeTasksCommand,
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: vi.fn(function () { this.send = vi.fn(); }),
    GetSecretValueCommand: MockGetSecretValueCommand,
}));

const TASK_ARN = 'arn:aws:ecs:us-east-2:123456789012:task/myapp-cluster/abc123def456';
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-xyz';
const DB_PASSWORD = 's3cr3t-db-password';
const DB_USERNAME = 'dbadmin';

function mockRdsClient(dbInstance) {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeDBInstancesCommand) {
                return Promise.resolve({ DBInstances: dbInstance ? [dbInstance] : [] });
            }
            return Promise.resolve({});
        }),
    };
}

function mockRdsNotFoundClient() {
    const err = new Error('DB instance not found');
    err.name = 'DBInstanceNotFound';
    return { send: vi.fn(() => Promise.reject(err)) };
}

function mockSecretsClient(secretString) {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockGetSecretValueCommand) {
                return Promise.resolve({ SecretString: secretString });
            }
            return Promise.resolve({});
        }),
    };
}

function mockEcsClient({ taskArns = [], tasks = [] } = {}) {
    return {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockListTasksCommand) return Promise.resolve({ taskArns });
            if (cmd instanceof MockDescribeTasksCommand) return Promise.resolve({ tasks });
            return Promise.resolve({});
        }),
    };
}

function healthyDbInstance(overrides = {}) {
    return {
        DBInstanceIdentifier: 'myapp-db',
        Endpoint: { Address: 'myapp-db.abc123.us-east-2.rds.amazonaws.com' },
        DBName: 'myapp',
        MasterUserSecret: { SecretArn: SECRET_ARN },
        ...overrides,
    };
}

function healthyTask(overrides = {}) {
    return {
        taskArn: TASK_ARN,
        containers: [{ name: 'myapp-container', lastStatus: 'RUNNING', runtimeId: 'runtime-1' }],
        ...overrides,
    };
}

function mockSpawnImpl(calls, exitCode = 0) {
    return vi.fn((cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', exitCode));
        return child;
    });
}

function baseOptions(overrides = {}) {
    return {
        projectName: 'myapp',
        region: 'us-east-2',
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-')),
        hasAwsCli: true,
        hasSsmPlugin: true,
        spawnImpl: mockSpawnImpl([], 0),
        ...overrides,
    };
}

describe('db: CLI args', () => {
    it('parses port, flags, and overrides after db connect', () => {
        expect(parseDbArgs(['db', 'connect', '--port', '5433', '--show-credentials', '--workspace', 'pr-7', '--region', 'eu-west-1', '--cluster', 'c', '--service', 's'])).toEqual({
            port: '5433',
            showCredentials: true,
            workspace: 'pr-7',
            region: 'eu-west-1',
            cluster: 'c',
            service: 's',
        });
    });

    it('supports = syntax and defaults to empty options', () => {
        expect(parseDbArgs(['db', 'connect', '--port=5544', '--region=us-west-2'])).toEqual({
            port: '5544',
            region: 'us-west-2',
        });
        expect(parseDbArgs(['db', 'connect'])).toEqual({});
        expect(parseDbArgs([])).toEqual({});
    });

    it('validates ports as purely numeric in range', () => {
        expect(isValidPort('5432')).toBe(true);
        expect(isValidPort('1')).toBe(true);
        expect(isValidPort('65535')).toBe(true);
        expect(isValidPort('abc')).toBe(false);
        expect(isValidPort('54a2')).toBe(false);
        expect(isValidPort('')).toBe(false);
        expect(isValidPort('0')).toBe(false);
        expect(isValidPort('65536')).toBe(false);
        expect(isValidPort('-1')).toBe(false);
        expect(isValidPort(undefined)).toBe(false);
        expect(DEFAULT_LOCAL_PORT).toBe('5432');
    });
});

describe('db: workspace resolution', () => {
    it('returns no suffix without a workspace', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ws-'));
        expect(resolveWorkspaceSuffix({ projectName: 'myapp', cwd: dir }, dir)).toBe('');
        expect(resolveDbIdentifier({ projectName: 'myapp', cwd: dir }, dir)).toBe('myapp-db');
    });

    it('appends an explicit --workspace flag', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ws-'));
        expect(resolveWorkspaceSuffix({ workspace: 'pr-123' }, dir)).toBe('-pr-123');
        expect(resolveDbIdentifier({ projectName: 'myapp', workspace: 'pr-123', cwd: dir }, dir)).toBe('myapp-pr-123-db');
    });

    it('detects the workspace from .terraform/environment', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ws-'));
        fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'pr-42\n');
        expect(resolveWorkspaceSuffix({}, dir)).toBe('-pr-42');
        expect(resolveDbIdentifier({ projectName: 'myapp' }, dir)).toBe('myapp-pr-42-db');
    });

    it('treats the default workspace as no suffix', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ws-'));
        fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'default');
        expect(resolveWorkspaceSuffix({}, dir)).toBe('');
    });
});

describe('db: output formatting', () => {
    const details = { localPort: '5432', dbName: 'myapp', username: 'dbadmin', password: DB_PASSWORD };

    it('masks the password unless --show-credentials is passed', () => {
        const masked = formatConnectionInfo({ ...details, showCredentials: false });
        expect(masked).toContain(MASKED_PASSWORD);
        expect(masked).not.toContain(DB_PASSWORD);
        expect(masked).toContain(`postgresql://dbadmin:${MASKED_PASSWORD}@localhost:5432/myapp`);

        const shown = formatConnectionInfo({ ...details, showCredentials: true });
        expect(shown).toContain(DB_PASSWORD);
        expect(shown).toContain(`postgresql://dbadmin:${DB_PASSWORD}@localhost:5432/myapp`);
    });

    it('builds masked connection strings by default', () => {
        expect(buildConnectionString(details)).toBe(`postgresql://dbadmin:${MASKED_PASSWORD}@localhost:5432/myapp`);
        expect(buildConnectionString({ ...details, showCredentials: true })).toContain(DB_PASSWORD);
    });

    it('percent-encodes credentials in the URI but not the standalone password line', () => {
        const tricky = {
            localPort: '5432',
            dbName: 'myapp',
            username: 'db@admin',
            password: 'p@ss[w]/ord:!',
        };
        const encodedUser = encodeURIComponent('db@admin');
        const encodedPass = encodeURIComponent('p@ss[w]/ord:!');
        expect(encodedPass).toBe('p%40ss%5Bw%5D%2Ford%3A!');

        expect(buildConnectionString({ ...tricky, showCredentials: true }))
            .toBe(`postgresql://${encodedUser}:${encodedPass}@localhost:5432/myapp`);

        const shown = formatConnectionInfo({ ...tricky, showCredentials: true });
        // URI line carries the encoded form so parsers don't break...
        expect(shown).toContain(`postgresql://${encodedUser}:${encodedPass}@localhost:5432/myapp`);
        // ...while the standalone Password line stays verbatim for copy-paste.
        expect(shown).toContain('p@ss[w]/ord:!');
    });

    it('builds the SSM target from cluster, task id, and runtime id', () => {
        expect(buildSsmArgs({
            cluster: 'myapp-cluster',
            taskId: 'abc123',
            runtimeId: 'runtime-1',
            dbHost: 'db.host',
            localPort: '5433',
            region: 'us-east-2',
        })).toEqual([
            'ssm', 'start-session',
            '--target', 'ecs:myapp-cluster_abc123_runtime-1',
            '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
            '--parameters', '{"host":["db.host"],"portNumber":["5432"],"localPortNumber":["5433"]}',
            '--region', 'us-east-2',
        ]);
    });

    it('picks the expected container, then first RUNNING, then first', () => {
        const task = {
            containers: [
                { name: 'redis', lastStatus: 'RUNNING', runtimeId: 'rt-redis' },
                { name: 'myapp-container', lastStatus: 'RUNNING', runtimeId: 'rt-app' },
            ],
        };
        expect(pickRuntimeContainer(task, 'myapp-container').runtimeId).toBe('rt-app');
        expect(pickRuntimeContainer(task, 'missing').runtimeId).toBe('rt-redis');
        expect(pickRuntimeContainer({ containers: [{ name: 'only' }] }, 'missing').name).toBe('only');
        expect(pickRuntimeContainer({ containers: [] }, 'missing')).toBeNull();
        expect(pickRuntimeContainer({}, 'missing')).toBeNull();
    });
});

describe('Command: db connect (mocked AWS + spawn)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        output = [];
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            output.push(args.join(' '));
        });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    function telemetryPayloads() {
        return mockTrackEvent.mock.calls.map(([, props]) => props || {});
    }

    function assertNoCredentialLeak() {
        const serialized = JSON.stringify(mockTrackEvent.mock.calls);
        expect(serialized).not.toContain(DB_PASSWORD);
        expect(serialized).not.toContain('postgresql://');
        for (const props of telemetryPayloads()) {
            expect(props).not.toHaveProperty('password');
            expect(props).not.toHaveProperty('connectionString');
            expect(props).not.toHaveProperty('secret');
        }
    }

    function healthyClients() {
        return {
            rdsClient: mockRdsClient(healthyDbInstance()),
            secretsClient: mockSecretsClient(JSON.stringify({ username: DB_USERNAME, password: DB_PASSWORD })),
            ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
        };
    }

    it('opens the tunnel and prints masked credentials by default', async () => {
        const calls = [];
        const result = await runDbConnect({ ...baseOptions(), ...healthyClients(), spawnImpl: mockSpawnImpl(calls, 0) });

        expect(result.ok).toBe(true);
        expect(result.dbIdentifier).toBe('myapp-db');
        expect(result.localPort).toBe('5432');
        expect(result).not.toHaveProperty('password');
        expect(exitSpy).not.toHaveBeenCalled();

        expect(calls).toHaveLength(1);
        const { cmd, args, opts } = calls[0];
        expect(cmd).toBe('aws');
        expect(args).toEqual([
            'ssm', 'start-session',
            '--target', 'ecs:myapp-cluster_abc123def456_runtime-1',
            '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
            '--parameters', '{"host":["myapp-db.abc123.us-east-2.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}',
            '--region', 'us-east-2',
        ]);
        expect(opts).toEqual(expect.objectContaining({ stdio: 'inherit' }));

        const text = output.join('\n');
        expect(text).toContain(MASKED_PASSWORD);
        expect(text).not.toContain(DB_PASSWORD);

        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: true }));
        assertNoCredentialLeak();
    });

    it('reveals credentials and uses a custom local port when requested', async () => {
        const calls = [];
        const result = await runDbConnect({
            ...baseOptions({ port: '5544', showCredentials: true }),
            ...healthyClients(),
            spawnImpl: mockSpawnImpl(calls, 0),
        });

        expect(result.ok).toBe(true);
        expect(result.localPort).toBe('5544');
        const text = output.join('\n');
        expect(text).toContain(DB_PASSWORD);
        expect(text).toContain('localhost:5544');
        // Terminal output intentionally shows credentials here, but telemetry must not.
        assertNoCredentialLeak();
    });

    it('targets PR-preview resources with --workspace', async () => {
        const calls = [];
        const rdsClient = mockRdsClient(healthyDbInstance({ DBInstanceIdentifier: 'myapp-pr-9-db' }));
        const result = await runDbConnect({
            ...baseOptions({ workspace: 'pr-9' }),
            rdsClient,
            secretsClient: mockSecretsClient(JSON.stringify({ username: DB_USERNAME, password: DB_PASSWORD })),
            ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
            spawnImpl: mockSpawnImpl(calls, 0),
        });

        expect(result.ok).toBe(true);
        expect(result.dbIdentifier).toBe('myapp-pr-9-db');
        const describeInput = rdsClient.send.mock.calls[0][0];
        expect(describeInput.DBInstanceIdentifier).toBe('myapp-pr-9-db');
        expect(calls[0].args.join(' ')).toContain('ecs:myapp-pr-9-cluster_');
    });

    it('exits gracefully when no database is provisioned', async () => {
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({
            ...baseOptions(),
            rdsClient: mockRdsNotFoundClient(),
            secretsClient: mockSecretsClient('{}'),
            ecsClient: mockEcsClient(),
            spawnImpl,
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('no-database');
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(output.join('\n')).toMatch(/No database found|no database is provisioned/i);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: false, error_code: 'NO_DATABASE' }));
        assertNoCredentialLeak();
    });

    it('exits gracefully when no tasks are running', async () => {
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({
            ...baseOptions(),
            ...healthyClients(),
            ecsClient: mockEcsClient({ taskArns: [], tasks: [] }),
            spawnImpl,
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('no-running-tasks');
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(output.join('\n')).toMatch(/No running containers|jump host/i);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects a non-numeric --port before any AWS call', async () => {
        const clients = healthyClients();
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({ ...baseOptions({ port: 'abc' }), ...clients, spawnImpl });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-port');
        expect(clients.rdsClient.send).not.toHaveBeenCalled();
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: false, error_code: 'INVALID_PORT' }));
    });

    it('fails fast with install guidance when AWS CLI is missing', async () => {
        const clients = healthyClients();
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({ ...baseOptions({ hasAwsCli: false }), ...clients, spawnImpl });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('aws-cli-missing');
        expect(clients.rdsClient.send).not.toHaveBeenCalled();
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(output.join('\n')).toMatch(/AWS CLI not found/);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('fails fast when the Session Manager plugin is missing', async () => {
        const clients = healthyClients();
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({ ...baseOptions({ hasSsmPlugin: false }), ...clients, spawnImpl });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('ssm-plugin-missing');
        expect(clients.rdsClient.send).not.toHaveBeenCalled();
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(output.join('\n')).toMatch(/Session Manager plugin not found/);
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits gracefully when the managed secret is malformed', async () => {
        const spawnImpl = mockSpawnImpl([], 0);
        const result = await runDbConnect({
            ...baseOptions(),
            rdsClient: mockRdsClient(healthyDbInstance()),
            secretsClient: mockSecretsClient('not-json{{{'),
            ecsClient: mockEcsClient({ taskArns: [TASK_ARN], tasks: [healthyTask()] }),
            spawnImpl,
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('secret-malformed');
        expect(spawnImpl).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_connect_run', expect.objectContaining({ success: false, error_code: 'SECRET_MALFORMED' }));
        assertNoCredentialLeak();
    });
});
