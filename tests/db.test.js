import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { stripVTControlCharacters } from 'node:util';
import {
    runDb,
    runDbConnect,
    parseDbArgs,
    isValidPort,
    resolveDbIdentifier,
    buildConnectionString,
    formatConnectionInfo,
    buildSsmArgs,
    pickRuntimeContainer,
    DEFAULT_LOCAL_PORT,
    MASKED_PASSWORD,
    runDbMigrate,
    parseDbMigrateArgs,
    runDbBackup,
    parseDbBackupArgs,
    runDbRestore,
    parseDbRestoreArgs,
    upsertSnapshotIdentifier,
} from '../src/commands/db.js';
import { injectMigrationGate, quoteShellArg } from '../src/commands/db/migrate.js';
import { resolveWorkspaceSuffix } from '../src/utils/resolvers.js';

const { mockText, mockSelect, mockConfirm, mockSpinner } = vi.hoisted(() => ({
    mockText: vi.fn(),
    mockSelect: vi.fn(),
    mockConfirm: vi.fn(),
    mockSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}));

vi.mock('@clack/prompts', () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: (...args) => mockSpinner(...args),
    text: (...args) => mockText(...args),
    select: (...args) => mockSelect(...args),
    confirm: (...args) => mockConfirm(...args),
    cancel: vi.fn(),
    isCancel: (value) => typeof value === 'symbol',
}));

const { mockTrackEvent } = vi.hoisted(() => ({
    mockTrackEvent: vi.fn(),
}));

vi.mock('../src/core/telemetry.js', () => {
    const flushTelemetry = vi.fn(() => Promise.resolve());
    // Mirrors the real trackSuccess delegation so success-path assertions
    // keep observing trackEvent (the real helper is unit-tested separately).
    const trackSuccess = vi.fn(async (event, properties) => {
        mockTrackEvent(event, { ...properties, success: true });
        await flushTelemetry();
    });
    const trackFailure = vi.fn(async (event, properties) => {
        mockTrackEvent(event, { ...properties, success: false });
        await flushTelemetry();
    });
    return { trackEvent: mockTrackEvent, flushTelemetry, trackSuccess, trackFailure };
});

const {
    MockDescribeDBInstancesCommand,
    MockCreateDBSnapshotCommand,
    MockDescribeDBSnapshotsCommand,
    MockListTasksCommand,
    MockDescribeTasksCommand,
    MockDescribeServicesCommand,
    MockDescribeTaskDefinitionCommand,
    MockRunTaskCommand,
    MockStopTaskCommand,
    MockGetSecretValueCommand,
    MockFilterLogEventsCommand,
    MockGetLogEventsCommand,
} = vi.hoisted(() => {
    const cmd = () => vi.fn(function (input) { Object.assign(this, input); });
    return {
        MockDescribeDBInstancesCommand: cmd(),
        MockCreateDBSnapshotCommand: cmd(),
        MockDescribeDBSnapshotsCommand: cmd(),
        MockListTasksCommand: cmd(),
        MockDescribeTasksCommand: cmd(),
        MockDescribeServicesCommand: cmd(),
        MockDescribeTaskDefinitionCommand: cmd(),
        MockRunTaskCommand: cmd(),
        MockStopTaskCommand: cmd(),
        MockGetSecretValueCommand: cmd(),
        MockFilterLogEventsCommand: cmd(),
        MockGetLogEventsCommand: cmd(),
    };
});

