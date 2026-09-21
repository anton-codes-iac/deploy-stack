import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { pushSecrets } from '../src/commands/secrets.js';

// 1. Use vi.hoisted() so these variables are available when vi.mock() runs at the top of the file
const { mockSend, MockSecretsManagerClient, MockUpdateSecretCommand } = vi.hoisted(() => {
    const sendFn = vi.fn().mockResolvedValue({});
    return {
        mockSend: sendFn,
        MockSecretsManagerClient: vi.fn(function (config) {
            this.config = config;
            this.send = sendFn;
        }),
        MockUpdateSecretCommand: vi.fn(function (input) {
            Object.assign(this, input);
        })
    };
});

// 2. Inject the hoisted mocks into the AWS SDK
vi.mock('@aws-sdk/client-secrets-manager', () => ({
    SecretsManagerClient: MockSecretsManagerClient,
    UpdateSecretCommand: MockUpdateSecretCommand
}));

// 3. Mock telemetry to prevent real network calls during testing
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
    });

    afterEach(async () => {
        // Step back out, clean up the files, and reset mocks
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
        mockSend.mockReset();
        mockSend.mockResolvedValue({}); // Reset to default success state
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
        // Setup: Force the mocked send method to reject
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
});