import fsSync from 'fs';
import path from 'path';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import color from 'picocolors';
import { execSync } from 'child_process';
import { teardownStateBucket } from '../utils/aws.js';
import { checkDependency } from '../utils/system.js';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';

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
    const region = regionMatch ? regionMatch[1] : 'us-east-1';

    // 2. Execute Terraform Destroy
    console.log(color.cyan('\nInitiating Terraform destroy (this may take a few minutes)...\n'));
    try {
        execSync('terraform destroy -auto-approve', { cwd: tfDirPath, stdio: 'inherit' });
    } catch (error) {
        console.error(color.red('\n✖ Terraform destroy failed. Please check the output above.'));
        process.exit(1);
    }

    // 3. Clean up the S3 State Bucket
    if (bucketName) {
        s.start(`Emptying and deleting S3 state bucket: ${bucketName}...`);
        try {
            await teardownStateBucket(region, bucketName);
            s.stop(`S3 bucket ${bucketName} successfully deleted.`);
        } catch (error) {
            s.stop(`❌ Failed to delete S3 bucket. You may need to delete it manually in the AWS Console.`);
            console.error(color.red(`AWS Error: ${error.message}`));
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