vi.mock('@aws-sdk/client-rds', () => ({
    RDSClient: vi.fn(function () { this.send = vi.fn(); }),
    DescribeDBInstancesCommand: MockDescribeDBInstancesCommand,
    CreateDBSnapshotCommand: MockCreateDBSnapshotCommand,
    DescribeDBSnapshotsCommand: MockDescribeDBSnapshotsCommand,
}));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn(function () { this.send = vi.fn(); }),
    ListTasksCommand: MockListTasksCommand,
    DescribeTasksCommand: MockDescribeTasksCommand,
    DescribeServicesCommand: MockDescribeServicesCommand,
    DescribeTaskDefinitionCommand: MockDescribeTaskDefinitionCommand,
    RunTaskCommand: MockRunTaskCommand,
    StopTaskCommand: MockStopTaskCommand,
}));

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
    CloudWatchLogsClient: vi.fn(function () { this.send = vi.fn(); }),
    FilterLogEventsCommand: MockFilterLogEventsCommand,
    GetLogEventsCommand: MockGetLogEventsCommand,
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

    it.each([null, 42, true, { port: 'string' }])('parseDbArgs(%s) returns defaults', (bad) => {
        expect(parseDbArgs(bad)).toEqual({});
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
        const spin = mockSpinner.mock.results[mockSpinner.mock.results.length - 1].value;
        expect(spin.stop).toHaveBeenCalledWith();
        expect(output.join('\n').split('No database found').length - 1).toBe(1);
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

describe('db: dispatcher', () => {
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

    it('reports unknown subcommands with usage and telemetry', async () => {
        const result = await runDb(['db', 'frobnicate']);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unknown-db-subcommand');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const text = stripVTControlCharacters(output.join('\n'));
        expect(text).toContain('Unknown db subcommand "frobnicate"');
        expect(text).toContain('db connect');
        expect(text).toContain('db migrate');
        expect(text).toContain('db backup');
        expect(text).toContain('db restore');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_run', expect.objectContaining({
            success: false,
            error_code: 'UNKNOWN_DB_SUBCOMMAND',
        }));
    });

    it('reports a missing subcommand', async () => {
        const result = await runDb(['db']);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unknown-db-subcommand');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('Missing db subcommand');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('routes to each subcommand', async () => {
        // Each proof fails before any AWS call, so no clients are needed.
        const migrate = await runDb(['db', 'migrate', 'oops-unquoted', '--cmd', 'x']);
        expect(migrate.reason).toBe('unexpected-positional-args');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({ success: false }));

        const backup = await runDb(['db', 'backup', 'oops']);
        expect(backup.reason).toBe('unexpected-positional-args');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_backup_run', expect.objectContaining({ success: false }));

        // The repo root has no terraform/database.tf, so restore fails fast
        // on the missing file before any AWS call.
        const restore = await runDb(['db', 'restore', '--project-name', 'myapp']);
        expect(restore.reason).toBe('database-tf-not-found');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_restore_run', expect.objectContaining({ success: false }));
    });

    it('keeps routing connect without headless interference', async () => {
        const result = await runDb(['db', 'connect', '--port', 'abc']);
        expect(result.reason).toBe('invalid-port');
    });

    it.each([null, 42, true, { port: 'string' }])('runDb(%s) reports a missing subcommand', async (bad) => {
        const result = await runDb(bad, null);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unknown-db-subcommand');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});

describe('db: migrate/backup/restore parsers', () => {
    it('parses migrate flags, = syntax, and boolean shorthands', () => {
        expect(parseDbMigrateArgs([
            'db', 'migrate', '--cmd', 'npx prisma migrate deploy', '--task-def', 'fam:3',
            '--timeout', '120', '--setup-ci', '--project-name', 'p', '--region', 'r',
            '--workspace', 'w', '--cluster', 'c', '--service', 's', '--container', 'ct',
        ])).toEqual({
            cmd: 'npx prisma migrate deploy',
            taskDef: 'fam:3',
            timeout: '120',
            setupCi: true,
            projectName: 'p',
            region: 'r',
            workspace: 'w',
            cluster: 'c',
            service: 's',
            container: 'ct',
        });
        expect(parseDbMigrateArgs(['migrate', '--cmd=x y', '--timeout=30'])).toEqual({
            cmd: 'x y',
            timeout: '30',
        });
        expect(parseDbMigrateArgs(['db', 'migrate'])).toEqual({});
    });

    it('captures unexpected migrate positionals for the quoting guard', () => {
        expect(parseDbMigrateArgs(['db', 'migrate', '--cmd', 'prisma', 'migrate', 'deploy']).unexpectedPositionals)
            .toEqual(['migrate', 'deploy']);
    });

    it('parses backup flags', () => {
        expect(parseDbBackupArgs(['db', 'backup', '--id', 'snap-1', '--no-wait', '--timeout', '60', '--db-identifier', 'dbx'])).toEqual({
            snapshotId: 'snap-1',
            noWait: true,
            timeout: '60',
            dbIdentifier: 'dbx',
        });
        expect(parseDbBackupArgs(['db', 'backup', '--id=snap-2'])).toEqual({ snapshotId: 'snap-2' });
        expect(parseDbBackupArgs(['db', 'backup', 'oops']).unexpectedPositionals).toEqual(['oops']);
    });

    it('parses restore flags and the positional snapshot id', () => {
        expect(parseDbRestoreArgs(['db', 'restore', 'snap-9', '--yes', '--db-identifier', 'dbx'])).toEqual({
            snapshotId: 'snap-9',
            yes: true,
            dbIdentifier: 'dbx',
        });
        expect(parseDbRestoreArgs(['db', 'restore'])).toEqual({});
        expect(parseDbRestoreArgs(['restore', 'a', 'b']).unexpectedPositionals).toEqual(['b']);
    });

    it.each([null, 42, true, { port: 'string' }])('migrate/backup/restore parsers return defaults for %s', (bad) => {
        expect(parseDbMigrateArgs(bad)).toEqual({});
        expect(parseDbBackupArgs(bad)).toEqual({});
        expect(parseDbRestoreArgs(bad)).toEqual({});
    });
});

const MIGRATE_TASK_ARN = 'arn:aws:ecs:us-east-2:123456789012:task/myapp-cluster/migrate123';

function activeServiceDesc(overrides = {}) {
    return {
        serviceName: 'myapp-service',
        status: 'ACTIVE',
        taskDefinition: 'arn:aws:ecs:us-east-2:123456789012:task-definition/myapp-task:7',
        networkConfiguration: {
            awsvpcConfiguration: { subnets: ['sub-1', 'sub-2'], securityGroups: ['sg-1'], assignPublicIp: 'ENABLED' },
        },
        ...overrides,
    };
}

function runningTask() {
    return { taskArn: MIGRATE_TASK_ARN, lastStatus: 'RUNNING', containers: [{ name: 'myapp-container' }] };
}

function stoppedTask(exitCode, reason = 'Essential container exited') {
    const container = exitCode === undefined
        ? { name: 'myapp-container', reason }
        : { name: 'myapp-container', exitCode, reason };
    return { taskArn: MIGRATE_TASK_ARN, lastStatus: 'STOPPED', stoppedReason: 'task-level', containers: [container] };
}

function mockEcsMigrateClient({
    service = activeServiceDesc(),
    taskDefNames = ['myapp-container'],
    containerDefinitions = null,
    runTasks = [{ taskArn: MIGRATE_TASK_ARN }],
    failures = [],
    taskSequence = [],
} = {}) {
    const queue = [...taskSequence];
    const runs = [];
    const stops = [];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeServicesCommand) {
                return Promise.resolve({ services: service ? [service] : [] });
            }
            if (cmd instanceof MockDescribeTaskDefinitionCommand) {
                const defs = containerDefinitions || taskDefNames.map((name) => ({ name }));
                return Promise.resolve({ taskDefinition: { containerDefinitions: defs } });
            }
            if (cmd instanceof MockRunTaskCommand) {
                runs.push(cmd);
                return Promise.resolve({ tasks: runTasks, failures });
            }
            if (cmd instanceof MockDescribeTasksCommand) {
                const next = queue.length > 0 ? queue.shift() : runningTask();
                return Promise.resolve({ tasks: [next] });
            }
            if (cmd instanceof MockStopTaskCommand) {
                stops.push(cmd);
                return Promise.resolve({});
            }
            return Promise.resolve({});
        }),
        runs,
        stops,
    };
    return client;
}

function mockLogsClient(script = [], flushScript = []) {
    const queue = [...script];
    const flushQueue = [...flushScript];
    const calls = [];
    const flushCalls = [];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockGetLogEventsCommand) {
                flushCalls.push(cmd);
                const next = flushQueue.length > 0 ? flushQueue.shift() : { events: [] };
                if (next.error) return Promise.reject(next.error);
                return Promise.resolve({ events: next.events || [], nextForwardToken: next.nextForwardToken });
            }
            calls.push(cmd);
            const next = queue.length > 0 ? queue.shift() : { events: [] };
            if (next.error) return Promise.reject(next.error);
            return Promise.resolve({ events: next.events || [] });
        }),
        calls,
        flushCalls,
    };
    return client;
}

