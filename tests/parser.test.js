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

    it('survives non-array and mixed-element inputs without throwing', () => {
        for (const bad of [null, undefined, 'string', 42, true, { port: 'string' }]) {
            const result = parseCliArgs(bad);
            expect(result.positionalArgs).toEqual([]);
            expect(result.baseCommand).toBe('init');
            expect(result.isHeadless).toBe(false);
        }
        const mixed = parseCliArgs(['--headless', 42, null, 'status']);
        expect(mixed.isHeadless).toBe(true);
        expect(mixed.positionalArgs).toEqual([42, null, 'status']);
    });

    it('extracts isPreconfigured and always populates initOptions', () => {
        const headless = parseCliArgs(['--headless', '--preconfigured']);
        expect(headless.isPreconfigured).toBe(true);
        expect(headless.initOptions).toEqual({
            with: [],
            model: null,
            domain: null,
            zoneId: null,
            fromEmail: null,
            dbEngine: null,
            setupCiMigrate: false,
        });

        const interactive = parseCliArgs(['init', '--with', 'db:redis']);
        expect(interactive.isPreconfigured).toBe(false);
        expect(interactive.initOptions.with).toEqual(['db:redis']);
    });

    it('accumulates repeatable and comma-separated --with with dedupe', () => {
        const result = parseCliArgs([
            '--headless',
            '--with', 'db:redis, queue:sqs',
            '--with=db:redis',
            '--with=ai:bedrock,',
            '--with', '--headless',
        ]);
        expect(result.initOptions.with).toEqual(['db:redis', 'queue:sqs', 'ai:bedrock']);
    });

    it('parses addon value flags in space and equals forms', () => {
        const spaced = parseCliArgs(['--headless', '--model', 'claude-x', '--domain', 'example.com']);
        expect(spaced.initOptions.model).toBe('claude-x');
        expect(spaced.initOptions.domain).toBe('example.com');

        const joined = parseCliArgs(['--zone-id=Z1', '--from-email=hi@example.com', '--setup-ci-migrate']);
        expect(joined.initOptions.zoneId).toBe('Z1');
        expect(joined.initOptions.fromEmail).toBe('hi@example.com');
        expect(joined.initOptions.setupCiMigrate).toBe(true);
    });

    it('treats valueless addon flags as absent', () => {
        const result = parseCliArgs(['--headless', '--model', '--domain=', '--with']);
        expect(result.initOptions.model).toBeNull();
        expect(result.initOptions.domain).toBeNull();
        expect(result.initOptions.with).toEqual([]);
    });

    it('parses --db-engine in space and equals forms', () => {
        const spaced = parseCliArgs(['--headless', '--db-engine', 'mysql']);
        expect(spaced.initOptions.dbEngine).toBe('mysql');

        const joined = parseCliArgs(['--db-engine=aurora-postgresql']);
        expect(joined.initOptions.dbEngine).toBe('aurora-postgresql');

        const absent = parseCliArgs(['--headless']);
        expect(absent.initOptions.dbEngine).toBeNull();
    });
});