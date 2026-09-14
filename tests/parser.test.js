import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../src/core/parser.js';

describe('CLI Argument Parser', () => {
    it('safely extracts telemetry variations and prevents positional hijacking', () => {
        // Simulating: npx deploy-stack secrets push .env --no-telemetry=true
        const args = ['secrets', 'push', '.env', '--no-telemetry=true'];
        const result = parseCliArgs(args);

        expect(result.hasNoTelemetry).toBe(true);
        expect(result.positionalArgs).toEqual(['secrets', 'push', '.env']);
        expect(result.baseCommand).toBe('secrets push');
    });

    it('correctly parses headless boolean flags without assignments', () => {
        // Simulating: npx deploy-stack --headless --needsDatabase
        const args = ['--headless', '--needsDatabase'];
        const result = parseCliArgs(args);

        expect(result.isHeadless).toBe(true);
        expect(result.headlessOptions.needsDatabase).toBe(true);
    });

    it('correctly maps headless assignment flags', () => {
        // Simulating: npx deploy-stack --headless --framework=django --region=us-east-2
        const args = ['--headless', '--framework=django', '--region=us-east-2'];
        const result = parseCliArgs(args);

        expect(result.headlessOptions.framework).toBe('django');
        expect(result.headlessOptions.region).toBe('us-east-2');
    });
});