function migrateOptions(overrides = {}) {
    return {
        ...baseOptions(),
        projectName: 'myapp',
        region: 'us-east-2',
        cmd: 'npx prisma migrate deploy',
        pollIntervalMs: 5,
        flushIntervalMs: 0,
        ...overrides,
    };
}

describe('Command: db migrate (mocked AWS)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        mockText.mockReset();
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

    function assertNoCmdLeak(cmd) {
        const serialized = JSON.stringify(mockTrackEvent.mock.calls);
        expect(serialized).not.toContain(cmd);
    }

    it('fails fast on invalid --timeout before AWS calls', async () => {
        const ecsClient = mockEcsMigrateClient();
        const result = await runDbMigrate(migrateOptions({ timeout: 'soon', ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('invalid-timeout');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: false, error_code: 'INVALID_TIMEOUT',
        }));
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('fails fast on unexpected positional args with a quoting hint', async () => {
        const ecsClient = mockEcsMigrateClient();
        const result = await runDbMigrate(migrateOptions({
            ecsClient,
            logsClient: mockLogsClient(),
            unexpectedPositionals: ['migrate', 'deploy'],
        }));
        expect(result.reason).toBe('unexpected-positional-args');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('Wrap multi-word --cmd values in quotes');
        expect(ecsClient.send).not.toHaveBeenCalled();
    });

    it('fails headless without --cmd when nothing is detected', async () => {
        const ecsClient = mockEcsMigrateClient();
        const { cmd: _cmd, ...noCmd } = migrateOptions({ ecsClient, logsClient: mockLogsClient() });
        const result = await runDbMigrate(noCmd);
        expect(result.reason).toBe('missing-migration-cmd');
        expect(ecsClient.send).not.toHaveBeenCalled();
        expect(mockText).not.toHaveBeenCalled();
    });

    it('uses the detected command in headless mode', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrate-detect-'));
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { migrate: 'knex migrate' } }));
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const { cmd: _cmd, ...noCmd } = migrateOptions({ cwd: dir, ecsClient, logsClient: mockLogsClient() });
        const result = await runDbMigrate(noCmd);
        expect(result.success).toBe(true);
        expect(ecsClient.runs[0].overrides.containerOverrides[0].command).toEqual(['sh', '-c', 'npm run migrate']);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: true, cmd_source: 'detected', ci_setup: false,
        }));
        assertNoCmdLeak('npm run migrate');
    });

    it('prompts interactively and honors cancellation', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migrate-prompt-'));
        fs.writeFileSync(path.join(dir, 'alembic.ini'), '[alembic]');
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        mockText.mockResolvedValueOnce('alembic upgrade head --verbose');
        const { cmd: _cmd, ...noCmd } = migrateOptions({
            cwd: dir, isHeadless: false, ecsClient, logsClient: mockLogsClient(),
        });
        const result = await runDbMigrate(noCmd);
        expect(result.success).toBe(true);
        expect(mockText).toHaveBeenCalledWith(expect.objectContaining({ initialValue: 'alembic upgrade head' }));
        expect(ecsClient.runs[0].overrides.containerOverrides[0].command[2]).toBe('alembic upgrade head --verbose');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({ cmd_source: 'prompted' }));
        assertNoCmdLeak('alembic upgrade head --verbose');

        mockText.mockResolvedValueOnce(Symbol('clack-cancel'));
        const ecsClient2 = mockEcsMigrateClient();
        const { cmd: _c2, ...noCmd2 } = migrateOptions({
            cwd: dir, isHeadless: false, ecsClient: ecsClient2, logsClient: mockLogsClient(),
        });
        const cancelled = await runDbMigrate(noCmd2);
        expect(cancelled).toEqual(expect.objectContaining({ ok: false, reason: 'cancelled' }));
        expect(ecsClient2.send).not.toHaveBeenCalled();
    });

    it('fails when the service is missing or inactive', async () => {
        const ecsClient = mockEcsMigrateClient({ service: null });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('ecs-service-not-found');
        expect(ecsClient.runs).toHaveLength(0);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: false, error_code: 'ECS_SERVICE_NOT_FOUND', cmd_source: 'explicit',
        }));
    });

    it('fails before RunTask when the container is missing from the task definition', async () => {
        const ecsClient = mockEcsMigrateClient({ taskDefNames: ['sidecar'] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('container-not-found');
        expect(ecsClient.runs).toHaveLength(0);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('--container');
    });

    it('fails when RunTask reports failures', async () => {
        const ecsClient = mockEcsMigrateClient({ runTasks: [], failures: [{ reason: 'RESOURCE:ENI' }] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('run-task-failed');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('RESOURCE:ENI');
    });

    it('uses an explicit --task-def revision for validation and RunTask', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const result = await runDbMigrate(migrateOptions({
            taskDef: 'myapp-task:9', ecsClient, logsClient: mockLogsClient(),
        }));
        expect(result.success).toBe(true);
        const describeInput = ecsClient.send.mock.calls.find(([c]) => c instanceof MockDescribeTaskDefinitionCommand)[0];
        expect(describeInput.taskDefinition).toBe('myapp-task:9');
        expect(ecsClient.runs[0].taskDefinition).toBe('myapp-task:9');
    });

    it('streams deduplicated logs and returns exit 0 on success', async () => {
        const sigintBefore = process.listenerCount('SIGINT');
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), stoppedTask(0)] });
        const logsClient = mockLogsClient([
            { events: [{ eventId: '1', message: 'applying migration 001' }] },
            { events: [{ eventId: '1', message: 'applying migration 001' }, { eventId: '2', message: 'done' }] },
            { events: [] },
        ]);
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result).toEqual(expect.objectContaining({ ok: true, success: true, exitCode: 0, taskArn: MIGRATE_TASK_ARN }));

        const fetchInput = logsClient.calls[0];
        expect(fetchInput.logGroupName).toBe('/ecs/myapp');
        expect(fetchInput.logStreamNames).toEqual(['ecs/myapp-container/migrate123']);

        const text = output.join('\n');
        expect(text.match(/applying migration 001/g)).toHaveLength(1);
        expect(text).toContain('done');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: true, cmd_source: 'explicit', ci_setup: false,
        }));
        assertNoCmdLeak('npx prisma migrate deploy');
        expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    });

    it('ignores ResourceNotFoundException while the stream initializes', async () => {
        const notFound = new Error('stream missing');
        notFound.name = 'ResourceNotFoundException';
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), stoppedTask(0)] });
        const logsClient = mockLogsClient([
            { error: notFound },
            { events: [{ eventId: '7', message: 'late log line' }] },
            { events: [] },
        ]);
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.success).toBe(true);
        expect(output.join('\n')).toContain('late log line');
    });

    it('propagates non-zero exit codes via failCommand', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(3, 'migration boom')] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'migration-task-failed' }));
        expect(exitSpy).toHaveBeenCalledWith(3);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('migration boom');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: false, error_code: 'MIGRATION_TASK_FAILED', exit_code: 3,
        }));
    });

    it('exits 1 with exit_code -1 when no exit code is reported', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(undefined, 'CannotPullContainerError')] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.reason).toBe('migration-task-failed');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({ exit_code: -1 }));
    });

    it('stops the task and fails on timeout', async () => {
        const ecsClient = mockEcsMigrateClient({});
        const result = await runDbMigrate(migrateOptions({
            ecsClient, logsClient: mockLogsClient(), timeoutMs: 30,
        }));
        expect(result.reason).toBe('migration-timeout');
        expect(ecsClient.stops).toHaveLength(1);
        expect(ecsClient.stops[0].task).toBe(MIGRATE_TASK_ARN);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: false, error_code: 'MIGRATION_TIMEOUT',
        }));
    });

    it('stops the task on SIGINT', async () => {
        const ecsClient = mockEcsMigrateClient({});
        const promise = runDbMigrate(migrateOptions({
            ecsClient, logsClient: mockLogsClient(), timeoutMs: 500,
        }));
        await new Promise((resolve) => setTimeout(resolve, 25));
        process.emit('SIGINT');
        await promise;
        expect(ecsClient.stops.length).toBeGreaterThanOrEqual(1);
        expect(ecsClient.stops[0].reason).toContain('SIGINT');
        expect(exitSpy).toHaveBeenCalledWith(130);
    });
});

