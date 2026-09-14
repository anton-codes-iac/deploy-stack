import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { syncAi } from '../src/commands/sync-ai.js';

// 1. Mock the interactive prompts to simulate user input
vi.mock('@clack/prompts', () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    // Simulate the user selecting 'claude' from the list and hitting Enter
    multiselect: vi.fn().mockResolvedValue(['claude']),
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
    log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() }
}));

// 2. Mock telemetry to prevent real network calls
vi.mock('../src/core/telemetry.js', () => ({
    trackEvent: vi.fn(),
    flushTelemetry: vi.fn().mockResolvedValue(),
}));

describe('AI Context Synchronization', () => {
    const originalCwd = process.cwd();
    const testDir = path.join(originalCwd, 'tests', '.tmp-ai-env');

    beforeEach(async () => {
        // Create a fake project directory and step into it
        await fs.mkdir(testDir, { recursive: true });
        process.chdir(testDir);
    });

    afterEach(async () => {
        // Step back out and clean up
        process.chdir(originalCwd);
        await fs.rm(testDir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('safely injects managed blocks without overwriting existing user instructions', async () => {
        // Setup 1: Create a CLAUDE.md with pre-existing user instructions
        const existingUserText = 'Always use async/await. Never use promises directly.\n';
        await fs.writeFile('CLAUDE.md', existingUserText);

        // Setup 2: Create a dummy terraform state so syncAi can extract the region/port
        await fs.mkdir('terraform', { recursive: true });
        await fs.writeFile(path.join('terraform', 'main.tf'), 'region = "us-east-2"\nport = "8000"');

        // Execute the CLI command
        await syncAi();

        // Assert: Read the file back and verify both contents exist
        const finalContent = await fs.readFile('CLAUDE.md', 'utf-8');

        // 1. The user's original rules MUST remain intact
        expect(finalContent).toContain(existingUserText);

        // 2. The deploy-stack managed block MUST be injected
        expect(finalContent).toContain('deploy-stack');
    });
});