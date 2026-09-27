import fsSync from 'fs';
import path from 'path';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import color from 'picocolors';
import { teardownStateBucket } from '../utils/aws.js';
import { checkDependency } from '../utils/system.js';
import { trackEvent, flushTelemetry, trackSuccess } from '../core/telemetry.js';
import { failCommand } from '../utils/command.js';
import { runTerraformCommand } from '../utils/terraform.js';

export async function destroyStack() {
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