const WORKFLOW_FIXTURE = `name: Deploy
jobs:
  deploy:
    steps:
      - name: Register new task definition revision
        id: register-task-def
        run: echo hi
      - name: Force ECS deployment
        run: echo deploy
`;

function writeWorkflow(dir, content = WORKFLOW_FIXTURE) {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), content);
    return path.join(dir, '.github', 'workflows', 'deploy.yml');
}

describe('Command: db migrate live-tail fixes (mocked AWS)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        mockText.mockReset();
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

    function spinnerInstance() {
        return mockSpinner.mock.results[mockSpinner.mock.results.length - 1].value;
    }

    function describeTasksCalls(ecsClient) {
        return ecsClient.send.mock.calls.filter(([cmd]) => cmd instanceof MockDescribeTasksCommand);
    }

    it('updates the phase spinner through PROVISIONING/PENDING before streaming', async () => {
        const ecsClient = mockEcsMigrateClient({
            taskSequence: [
                { taskArn: MIGRATE_TASK_ARN, lastStatus: 'PROVISIONING', containers: [] },
                { taskArn: MIGRATE_TASK_ARN, lastStatus: 'PENDING', containers: [] },
                runningTask(),
                stoppedTask(0),
            ],
        });
        const logsClient = mockLogsClient();
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        const spin = spinnerInstance();
        const shortId = MIGRATE_TASK_ARN.split('/').pop().slice(0, 8);
        const messages = spin.message.mock.calls.map((call) => call[0]);
        expect(messages).toEqual([
            `Starting migration task (PROVISIONING, ${shortId})...`,
            `Starting migration task (PENDING, ${shortId})...`,
        ]);
        expect(spin.stop).toHaveBeenCalledWith(expect.stringContaining('Migration container running. Streaming logs...'));
        const text = stripVTControlCharacters(output.join('\n'));
        expect(text).toContain('press Ctrl+C to abort and stop the remote task.');
        expect(text).not.toContain('Ctrl+C cancels (the task is stopped)');
    });

    it('uses a generic spinner message for unexpected pre-RUNNING statuses', async () => {
        const ecsClient = mockEcsMigrateClient({
            taskSequence: [
                { taskArn: MIGRATE_TASK_ARN, lastStatus: 'DEPROVISIONING', containers: [] },
                runningTask(),
                stoppedTask(0),
            ],
        });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(true);
        const messages = spinnerInstance().message.mock.calls.map((call) => call[0]);
        const shortId = MIGRATE_TASK_ARN.split('/').pop().slice(0, 8);
        expect(messages).toEqual([`Waiting on Fargate task (DEPROVISIONING, ${shortId})...`]);
    });

    it('exits early when the migration container stops and stops the task best-effort', async () => {
        const containerDone = {
            taskArn: MIGRATE_TASK_ARN,
            lastStatus: 'RUNNING',
            containers: [{ name: 'myapp-container', lastStatus: 'STOPPED', exitCode: 0 }],
        };
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), containerDone] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(true);
        // Never waited for task STOPPED: only the two scripted polls ran.
        expect(describeTasksCalls(ecsClient)).toHaveLength(2);
        expect(ecsClient.stops).toHaveLength(1);
        expect(String(ecsClient.stops[0].reason)).toContain('Migration container finished');
    });

    it('ignores a sidecar container finishing before the migration container', async () => {
        const sidecarFirst = {
            taskArn: MIGRATE_TASK_ARN,
            lastStatus: 'RUNNING',
            containers: [
                { name: 'otel-sidecar', lastStatus: 'STOPPED', exitCode: 5 },
                { name: 'myapp-container', lastStatus: 'RUNNING' },
            ],
        };
        const migrationDone = {
            taskArn: MIGRATE_TASK_ARN,
            lastStatus: 'RUNNING',
            containers: [
                { name: 'otel-sidecar', lastStatus: 'STOPPED', exitCode: 5 },
                { name: 'myapp-container', lastStatus: 'STOPPED', exitCode: 0 },
            ],
        };
        const ecsClient = mockEcsMigrateClient({ taskSequence: [sidecarFirst, migrationDone] });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(true);
        expect(describeTasksCalls(ecsClient)).toHaveLength(2);
        expect(result.exitCode).toBe(0);
    });

    it('derives the log group and stream prefix from the task definition logConfiguration', async () => {
        const ecsClient = mockEcsMigrateClient({
            taskSequence: [stoppedTask(0)],
            containerDefinitions: [{
                name: 'myapp-container',
                logConfiguration: { options: { 'awslogs-group': '/custom/group', 'awslogs-stream-prefix': 'custom' } },
            }],
        });
        const logsClient = mockLogsClient();
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        expect(logsClient.calls.length).toBeGreaterThan(0);
        expect(logsClient.calls[0].logGroupName).toBe('/custom/group');
        expect(logsClient.calls[0].logStreamNames).toEqual(['custom/myapp-container/migrate123']);
        expect('startTime' in logsClient.calls[0]).toBe(false);
    });

    it('flushes missed lines from the stream head with GetLogEvents on completion', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), stoppedTask(0)] });
        const logsClient = mockLogsClient([], [
            { events: [{ eventId: 'f1', message: 'flushed line' }] },
        ]);
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(1);
        expect(logsClient.flushCalls[0].logStreamName).toBe('ecs/myapp-container/migrate123');
        expect(logsClient.flushCalls[0].startFromHead).toBe(true);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('flushed line');
        // Task already STOPPED: no best-effort StopTask.
        expect(ecsClient.stops).toHaveLength(0);
    });

    it('re-polls the flush while nothing has printed yet, up to the max polls', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const logsClient = mockLogsClient();
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient, maxFlushPolls: 3 }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(3);
    });

    it('stops re-polling the flush as soon as lines print', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const logsClient = mockLogsClient([], [
            { events: [] },
            { events: [{ eventId: 'late', message: 'late line' }] },
        ]);
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient, maxFlushPolls: 6 }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(2);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('late line');
    });

    it('defaults the empty-flush retry loop to six polls', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [stoppedTask(0)] });
        const logsClient = mockLogsClient();
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(6);
    });

    it('prints a line returned by both FilterLogEvents and GetLogEvents only once', async () => {
        const ecsClient = mockEcsMigrateClient({ taskSequence: [runningTask(), stoppedTask(0)] });
        const logsClient = mockLogsClient(
            [{ events: [{ eventId: 'e1', timestamp: 1727440000000, message: 'shared line' }] }],
            [{ events: [{ timestamp: 1727440000000, message: 'shared line' }] }],
        );
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient }));
        expect(result.ok).toBe(true);
        expect(logsClient.flushCalls).toHaveLength(1);
        const text = stripVTControlCharacters(output.join('\n'));
        expect(text.split('shared line').length - 1).toBe(1);
    });

    it('prints the task line only after the spinner stops (no line collision)', async () => {
        const ecsClient = mockEcsMigrateClient({
            taskSequence: [
                { taskArn: MIGRATE_TASK_ARN, lastStatus: 'PROVISIONING', containers: [] },
                runningTask(),
                stoppedTask(0),
            ],
        });
        const result = await runDbMigrate(migrateOptions({ ecsClient, logsClient: mockLogsClient() }));
        expect(result.ok).toBe(true);
        const spin = spinnerInstance();
        const streamStopOrder = spin.stop.mock.invocationCallOrder[0];
        const taskLineIndex = consoleSpy.mock.calls.findIndex((args) => String(args[0]).includes('press Ctrl+C'));
        expect(taskLineIndex).toBeGreaterThanOrEqual(0);
        expect(consoleSpy.mock.invocationCallOrder[taskLineIndex]).toBeGreaterThan(streamStopOrder);
        const shortId = MIGRATE_TASK_ARN.split('/').pop().slice(0, 8);
        expect(spin.message.mock.calls[0][0]).toBe(`Starting migration task (PROVISIONING, ${shortId})...`);
    });
});

