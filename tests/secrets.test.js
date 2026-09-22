import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { pushSecrets, pullSecrets, auditSecrets } from '../src/commands/secrets.js';
import { trackEvent } from '../src/core/telemetry.js';

// 1. Use vi.hoisted() so these variables are available when vi.mock() runs at the top of the file
const { mockSend, MockSecretsManagerClient, MockUpdateSecretCommand, MockGetSecretValueCommand } = vi.hoisted(() => {
    const sendFn = vi.fn().mockResolvedValue({});
    return {
        mockSend: sendFn,
        MockSecretsManagerClient: vi.fn(function (config) {
            this.config = config;
            this.send = sendFn;
        }),
        MockUpdateSecretCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
        MockGetSecretValueCommand: vi.fn(function (input) {
            Object.assign(this, input);
        })
    };
});

const { mockConfirm, mockOutro, mockSpinnerStart, mockSpinnerStop } = vi.hoisted(() => ({
    mockConfirm: vi.fn(),
    mockOutro: vi.fn(),
    mockSpinnerStart: vi.fn(),
    mockSpinnerStop: vi.fn(),
}));

const { mockEcsSend, MockECSClient, MockUpdateServiceCommand } = vi.hoisted(() => {
    const ecsSendFn = vi.fn().mockResolvedValue({});
    return {
        mockEcsSend: ecsSendFn,
        MockECSClient: vi.fn(function (config) {
            this.config = config;
            this.send = ecsSendFn;
        }),
        MockUpdateServiceCommand: vi.fn(function (input) {
            Object.assign(this, input);
        }),
    };
});

// 2. Inject the hoisted mocks into the AWS SDK
vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: MockSecretsManagerClient,
    UpdateSecretCommand: MockUpdateSecretCommand,
    GetSecretValueCommand: MockGetSecretValueCommand
}));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: MockECSClient,
    UpdateServiceCommand: MockUpdateServiceCommand,
}));

// 3. Mock @clack/prompts to prevent hangs on user input during testing
vi.mock('@clack/prompts', () => ({
    spinner: vi.fn(() => ({ start: mockSpinnerStart, stop: mockSpinnerStop, message: vi.fn() })),
    confirm: (...args) => mockConfirm(...args),
    outro: (...args) => mockOutro(...args),
    intro: vi.fn(),
}));

// 4. Mock telemetry to prevent real network calls during testing
vi.mock('../src/core/telemetry.js', () => ({
    trackEvent: vi.fn(),
    flushTelemetry: vi.fn().mockResolvedValue(),
}));

