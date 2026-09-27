import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    findDbInstance,
    generateSnapshotId,
    isValidSnapshotId,
    resolveDbIdentifier,
} from '../src/utils/rds.js';

const { MockDescribeDBInstancesCommand } = vi.hoisted(() => ({
    MockDescribeDBInstancesCommand: vi.fn(function (input) { Object.assign(this, input); }),
}));

vi.mock('@aws-sdk/client-rds', () => ({
    RDSClient: vi.fn(function () { this.send = vi.fn(); }),
    DescribeDBInstancesCommand: MockDescribeDBInstancesCommand,
}));

function mockClient(handler) {
    return { send: vi.fn(handler) };
}

describe('findDbInstance', () => {
    it('returns the instance for an exact identifier match', async () => {
        const instance = { DBInstanceIdentifier: 'myapp-db' };
        const client = mockClient(() => Promise.resolve({ DBInstances: [instance] }));
        await expect(findDbInstance(client, 'myapp-db')).resolves.toBe(instance);
        const input = client.send.mock.calls[0][0];
        expect(input.DBInstanceIdentifier).toBe('myapp-db');
    });

    it('returns null when no instances are returned', async () => {
        const client = mockClient(() => Promise.resolve({ DBInstances: [] }));
        await expect(findDbInstance(client, 'myapp-db')).resolves.toBeNull();
    });

    it.each(['DBInstanceNotFound', 'DBInstanceNotFoundFault'])('returns null on %s', async (name) => {
        const err = new Error('missing');
        err.name = name;
        const client = mockClient(() => Promise.reject(err));
        await expect(findDbInstance(client, 'myapp-db')).resolves.toBeNull();
    });

    it('rethrows unexpected errors', async () => {
        const err = new Error('boom');
        err.name = 'AccessDenied';
        const client = mockClient(() => Promise.reject(err));
        await expect(findDbInstance(client, 'myapp-db')).rejects.toBe(err);
    });
});

describe('generateSnapshotId', () => {
    it('formats the UTC timestamp suffix', () => {
        const now = new Date(Date.UTC(2026, 4, 9, 7, 8, 9));
        expect(generateSnapshotId('myapp-db', now)).toBe('myapp-db-manual-20260509-070809');
    });

    it('lowercases the identifier', () => {
        const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
        expect(generateSnapshotId('MyApp-DB', now)).toBe('myapp-db-manual-20260101-000000');
    });

    it('produces a valid snapshot id by default', () => {
        expect(isValidSnapshotId(generateSnapshotId('myapp-db'))).toBe(true);
    });
});

describe('isValidSnapshotId', () => {
    it.each([
        'a',
        'snap1',
        'myapp-db-manual-20260509-070809',
        'A-valid-ID-123',
        'x'.repeat(255),
    ])('accepts %s', (id) => {
        expect(isValidSnapshotId(id)).toBe(true);
    });

    it.each([
        '',
        '1abc',
        '-abc',
        'has space',
        'has_underscore',
        'has--double-hyphen',
        'trailing-',
        'x'.repeat(256),
        undefined,
        null,
        123,
    ])('rejects %s', (id) => {
        expect(isValidSnapshotId(id)).toBe(false);
    });
});

describe('resolveDbIdentifier', () => {
    it('prefers an explicit --db-identifier override', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        expect(resolveDbIdentifier({ projectName: 'myapp', dbIdentifier: '  custom-db  ' }, dir)).toBe('custom-db');
    });

    it('resolves the project default with workspace suffixes', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        expect(resolveDbIdentifier({ projectName: 'myapp' }, dir)).toBe('myapp-db');
        expect(resolveDbIdentifier({ projectName: 'myapp', workspace: 'pr-1' }, dir)).toBe('myapp-pr-1-db');
    });

    it('auto-detects the workspace from .terraform/environment', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        fs.mkdirSync(path.join(dir, '.terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.terraform', 'environment'), 'pr-42\n');
        expect(resolveDbIdentifier({ projectName: 'myapp' }, dir)).toBe('myapp-pr-42-db');
    });

    it('survives synthetic fuzzer inputs', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-id-'));
        for (const bad of [null, undefined, 'string', 42, true, { port: 'string' }]) {
            expect(resolveDbIdentifier(bad, dir)).toBe(resolveDbIdentifier({}, dir));
        }
        expect(resolveDbIdentifier({ projectName: 'myapp' }, 42)).toBe(resolveDbIdentifier({ projectName: 'myapp' }));
        expect(resolveDbIdentifier({ projectName: 'myapp', cwd: 42 }, dir)).toBe('myapp-db');
    });
});
