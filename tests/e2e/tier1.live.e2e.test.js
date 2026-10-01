// Tier 1 E2E: full live lifecycle against real AWS (nightly/manual only).
// Skips gracefully without credentials. Validated in CI, not locally.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import path from 'node:path';
import {
    e2eEnv,
    assertPrerequisites,
    makeTmpDir,
    removeDir,
    runCli,
    sleep,
    readBackendBucket,
    readBackendRegion,
} from './helpers.js';

const env = e2eEnv({ mockAws: false });
const STATUS_POLL_INTERVAL_MS = 15000;
const STATUS_POLL_BUDGET_MS = 6 * 60 * 1000;
const BUCKET_POLL_INTERVAL_MS = 10000;
const BUCKET_POLL_BUDGET_MS = 3 * 60 * 1000;

// Serial execution is mandatory (ordered lifecycle); the whole suite is
// skipped without credentials. (Vitest 5 cannot chain .serial.skipIf.)
const describeLive = process.env.AWS_ACCESS_KEY_ID ? describe.serial : describe.skip;

describeLive('Tier 1: live lifecycle', () => {
    let dir;
    let suiteFailed = false;

    beforeAll(() => {
        assertPrerequisites();
        dir = makeTmpDir('tier1-live');
    });

    afterAll(() => {
        if (suiteFailed) {
            console.log(`Tier 1 workspace preserved for debugging: ${dir}`);
            return;
        }
        removeDir(dir);
    });

    async function step(fn) {
        try {
            await fn();
        } catch (error) {
            suiteFailed = true;
            throw error;
        }
    }

    it('init scaffolds the project', async () => {
        await step(async () => {
            const init = runCli(['init', '--target', 'ecs', '--headless'], { cwd: dir, env });
            expect(init.status).toBe(0);
            expect(fs.existsSync(path.join(dir, 'terraform', 'main.tf'))).toBe(true);
        });
    });

    it('apply provisions infrastructure', async () => {
        await step(async () => {
            const apply = runCli(['apply', '--auto-approve'], { cwd: dir, env });
            expect(apply.status).toBe(0);
        });
    });

    it('status becomes healthy', async () => {
        await step(async () => {
            const deadline = Date.now() + STATUS_POLL_BUDGET_MS;
            let healthy = false;
            let lastOutput = '';
            while (Date.now() < deadline) {
                // --json exits 0 even when degraded, so the payload (not the
                // exit code) drives the loop; parse failures just mean "wait".
                const result = runCli(['status', '--json'], { cwd: dir, env, capture: true });
                lastOutput = result.output;
                try {
                    healthy = JSON.parse(result.stdout).healthy === true;
                } catch {
                    healthy = false;
                }
                if (healthy) break;
                await sleep(STATUS_POLL_INTERVAL_MS);
            }
            expect([healthy, lastOutput]).toEqual([true, expect.any(String)]);

            const final = runCli(['status'], { cwd: dir, env });
            expect(final.status).toBe(0);
        });
    });

    it('destroy tears everything down', async () => {
        await step(async () => {
            const bucket = readBackendBucket(dir);
            const region = readBackendRegion(dir);

            const destroy = runCli(['destroy', '--yes'], { cwd: dir, env });
            expect(destroy.status).toBe(0);

            const s3 = new S3Client({ region });
            const deadline = Date.now() + BUCKET_POLL_BUDGET_MS;
            for (;;) {
                try {
                    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
                } catch (error) {
                    if (error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return;
                    throw error;
                }
                if (Date.now() >= deadline) {
                    throw new Error(`state bucket ${bucket} still exists after destroy`);
                }
                await sleep(BUCKET_POLL_INTERVAL_MS);
            }
        });
    });
});