describe('Secrets Push Command', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-secrets-env');

    beforeEach(async () => {
        // Create a fake project directory and step into it
        await fs.mkdir(path.join(testDir, 'terraform'), { recursive: true });
        process.chdir(testDir);
        mockConfirm.mockReset();
        mockConfirm.mockResolvedValue(false);
        mockEcsSend.mockReset();
        mockEcsSend.mockResolvedValue({});
    });

    afterEach(async () => {
        // Step back out, clean up the files, and reset mocks
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({}); // Reset to default success state
        mockEcsSend.mockReset();
        mockEcsSend.mockResolvedValue({});
    });

    it('reads .env, pushes to AWS, and writes secret_keys.json', async () => {
        // Setup: Create a fake .env and a fake main.tf (to test region extraction)
        await fs.writeFile('.env', 'GITHUB_TOKEN=ghp_12345\nDB_PASS=supersecret');
        await fs.writeFile(path.join('terraform', 'main.tf'), 'region = "us-east-2"');

        // Execute the CLI command
        await pushSecrets('.env', 'my-project');

        // Assert 1: Did we initialize the AWS client with the correct region from main.tf?
        expect(MockSecretsManagerClient).toHaveBeenCalledWith({ region: 'us-east-2' });

        // Assert 2: Did we package the exact right payload for AWS?
        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ GITHUB_TOKEN: 'ghp_12345', DB_PASS: 'supersecret' })
        });

        // Assert 3: Did we write the keys to the local JSON file for Terraform to use?
        const keysPath = path.join('terraform', 'secret_keys.json');
        const keysContent = await fs.readFile(keysPath, 'utf-8');
        expect(JSON.parse(keysContent)).toEqual(['GITHUB_TOKEN', 'DB_PASS']);
    });

    it('handles a missing AWS vault (ResourceNotFoundException) gracefully', async () => {
        // Setup: GetSecretValue finds no vault (new vault path), then UpdateSecret also fails
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'Vault missing' });
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'Vault missing' });
        await fs.writeFile('.env', 'API_KEY=123');

        // We must mock process.exit so the test runner doesn't crash when the CLI tries to exit
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        // Execute
        await pushSecrets('.env', 'my-project');

        // Assert: Ensure the CLI caught the error and attempted a clean exit
        expect(exitSpy).toHaveBeenCalledWith(1);

        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });

    it('gracefully falls back to .env when envFilePath is undefined or omitted', async () => {
        // Create default .env file
        await fs.writeFile('.env', 'DATABASE_URL=postgres://localhost:5432/db');
        await fs.writeFile(path.join('terraform', 'main.tf'), 'region = "us-east-1"');

        // Call pushSecrets with undefined/omitted argument
        await pushSecrets(undefined, 'my-project');

        // Verify it resolved .env properly and sent secrets
        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ DATABASE_URL: 'postgres://localhost:5432/db' })
        });
    });

    it('gracefully falls back to .env when envFilePath is passed as an object or invalid type', async () => {
        // Simulates Commander passing an options object as the first parameter
        await fs.writeFile('.env', 'STRIPE_KEY=sk_test_12345');
        await fs.writeFile(path.join('terraform', 'main.tf'), 'region = "us-east-1"');

        // Call pushSecrets with an object
        await pushSecrets({}, 'my-project');

        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ STRIPE_KEY: 'sk_test_12345' })
        });
    });

    it('guards against CI injection and defaults to .env if the filename lacks a standard extension', async () => {
        // Setup default .env file
        await fs.writeFile('.env', 'CI_INJECTION_GUARD=success');
        await fs.writeFile(path.join('terraform', 'main.tf'), 'region = "us-east-1"');

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        // Execute with "event" (simulating a GitHub Actions ${{ github.event_name }} bug)
        await pushSecrets('event', 'my-project');

        // Assert warning was printed and it successfully read from .env instead
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('does not look like a standard secrets file'));
        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ CI_INJECTION_GUARD: 'success' })
        });

        consoleSpy.mockRestore();
    });

    it('keeps the GitHub commit guidance and skips ECS restart when keys changed', async () => {
        await fs.writeFile('.env', 'NEW_KEY=abc\nOTHER=xyz');
        await fs.writeFile(path.join('terraform', 'main.tf'), 'region = "us-east-1"');
        // Existing vault holds a different key set (addition + deletion)
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ OLD_KEY: '1', OTHER: 'old' }) });
        mockSend.mockResolvedValueOnce({});

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await pushSecrets('.env', 'my-project');

        expect(MockGetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'my-project-secrets' });
        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ NEW_KEY: 'abc', OTHER: 'xyz' })
        });
        // Keys changed: instruct the user to commit secret_keys.json, do not prompt for ECS restart
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Commit this file and push to GitHub'));
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(MockECSClient).not.toHaveBeenCalled();
        expect(mockEcsSend).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ keysChanged: true }));

        consoleSpy.mockRestore();
    });

    it('prompts for and triggers a rolling ECS restart when only values changed', async () => {
        await fs.writeFile('.env', 'API_KEY=newvalue\nDB_PASS=newsecret');
        await fs.writeFile(path.join('terraform', 'main.tf'), 'region = "us-east-1"');
        // Existing vault holds the identical key set with older values
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'oldvalue', DB_PASS: 'oldsecret' }) });
        mockSend.mockResolvedValueOnce({});
        mockConfirm.mockResolvedValueOnce(true);

        const result = await pushSecrets('.env', 'my-project');

        expect(MockGetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'my-project-secrets' });
        expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Keys are unchanged. Trigger a rolling ECS restart to apply new values immediately?',
        }));
        expect(MockECSClient).toHaveBeenCalledWith({ region: 'us-east-1' });
        expect(MockUpdateServiceCommand).toHaveBeenCalledWith({
            cluster: 'my-project-cluster',
            service: 'my-project-service',
            forceNewDeployment: true,
        });
        expect(mockEcsSend).toHaveBeenCalledTimes(1);
        expect(mockSpinnerStart).toHaveBeenCalledWith('Triggering rolling ECS restart...');
        expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining('Rolling restart initiated'));
        expect(result).toEqual(expect.objectContaining({ keysChanged: false, restarted: true }));
    });

    it('skips the ECS restart when keys are identical but the user declines', async () => {
        await fs.writeFile('.env', 'API_KEY=newvalue');
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'oldvalue' }) });
        mockSend.mockResolvedValueOnce({});
        mockConfirm.mockResolvedValueOnce(false);

        const result = await pushSecrets('.env', 'my-project');

        expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Keys are unchanged. Trigger a rolling ECS restart to apply new values immediately?',
        }));
        expect(mockEcsSend).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ keysChanged: false }));
    });

    it('treats a new vault (ResourceNotFoundException on fetch) as keys changed', async () => {
        await fs.writeFile('.env', 'FRESH_KEY=1');
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'missing' });
        mockSend.mockResolvedValueOnce({});

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await pushSecrets('.env', 'my-project');

        expect(MockUpdateSecretCommand).toHaveBeenCalledWith({
            SecretId: 'my-project-secrets',
            SecretString: JSON.stringify({ FRESH_KEY: '1' })
        });
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Commit this file and push to GitHub'));
        expect(mockConfirm).not.toHaveBeenCalled();
        expect(mockEcsSend).not.toHaveBeenCalled();
        expect(result).toEqual(expect.objectContaining({ keysChanged: true }));

        consoleSpy.mockRestore();
    });
});