describe('db migrate: --setup-ci and gate injection', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        mockText.mockReset();
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

    it('installs the gate after task-def registration without AWS calls', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        const workflowFile = writeWorkflow(dir);
        const throwing = { send: () => { throw new Error('must not call AWS'); } };
        const result = await runDbMigrate(migrateOptions({
            cwd: dir,
            setupCi: true,
            cmd: 'npx prisma migrate deploy',
            ecsClient: throwing,
            logsClient: throwing,
        }));
        expect(result).toEqual(expect.objectContaining({ ok: true, ciSetup: true, workflowFile }));
        const updated = fs.readFileSync(workflowFile, 'utf8');
        expect(updated).toContain('# deploy-stack:db-migrate-start');
        expect(updated).toContain('# deploy-stack:db-migrate-end');
        expect(updated).toContain('actions/setup-node@v4');
        expect(updated).toContain(`--cmd 'npx prisma migrate deploy'`);
        expect(updated).toContain('${{ steps.register-task-def.outputs.task-arn }}');
        expect(updated.indexOf('# deploy-stack:db-migrate-start')).toBeLessThan(updated.indexOf('- name: Force ECS deployment'));
        expect(mockTrackEvent).toHaveBeenCalledWith('db_migrate_run', expect.objectContaining({
            success: true, cmd_source: 'explicit', ci_setup: true,
        }));
    });

    it('is idempotent and refreshes the command on re-runs', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        const workflowFile = writeWorkflow(dir);
        const base = { cwd: dir, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient() };
        await runDbMigrate(migrateOptions({ ...base, cmd: 'first cmd' }));
        await runDbMigrate(migrateOptions({ ...base, cmd: 'second cmd' }));
        const updated = fs.readFileSync(workflowFile, 'utf8');
        expect(updated.match(/# deploy-stack:db-migrate-start/g)).toHaveLength(1);
        expect(updated).toContain(`--cmd 'second cmd'`);
        expect(updated).not.toContain('first cmd');
    });

    it('omits setup-node when the workflow already has it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        writeWorkflow(dir, `jobs:\n  deploy:\n    steps:\n      - uses: actions/setup-node@v4\n      - name: Force ECS deployment\n        run: echo deploy\n`);
        await runDbMigrate(migrateOptions({
            cwd: dir, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient(),
        }));
        const updated = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf8');
        expect(updated.match(/actions\/setup-node/g)).toHaveLength(1);
    });

    it('fails when the workflow is missing or has no anchor step', async () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        const missing = await runDbMigrate(migrateOptions({
            cwd: empty, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient(),
        }));
        expect(missing.reason).toBe('workflow-not-found');

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        writeWorkflow(dir, 'name: Custom\njobs:\n  deploy:\n    steps:\n      - run: echo custom\n');
        const anchored = await runDbMigrate(migrateOptions({
            cwd: dir, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient(),
        }));
        expect(anchored.reason).toBe('workflow-anchor-not-found');
    });

    it('still requires a resolvable command for --setup-ci', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-setup-ci-'));
        writeWorkflow(dir);
        const { cmd: _cmd, ...noCmd } = migrateOptions({
            cwd: dir, setupCi: true, ecsClient: mockEcsMigrateClient(), logsClient: mockLogsClient(),
        });
        const result = await runDbMigrate(noCmd);
        expect(result.reason).toBe('missing-migration-cmd');
    });
});

