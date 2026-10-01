// Tier 0 E2E: fast, PR-friendly, no AWS credentials. Mock-AWS scaffold,
// local checks, and failure-path contract pinning against the real CLI.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    e2eEnv,
    assertPrerequisites,
    runCli,
    runTerraform,
    withTmpDir,
} from './helpers.js';

const env = e2eEnv({ mockAws: true });

beforeAll(() => {
    assertPrerequisites();
});

describe('Tier 0: scaffold (ECS)', () => {
    it('inits, adds an addon, and generates valid Terraform', async () => {
        await withTmpDir('tier0-ecs', async (dir) => {
            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);

            const add = runCli(['add', 'queue:sqs', '--headless'], { cwd: dir, env });
            expect(add.status).toBe(0);

            expect(fs.existsSync(path.join(dir, 'README.md'))).toBe(true);
            expect(fs.existsSync(path.join(dir, 'terraform', 'main.tf'))).toBe(true);
            expect(fs.existsSync(path.join(dir, 'terraform', 'sqs.tf'))).toBe(true);
            const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).toContain('SQS_QUEUE_URL');

            runTerraform(['init', '-backend=false'], { cwd: path.join(dir, 'terraform'), env });
            runTerraform(['validate'], { cwd: path.join(dir, 'terraform'), env });
        });
    });
});

describe('Tier 0: scaffold (Lambda)', () => {
    it('inits a Lambda project with valid Terraform', async () => {
        await withTmpDir('tier0-lambda', async (dir) => {
            const init = runCli(['init', '--target', 'lambda', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);

            const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
            expect(mainTf).toContain('resource "aws_lambda_function" "app"');

            runTerraform(['init', '-backend=false'], { cwd: path.join(dir, 'terraform'), env });
            runTerraform(['validate'], { cwd: path.join(dir, 'terraform'), env });
        });
    });
});

describe('Tier 0: addon matrix', () => {
    // queue:sqs is covered by the ECS scaffold test above (including the
    // SQS_QUEUE_URL env-injection assertion); the rest get one
    // scaffold-and-validate pass each.
    const ADDON_MATRIX = [
        { capability: 'storage:s3', file: 's3.tf', extraArgs: [] },
        { capability: 'db:dynamodb', file: 'dynamodb.tf', extraArgs: [] },
        { capability: 'db:redis', file: 'redis.tf', extraArgs: [] },
        { capability: 'ai:bedrock', file: 'bedrock.tf', extraArgs: [] },
        { capability: 'email:ses', file: 'ses.tf', extraArgs: ['--domain', 'example.com'] },
        { capability: 'cron', file: 'cron.tf', extraArgs: [] },
    ];

    for (const { capability, file, extraArgs } of ADDON_MATRIX) {
        it(`scaffolds valid Terraform for ${capability}`, async () => {
            await withTmpDir(`tier0-add-${capability.replace(':', '-')}`, async (dir) => {
                const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env });
                expect(init.status).toBe(0);

                const add = runCli(['add', capability, ...extraArgs, '--headless'], { cwd: dir, env });
                expect(add.status).toBe(0);
                expect(fs.existsSync(path.join(dir, 'terraform', file))).toBe(true);

                runTerraform(['init', '-backend=false'], { cwd: path.join(dir, 'terraform'), env });
                runTerraform(['validate'], { cwd: path.join(dir, 'terraform'), env });
            });
        });
    }

    it('composes multiple addons via init --with', async () => {
        await withTmpDir('tier0-add-combo', async (dir) => {
            const init = runCli(['init', '--target', 'ecs', '--with', 'queue:sqs,db:redis', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);
            expect(fs.existsSync(path.join(dir, 'terraform', 'sqs.tf'))).toBe(true);
            expect(fs.existsSync(path.join(dir, 'terraform', 'redis.tf'))).toBe(true);

            runTerraform(['init', '-backend=false'], { cwd: path.join(dir, 'terraform'), env });
            runTerraform(['validate'], { cwd: path.join(dir, 'terraform'), env });
        });
    });
});

describe('Tier 0: local checks', () => {
    it('ejects metadata from a scaffolded project', async () => {
        await withTmpDir('tier0-eject', async (dir) => {
            const init = runCli(['init', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);

            const mainTfPath = path.join(dir, 'terraform', 'main.tf');
            expect(fs.readFileSync(mainTfPath, 'utf-8')).toContain('ManagedBy');

            const eject = runCli(['eject', '--yes'], { cwd: dir, env });
            expect(eject.status).toBe(0);
            expect(fs.readFileSync(mainTfPath, 'utf-8')).not.toContain('ManagedBy');
        });
    });

    it('doctor exits 0', async () => {
        await withTmpDir('tier0-doctor', async (dir) => {
            const doctor = runCli(['doctor'], { cwd: dir, env });
            expect(doctor.status).toBe(0);
        });
    });
});

describe('Tier 0: failure paths', () => {
    it('apply outside a project exits 1 cleanly', async () => {
        await withTmpDir('tier0-fail-apply', async (dir) => {
            const result = runCli(['apply', '--headless'], { cwd: dir, env, capture: true });
            expect(result.status).toBe(1);
            expect(result.output).toContain('No terraform directory');
            expect(result.output).not.toMatch(/^\s+at\s/m);
        });
    });

    it('init with an invalid target exits 1 cleanly', async () => {
        await withTmpDir('tier0-fail-target', async (dir) => {
            // NOTE: --headless is required to reach flag validation: without
            // it, init prompts for the target directory first and exits 0 on
            // EOF (the spec shows this command without --headless).
            const result = runCli(['init', '--target', 'fake-target', '--headless'], { cwd: dir, env, capture: true });
            expect(result.status).toBe(1);
            expect(result.output).toContain('Invalid compute target');
            expect(result.output).not.toMatch(/^\s+at\s/m);
        });
    });
});