describe('Secrets Pull Command', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-secrets-pull-audit');

    beforeEach(async () => {
        await fs.mkdir(path.join(testDir, 'terraform'), { recursive: true });
        process.chdir(testDir);
        mockConfirm.mockReset();
        mockConfirm.mockResolvedValue(true);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({});
    });

    it('creates .env from remote payload when local file is missing', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'abc', DB_PASS: 'xyz' }) });
        await fs.writeFile(path.join('terraform', 'main.tf'), 'region = "us-east-2"');

        const result = await pullSecrets('.env', 'my-project', { isHeadless: true });

        expect(MockGetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'my-project-secrets' });
        expect(MockSecretsManagerClient).toHaveBeenCalledWith({ region: 'us-east-2' });
        expect(mockConfirm).not.toHaveBeenCalled();

        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('API_KEY="abc"');
        expect(content).toContain('DB_PASS="xyz"');
        expect(result.synced).toBe(2);
        expect(mockSpinnerStart).toHaveBeenCalledWith('Fetching secrets from AWS...');
        expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining('Successfully synced 2 secrets to .env'));
        expect(trackEvent).toHaveBeenCalledWith('secrets_pull', expect.objectContaining({ variablesCount: 2 }));
    });

    it('asks to overwrite and applies remote values when confirm returns true', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'remote', NEW_KEY: 'new' }) });
        await fs.writeFile('.env', 'API_KEY=local\nLOCAL_ONLY=keep');
        mockConfirm.mockResolvedValueOnce(true);

        await pullSecrets('.env', 'my-project');

        expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
            message: expect.stringContaining('Overwrite local values with remote'),
        }));
        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('API_KEY="remote"');
        expect(content).toContain('NEW_KEY="new"');
        expect(content).toContain('LOCAL_ONLY="keep"');
    });

    it('preserves local values for conflicts when confirm returns false', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'remote', NEW_KEY: 'new' }) });
        await fs.writeFile('.env', 'API_KEY=local\nLOCAL_ONLY=keep');
        mockConfirm.mockResolvedValueOnce(false);

        const result = await pullSecrets('.env', 'my-project');

        expect(result.overwritten).toBe(false);
        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('API_KEY="local"');
        expect(content).toContain('NEW_KEY="new"');
        expect(content).toContain('LOCAL_ONLY="keep"');
    });

    it('auto-overwrites conflicts in headless mode without prompting', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ API_KEY: 'remote' }) });
        await fs.writeFile('.env', 'API_KEY=local');

        await pullSecrets('.env', 'my-project', { isHeadless: true });

        expect(mockConfirm).not.toHaveBeenCalled();
        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('API_KEY="remote"');
    });

    it('defaults to .env when file argument is omitted', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ A: '1' }) });

        await pullSecrets(undefined, 'my-project', { isHeadless: true });

        const content = await fs.readFile('.env', 'utf-8');
        expect(content).toContain('A="1"');
    });

    it('handles missing remote vault by suggesting secrets push', async () => {
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'missing' });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        await pullSecrets('.env', 'my-project', { isHeadless: true });

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('secrets push'));

        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });
});

