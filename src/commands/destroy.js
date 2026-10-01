import fsSync from 'fs';
import path from 'path';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import color from 'picocolors';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand, StartDBInstanceCommand, StartDBClusterCommand } from '@aws-sdk/client-rds';
import { teardownStateBucket, resolveClient } from '../utils/aws.js';
import { checkDependency, pollUntil } from '../utils/system.js';
import { trackEvent, flushTelemetry, trackSuccess } from '../core/telemetry.js';
import { failCommand } from '../utils/command.js';
import { runTerraformCommand } from '../utils/terraform.js';
import { findDbTarget, resolveDbIdentifier, resolveDbClusterIdentifier } from '../utils/rds.js';
import { normalizeOptions } from '../utils/args.js';

export const DEFAULT_DESTROY_DB_TIMEOUT_MS = 600000;
export const DEFAULT_DESTROY_DB_POLL_INTERVAL_MS = 5000;

export async function destroyStack(input = {}) {
    const options = normalizeOptions(input);
    intro(color.bgRed(color.white(' deploy-stack destroy 🗑️  ')));

    const tfDirPath = path.join(process.cwd(), 'terraform');
    const backendFilePath = path.join(tfDirPath, 'backend.tf');

    if (!fsSync.existsSync(backendFilePath)) {
        return failCommand({
            print: () => {
                console.error(color.red('✖ No terraform/backend.tf found in the current directory.'));
                console.log(color.yellow('Are you in the root of a deploy-stack project?'));
            },
        });
    }

    const hasTerraform = await checkDependency('terraform');
    if (!hasTerraform) {
        return failCommand({ message: '✖ Terraform is not installed.', useErrorStream: true });
    }

    const proceed = await confirm({
        message: color.red('⚠️  WARNING: This will permanently destroy all AWS resources associated with this project. Are you absolutely sure?'),
        initialValue: false,
    });

    if (!proceed) {
        cancel('Destruction cancelled. Your infrastructure is safe.');
        process.exit(0);
    }

    const s = spinner();

    // 1. Extract Bucket and Region from backend.tf
    const backendContent = fsSync.readFileSync(backendFilePath, 'utf-8');
    const bucketMatch = backendContent.match(/bucket\s*=\s*"([^"]+)"/);
    const regionMatch = backendContent.match(/region\s*=\s*"([^"]+)"/);

    const bucketName = bucketMatch ? bucketMatch[1] : null;
    const region = regionMatch ? regionMatch[1] : 'us-east-2';

    // 1b. Wake a non-available database first: RDS rejects deletes of a
    // stopped (or transitional) cluster/instance with
    // InvalidDBClusterStateFault, which fails `terraform destroy` on asleep
    // environments. No-op when no database exists or it is available.
    const timeoutMs = options.timeoutMs ?? DEFAULT_DESTROY_DB_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DESTROY_DB_POLL_INTERVAL_MS;
    const pollOverrides = {
        ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
        ...(options.nowFn ? { nowFn: options.nowFn } : {}),
    };
    try {
        const rdsClient = resolveClient(options.rdsClient, RDSClient, { region });
        const dbTarget = await findDbTarget(rdsClient, {
            dbIdentifier: resolveDbIdentifier(options, process.cwd()),
            dbClusterIdentifier: resolveDbClusterIdentifier(options, process.cwd()),
        });
        if (dbTarget && dbTarget.status !== 'available') {
            const isCluster = dbTarget.kind === 'cluster';
            const readStatus = async () => {
                const resp = isCluster
                    ? await rdsClient.send(new DescribeDBClustersCommand({ DBClusterIdentifier: dbTarget.id }))
                    : await rdsClient.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: dbTarget.id }));
                const current = isCluster
                    ? (resp.DBClusters || [])[0] || null
                    : (resp.DBInstances || [])[0] || null;
                return current ? current.Status : null;
            };
            // A `stopping` database settles to `stopped`, never directly to
            // `available` — so transitional states wait for a stable state
            // first, `stopped` issues Start, then everything waits for
            // `available`. A database that disappears mid-wait (null) lets
            // the destroy proceed.
            const waitForStable = () => pollUntil({
                intervalMs: pollIntervalMs,
                timeoutMs,
                ...pollOverrides,
                onTick: async ({ elapsedMs }) => {
                    const status = await readStatus();
                    if (status === 'stopped' || status === 'available' || status === null) {
                        return { done: true, value: status };
                    }
                    s.message(`Waiting for ${dbTarget.id} to settle (${status})... [${Math.floor(elapsedMs / 1000)}s]`);
                    return { done: false };
                },
            });
            const waitForAvailable = () => pollUntil({
                intervalMs: pollIntervalMs,
                timeoutMs,
                ...pollOverrides,
                onTick: async ({ elapsedMs }) => {
                    const status = await readStatus();
                    if (status === 'available' || status === null) return { done: true, value: status };
                    s.message(`Waiting for ${dbTarget.id} to become available... [${Math.floor(elapsedMs / 1000)}s]`);
                    return { done: false };
                },
            });
            s.start('Waking database before destruction...');
            let status = dbTarget.status;
            if (status !== 'stopped') {
                const settled = await waitForStable();
                if (settled.timedOut) {
                    s.stop(color.yellow('Database still transitioning.'));
                    const actualProjectName = path.basename(process.cwd());
                    return failCommand({
                        print: () => {
                            console.log(color.yellow(`\n⚠ ${dbTarget.id} did not leave the ${status} state in time — RDS refuses to delete non-available databases.`));
                            console.log(`  Re-run ${color.green('npx deploy-stack destroy')} once the database is available.\n`);
                        },
                        event: 'infrastructure_destroyed',
                        telemetry: { projectName: actualProjectName, error_code: 'RDS_DESTROY_PREFLIGHT_TIMEOUT' },
                    });
                }
                status = settled.value;
            }
            if (status === 'stopped') {
                if (isCluster) {
                    await rdsClient.send(new StartDBClusterCommand({ DBClusterIdentifier: dbTarget.id }));
                } else {
                    await rdsClient.send(new StartDBInstanceCommand({ DBInstanceIdentifier: dbTarget.id }));
                }
                status = 'starting';
            }
            if (status !== null) {
                const outcome = await waitForAvailable();
                if (outcome.timedOut) {
                    s.stop(color.yellow('Database still starting.'));
                    const actualProjectName = path.basename(process.cwd());
                    return failCommand({
                        print: () => {
                            console.log(color.yellow(`\n⚠ ${dbTarget.id} did not become available in time — RDS refuses to delete non-available databases.`));
                            console.log(`  Re-run ${color.green('npx deploy-stack destroy')} once the database is available.\n`);
                        },
                        event: 'infrastructure_destroyed',
                        telemetry: { projectName: actualProjectName, error_code: 'RDS_DESTROY_PREFLIGHT_TIMEOUT' },
                    });
                }
            }
            s.stop('Database is available.');
        }
    } catch (error) {
        if (error && typeof error.exitCode === 'number') throw error;
        try { s.stop(color.red('❌ Pre-destroy database check failed.')); } catch { /* spinner already stopped */ }
        const actualProjectName = path.basename(process.cwd());
        return failCommand({
            message: error.message,
            useErrorStream: true,
            event: 'infrastructure_destroyed',
            telemetry: { projectName: actualProjectName, error_code: error.code || 'RDS_DESTROY_PREFLIGHT_FAILED' },
        });
    }

    // 2. Execute Terraform Destroy
    s.start('Destroying AWS compute resources (this takes a few minutes)...');
    try {
        await runTerraformCommand(['destroy', '-auto-approve'], tfDirPath, s, 'Destroying');
        s.stop('AWS compute resources destroyed.');
    } catch (error) {
        s.stop(color.red('❌ Terraform destroy failed.'));

        const actualProjectName = path.basename(process.cwd());
        return failCommand({
            message: error.message,
            useErrorStream: true,
            event: 'infrastructure_destroyed',
            telemetry: { projectName: actualProjectName, error_code: error.code || 'UNKNOWN' },
        });
    }

    // 3. Clean up the S3 State Bucket
    let deleteS3Bucket = false;

    if (bucketName) {
        deleteS3Bucket = await confirm({
            message: color.yellow(`AWS compute resources destroyed. Do you also want to permanently delete the S3 state bucket?\n  (Select 'No' if you plan to run 'deploy-stack apply' later to spin this back up.)`),
            initialValue: false,
        });

        if (deleteS3Bucket && typeof deleteS3Bucket !== 'symbol') {
            s.start(`Emptying and deleting S3 state bucket: ${bucketName}...`);
            try {
                await teardownStateBucket(region, bucketName);
                s.stop(`S3 bucket ${bucketName} successfully deleted.`);
            } catch (error) {
                s.stop(`❌ Failed to delete S3 bucket. You may need to delete it manually in the AWS Console.`);
                console.error(color.red(`AWS Error: ${error.message}`));
            }
        } else {
            console.log(color.cyan(`\n  S3 bucket retained. You can run 'npx deploy-stack apply' anytime to restore your infrastructure.`));
        }
    }

    const actualProjectName = path.basename(process.cwd());
    await trackSuccess('infrastructure_destroyed', {
        projectName: actualProjectName,
        region,
        retained_state_bucket: !(deleteS3Bucket && typeof deleteS3Bucket !== 'symbol')
    });

    outro(color.green('✅ Infrastructure successfully destroyed. Your AWS bill is safe.'));
}