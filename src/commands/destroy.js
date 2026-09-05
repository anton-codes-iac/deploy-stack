import fsSync from 'fs';
import path from 'path';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import color from 'picocolors';
import { execSync, spawn } from 'child_process';
import { teardownStateBucket } from '../utils/aws.js';
import { checkDependency } from '../utils/system.js';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';

// Helper to run a command while piping the latest stdout line into a @clack spinner
function runTerraformCommand(args, cwd, spin, loadingPrefix) {
    return new Promise((resolve, reject) => {
        const child = spawn('terraform', args, { cwd });
        let errorOutput = '';
        let isDone = false;

        child.stdout.on('data', (data) => {
            if (isDone) return;
            const lines = data.toString().split('\n').filter(line => line.trim() !== '');
            if (lines.length > 0) {
                const latestLine = lines[lines.length - 1].trim();
                const display = latestLine.length > 120 ? latestLine.substring(0, 117) + '...' : latestLine;
                spin.message(`${loadingPrefix} - ${color.dim(display)}`);
            }
        });

        child.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        child.on('close', (code) => {
            isDone = true;
            if (code === 0) resolve();
            else reject(new Error(errorOutput || `Terraform exited with code ${code}`));
        });

        child.on('error', (err) => {
            isDone = true;
            reject(err);
        });
    });
}

export async function destroyStack() {
    intro(color.bgRed(color.white(' deploy-stack destroy 🗑️  ')));

    const tfDirPath = path.join(process.cwd(), 'terraform');
    const backendFilePath = path.join(tfDirPath, 'backend.tf');

    if (!fsSync.existsSync(backendFilePath)) {
        console.error(color.red('✖ No terraform/backend.tf found in the current directory.'));
        console.log(color.yellow('Are you in the root of a deploy-stack project?'));
        process.exit(1);
    }

    const hasTerraform = await checkDependency('terraform');
    if (!hasTerraform) {
        console.error(color.red('✖ Terraform is not installed.'));
        process.exit(1);
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

    // 2. Execute Terraform Destroy
    s.start('Destroying AWS compute resources (this takes a few minutes)...');
    try {
        await runTerraformCommand(['destroy', '-auto-approve'], tfDirPath, s, 'Destroying');
        s.stop('AWS compute resources destroyed.');
    } catch (error) {
        s.stop(color.red('❌ Terraform destroy failed.'));
        console.error(color.red(error.message));
        process.exit(1);
    }

    // 3. Clean up the S3 State Bucket
    if (bucketName) {
        const deleteS3Bucket = await confirm({
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

    trackEvent('project_destroyed', {
        region,
        bucket: bucketName,
        success: true
    });
    await flushTelemetry();

    outro(color.green('✅ Infrastructure successfully destroyed. Your AWS bill is safe.'));
}