describe('Secrets Audit Command', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-secrets-pull-audit');

    beforeEach(async () => {
        await fs.mkdir(path.join(testDir, 'terraform'), { recursive: true });
        process.chdir(testDir);
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({});
    });

    it('reports missing, mismatched, and untracked keys with drift count', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ SAME: '1', CHANGED: 'remote', ONLY_REMOTE: 'x' }) });
        await fs.writeFile('.env', 'SAME=1\nCHANGED=local\nONLY_LOCAL=y');
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await auditSecrets('.env', 'my-project');

        expect(MockGetSecretValueCommand).toHaveBeenCalledWith({ SecretId: 'my-project-secrets' });
        expect(mockSpinnerStart).toHaveBeenCalledWith('Auditing local environment against AWS...');
        expect(result).toEqual({
            missingLocally: ['ONLY_REMOTE'],
            mismatched: ['CHANGED'],
            untrackedLocally: ['ONLY_LOCAL'],
            driftCount: 3,
        });
        expect(trackEvent).toHaveBeenCalledWith('secrets_audit', expect.objectContaining({ driftCount: 3 }));
        expect(mockOutro).toHaveBeenCalledWith(expect.stringContaining('3 drifted variable(s)'));

        consoleSpy.mockRestore();
    });

    it('reports in-sync when local matches remote', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ A: '1' }) });
        await fs.writeFile('.env', 'A=1');
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await auditSecrets('.env', 'my-project');

        expect(result.driftCount).toBe(0);
        expect(trackEvent).toHaveBeenCalledWith('secrets_audit', expect.objectContaining({ driftCount: 0 }));

        consoleSpy.mockRestore();
    });

    it('treats a missing local file as fully missing locally', async () => {
        mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ A: '1', B: '2' }) });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        const result = await auditSecrets('.env', 'my-project');

        expect(result.missingLocally).toEqual(['A', 'B']);
        expect(result.driftCount).toBe(2);

        consoleSpy.mockRestore();
    });

    it('handles missing remote vault by suggesting secrets push', async () => {
        mockSend.mockRejectedValueOnce({ name: 'ResourceNotFoundException', message: 'missing' });
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });

        await auditSecrets('.env', 'my-project');

        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('secrets push'));

        exitSpy.mockRestore();
        consoleSpy.mockRestore();
    });
});