describe('db migrate: gate helpers', () => {
    it('injectMigrationGate places the block before the Force step', () => {
        const updated = injectMigrationGate(WORKFLOW_FIXTURE, { cmd: 'npm run migrate' });
        expect(updated).toContain(`--cmd 'npm run migrate'`);
        expect(updated).toContain('actions/setup-node@v4');
        expect(updated.indexOf('# deploy-stack:db-migrate-end')).toBeLessThan(updated.indexOf('- name: Force ECS deployment'));
    });

    it('injectMigrationGate returns null without an anchor', () => {
        expect(injectMigrationGate('steps: []', { cmd: 'x' })).toBeNull();
    });

    it('quoteShellArg single-quotes and escapes embedded quotes', () => {
        expect(quoteShellArg('npx prisma migrate deploy')).toBe(`'npx prisma migrate deploy'`);
        expect(quoteShellArg(`don't stop`)).toBe(`'don'\\''t stop'`);
    });
});

function backupOptions(overrides = {}) {
    return {
        ...baseOptions(),
        projectName: 'myapp',
        region: 'us-east-2',
        pollIntervalMs: 5,
        ...overrides,
    };
}

function mockRdsBackupClient({ instance, snapshotScript = [], createError = null } = {}) {
    const resolved = instance === undefined ? healthyDbInstance() : instance;
    const queue = [...snapshotScript];
    const created = [];
    const described = [];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeDBInstancesCommand) {
                return Promise.resolve({ DBInstances: resolved ? [resolved] : [] });
            }
            if (cmd instanceof MockCreateDBSnapshotCommand) {
                created.push(cmd);
                if (createError) return Promise.reject(createError);
                return Promise.resolve({ DBSnapshot: { DBSnapshotIdentifier: cmd.DBSnapshotIdentifier, Status: 'creating' } });
            }
            if (cmd instanceof MockDescribeDBSnapshotsCommand) {
                described.push(cmd);
                const next = queue.length > 0 ? queue.shift() : { snapshots: [] };
                if (next.error) return Promise.reject(next.error);
                return Promise.resolve({ DBSnapshots: next.snapshots || [] });
            }
            return Promise.resolve({});
        }),
        created,
        described,
    };
    return client;
}

describe('Command: db backup (mocked AWS)', () => {
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

    it('rejects invalid --id and --timeout before AWS calls', async () => {
        const rdsClient = mockRdsBackupClient();
        const badId = await runDbBackup(backupOptions({ snapshotId: 'bad--id-', rdsClient }));
        expect(badId.reason).toBe('invalid-snapshot-id');
        expect(rdsClient.send).not.toHaveBeenCalled();

        const badTimeout = await runDbBackup(backupOptions({ timeout: 'never', rdsClient }));
        expect(badTimeout.reason).toBe('invalid-timeout');
        expect(rdsClient.send).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('fails when no database is provisioned', async () => {
        const rdsClient = mockRdsBackupClient({ instance: null });
        const result = await runDbBackup(backupOptions({ rdsClient }));
        expect(result.reason).toBe('rds-instance-not-found');
        expect(rdsClient.created).toHaveLength(0);
        const spin = mockSpinner.mock.results[mockSpinner.mock.results.length - 1].value;
        expect(spin.stop).toHaveBeenCalledWith();
        const text = stripVTControlCharacters(output.join('\n'));
        expect(text).toContain('No database found');
        expect(text.split('No database found').length - 1).toBe(1);
    });

    it('returns immediately with --no-wait', async () => {
        const rdsClient = mockRdsBackupClient();
        const result = await runDbBackup(backupOptions({ snapshotId: 'pre-migrate', noWait: true, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'pre-migrate', status: 'creating' });
        expect(rdsClient.created).toHaveLength(1);
        const create = rdsClient.created[0];
        expect(create.DBInstanceIdentifier).toBe('myapp-db');
        expect(create.DBSnapshotIdentifier).toBe('pre-migrate');
        expect(create.Tags).toEqual([
            { Key: 'ManagedBy', Value: 'deploy-stack' },
            { Key: 'Project', Value: 'myapp' },
        ]);
        expect(rdsClient.described).toHaveLength(0);
        expect(mockTrackEvent).toHaveBeenCalledWith('db_backup_run', expect.objectContaining({
            success: true, waited: false,
        }));
    });

    it('generates a timestamped id by default', async () => {
        const rdsClient = mockRdsBackupClient();
        const result = await runDbBackup(backupOptions({ noWait: true, rdsClient }));
        expect(result.snapshotId).toMatch(/^myapp-db-manual-\d{8}-\d{6}$/);
    });

    it('polls until the snapshot is available', async () => {
        const rdsClient = mockRdsBackupClient({
            snapshotScript: [
                { snapshots: [{ DBSnapshotIdentifier: 's1', Status: 'creating' }] },
                { snapshots: [{ DBSnapshotIdentifier: 's1', Status: 'available' }] },
            ],
        });
        const result = await runDbBackup(backupOptions({ snapshotId: 's1', rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 's1', status: 'available' });
        expect(rdsClient.described.length).toBeGreaterThanOrEqual(2);
        expect(stripVTControlCharacters(output.join('\n'))).toContain('npx deploy-stack db restore s1');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_backup_run', expect.objectContaining({
            success: true, waited: true,
        }));
    });

    it('tolerates eventual-consistency not-found errors while polling', async () => {
        const notFound = new Error('not yet visible');
        notFound.name = 'DBSnapshotNotFound';
        const rdsClient = mockRdsBackupClient({
            snapshotScript: [
                { error: notFound },
                { snapshots: [{ DBSnapshotIdentifier: 's1', Status: 'available' }] },
            ],
        });
        const result = await runDbBackup(backupOptions({ snapshotId: 's1', rdsClient }));
        expect(result.status).toBe('available');
    });

    it('fails on timeout while creation continues in the background', async () => {
        const rdsClient = mockRdsBackupClient({
            snapshotScript: Array.from({ length: 50 }, () => ({ snapshots: [{ DBSnapshotIdentifier: 's1', Status: 'creating' }] })),
        });
        const result = await runDbBackup(backupOptions({ snapshotId: 's1', rdsClient, timeoutMs: 20 }));
        expect(result.reason).toBe('snapshot-timeout');
        expect(result.snapshotId).toBe('s1');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('continues in the background');
    });

    it('propagates quota and state errors from CreateDBSnapshot', async () => {
        const quota = new Error('quota exceeded');
        quota.name = 'SnapshotQuotaExceeded';
        const rdsClient = mockRdsBackupClient({ createError: quota });
        const result = await runDbBackup(backupOptions({ rdsClient }));
        expect(result.reason).toBe('error');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_backup_run', expect.objectContaining({
            success: false, error_code: 'SnapshotQuotaExceeded',
        }));
    });
});

const DATABASE_TF_FIXTURE = `resource "aws_db_instance" "postgres" {
  identifier          = "myapp-db"
  engine              = "postgres"
  skip_final_snapshot = true
}
`;

function writeDatabaseTf(dir, content = DATABASE_TF_FIXTURE) {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'terraform', 'database.tf'), content);
    return path.join(dir, 'terraform', 'database.tf');
}

function snapshotFixture(id, overrides = {}) {
    return {
        DBSnapshotIdentifier: id,
        Status: 'available',
        SnapshotCreateTime: new Date('2026-05-01T10:00:00.000Z'),
        AllocatedStorage: 20,
        SnapshotType: 'manual',
        ...overrides,
    };
}

function mockRdsRestoreClient({ pages = [], byId = {} } = {}) {
    const queue = [...pages];
    const instanceCalls = [];
    const idCalls = [];
    const client = {
        send: vi.fn((cmd) => {
            if (cmd instanceof MockDescribeDBSnapshotsCommand) {
                if (cmd.DBSnapshotIdentifier) {
                    idCalls.push(cmd);
                    const found = byId[cmd.DBSnapshotIdentifier];
                    if (!found) {
                        const err = new Error('not found');
                        err.name = 'DBSnapshotNotFound';
                        return Promise.reject(err);
                    }
                    return Promise.resolve({ DBSnapshots: [found] });
                }
                instanceCalls.push(cmd);
                const page = queue.length > 0 ? queue.shift() : [];
                return Promise.resolve({ DBSnapshots: page, Marker: queue.length > 0 ? 'next-marker' : undefined });
            }
            return Promise.resolve({});
        }),
        instanceCalls,
        idCalls,
    };
    return client;
}

function restoreOptions(overrides = {}) {
    return {
        ...baseOptions(),
        projectName: 'myapp',
        region: 'us-east-2',
        ...overrides,
    };
}

describe('Command: db restore (mocked AWS)', () => {
    let exitSpy;
    let consoleSpy;
    let output;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSelect.mockReset();
        mockConfirm.mockReset();
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

    it('fails on a missing database.tf before AWS calls', async () => {
        const rdsClient = mockRdsRestoreClient();
        const result = await runDbRestore(restoreOptions({ rdsClient }));
        expect(result.reason).toBe('database-tf-not-found');
        expect(rdsClient.send).not.toHaveBeenCalled();
    });

    it('fails when no snapshots exist', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const rdsClient = mockRdsRestoreClient({ pages: [[]] });
        const result = await runDbRestore(restoreOptions({ cwd: dir, rdsClient }));
        expect(result.reason).toBe('no-snapshots-found');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('npx deploy-stack db backup');
    });

    it('requires a snapshot id and confirmation in headless mode', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const missing = await runDbRestore(restoreOptions({
            cwd: dir, rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1')]] }),
        }));
        expect(missing.reason).toBe('missing-snapshot-id');
        expect(mockSelect).not.toHaveBeenCalled();

        const unconfirmed = await runDbRestore(restoreOptions({
            cwd: dir,
            snapshotId: 's1',
            rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1')]] }),
        }));
        expect(unconfirmed.reason).toBe('confirmation-required');
        expect(mockConfirm).not.toHaveBeenCalled();
    });

    it('restores by positional id with --yes and pins the snapshot in HCL', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        const tfFile = writeDatabaseTf(dir);
        const rdsClient = mockRdsRestoreClient({ pages: [[snapshotFixture('snap-1')]] });
        const result = await runDbRestore(restoreOptions({ cwd: dir, snapshotId: 'snap-1', yes: true, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'snap-1' });
        const updated = fs.readFileSync(tfFile, 'utf8');
        expect(updated).toContain('snapshot_identifier = "snap-1"');
        expect(updated).toContain('keep snapshot_identifier');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('npx deploy-stack apply');
        expect(mockTrackEvent).toHaveBeenCalledWith('db_restore_run', expect.objectContaining({ success: true }));
    });

    it('falls back to a direct lookup for snapshots from replaced instances', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const orphan = snapshotFixture('orphan-snap');
        const rdsClient = mockRdsRestoreClient({ pages: [[]], byId: { 'orphan-snap': orphan } });
        const result = await runDbRestore(restoreOptions({ cwd: dir, snapshotId: 'orphan-snap', yes: true, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'orphan-snap' });
        expect(rdsClient.idCalls).toHaveLength(1);
        expect(rdsClient.idCalls[0].DBSnapshotIdentifier).toBe('orphan-snap');
    });

    it('rejects unknown ids and non-available snapshots', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const unknown = await runDbRestore(restoreOptions({
            cwd: dir, snapshotId: 'nope', yes: true, rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('other')]] }),
        }));
        expect(unknown.reason).toBe('snapshot-not-available');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('not found');

        const pending = await runDbRestore(restoreOptions({
            cwd: dir,
            snapshotId: 's1',
            yes: true,
            rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1', { Status: 'pending' })]] }),
        }));
        expect(pending.reason).toBe('snapshot-not-available');
    });

    it('follows pagination markers across snapshot pages', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const rdsClient = mockRdsRestoreClient({ pages: [[snapshotFixture('page-1')], [snapshotFixture('page-2')]] });
        const result = await runDbRestore(restoreOptions({ cwd: dir, snapshotId: 'page-2', yes: true, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'page-2' });
        expect(rdsClient.instanceCalls).toHaveLength(2);
        expect(rdsClient.instanceCalls[1].Marker).toBe('next-marker');
    });

    it('offers an interactive picker sorted newest-first', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        writeDatabaseTf(dir);
        const older = snapshotFixture('older', { SnapshotCreateTime: new Date('2026-04-01T10:00:00.000Z') });
        const newer = snapshotFixture('newer', { SnapshotCreateTime: new Date('2026-06-01T10:00:00.000Z'), SnapshotType: 'automated' });
        const rdsClient = mockRdsRestoreClient({ pages: [[older, newer]] });
        mockSelect.mockResolvedValueOnce('older');
        mockConfirm.mockResolvedValueOnce(true);
        const result = await runDbRestore(restoreOptions({ cwd: dir, isHeadless: false, rdsClient }));
        expect(result).toEqual({ ok: true, snapshotId: 'older' });
        const promptOptions = mockSelect.mock.calls[0][0].options;
        expect(promptOptions.map((o) => o.value)).toEqual(['newer', 'older']);
        expect(promptOptions[0].hint).toContain('2026-06-01');
        expect(promptOptions[0].hint).toContain('20GB');
        expect(promptOptions[0].hint).toContain('automated');
        expect(stripVTControlCharacters(output.join('\n'))).toContain('skip_final_snapshot = true');
    });

    it('aborts cleanly when the confirmation is declined or cancelled', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-restore-'));
        const tfFile = writeDatabaseTf(dir);
        mockSelect.mockResolvedValueOnce('s1');
        mockConfirm.mockResolvedValueOnce(false);
        const declined = await runDbRestore(restoreOptions({
            cwd: dir,
            isHeadless: false,
            rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1')]] }),
        }));
        expect(declined).toEqual(expect.objectContaining({ ok: false, reason: 'cancelled' }));
        expect(fs.readFileSync(tfFile, 'utf8')).toBe(DATABASE_TF_FIXTURE);

        mockSelect.mockResolvedValueOnce(Symbol('clack-cancel'));
        const cancelled = await runDbRestore(restoreOptions({
            cwd: dir,
            isHeadless: false,
            rdsClient: mockRdsRestoreClient({ pages: [[snapshotFixture('s1')]] }),
        }));
        expect(cancelled).toEqual(expect.objectContaining({ ok: false, reason: 'cancelled' }));
    });
});

describe('db restore: upsertSnapshotIdentifier', () => {
    it('inserts the attribute after identifier with a keep-in-place comment', () => {
        const updated = upsertSnapshotIdentifier(DATABASE_TF_FIXTURE, 'snap-1');
        expect(updated).toContain('snapshot_identifier = "snap-1"');
        expect(updated).toContain('keep snapshot_identifier');
        expect(updated.indexOf('snapshot_identifier')).toBeGreaterThan(updated.indexOf('identifier          = "myapp-db"'));
    });

    it('replaces an existing attribute and stays idempotent', () => {
        const once = upsertSnapshotIdentifier(DATABASE_TF_FIXTURE, 'snap-1');
        const twice = upsertSnapshotIdentifier(once, 'snap-2');
        expect(twice).toContain('snapshot_identifier = "snap-2"');
        expect(twice).not.toContain('snap-1');
        expect(twice.match(/snapshot_identifier =/g)).toHaveLength(1);
        expect(upsertSnapshotIdentifier(twice, 'snap-2')).toBe(twice);
    });

    it('scopes edits to the postgres resource block only', () => {
        const hcl = `${DATABASE_TF_FIXTURE}\nresource "aws_db_instance" "other" {\n  identifier = "other"\n}\n`;
        const updated = upsertSnapshotIdentifier(hcl, 'snap-1');
        expect(updated.match(/snapshot_identifier =/g)).toHaveLength(1);
        expect(updated.indexOf('snapshot_identifier')).toBeLessThan(updated.indexOf('resource "aws_db_instance" "other"'));
    });

    it('returns content unchanged when the resource is missing', () => {
        expect(upsertSnapshotIdentifier('resource "aws_s3_bucket" "x" {}', 'snap-1'))
            .toBe('resource "aws_s3_bucket" "x" {}');
    });
});

describe('db: fuzzer hardening', () => {
    let exitSpy;
    let consoleSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    });

    afterEach(() => {
        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    it.each([
        ['runDbConnect', runDbConnect, 'db_connect_run'],
        ['runDbMigrate', runDbMigrate, 'db_migrate_run'],
        ['runDbBackup', runDbBackup, 'db_backup_run'],
        ['runDbRestore', runDbRestore, 'db_restore_run'],
    ])('%s routes unresolvable projects through PROJECT_NOT_INITIALIZED', async (_name, run, event) => {
        const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('deleted'); });
        try {
            const result = await run(null);
            expect(result).toEqual({ ok: false, reason: 'project-not-initialized' });
            expect(exitSpy).toHaveBeenCalledWith(1);
            expect(mockTrackEvent).toHaveBeenCalledWith(event, expect.objectContaining({
                success: false,
                error_code: 'PROJECT_NOT_INITIALIZED',
            }));
        } finally {
            cwdSpy.mockRestore();
        }
    });
});
