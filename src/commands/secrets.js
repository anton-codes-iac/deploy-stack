import { SecretsManagerClient, UpdateSecretCommand } from "@aws-sdk/client-secrets-manager";
import dotenv from "dotenv";
import fs from 'fs/promises';
import { spinner } from '@clack/prompts';
import color from 'picocolors';
import path from 'path';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';

export async function pushSecrets(envFilePath, projectName) {
    const s = spinner();
    s.start(`Reading ${envFilePath} and pushing to AWS Secrets Manager...`);

    try {
        // 1. Read and parse the local .env file
        const envPath = path.resolve(process.cwd(), envFilePath);
        let envContent;
        try {
            envContent = await fs.readFile(envPath, 'utf-8');
        } catch (fsError) {
            if (fsError.code === 'ENOENT') {
                throw new Error(`File not found: ${envFilePath}. Please ensure the file exists before pushing.`);
            }
            throw fsError; // Re-throw if it's a permissions issue
        }

        const parsedSecrets = dotenv.parse(envContent);

        if (Object.keys(parsedSecrets).length === 0) {
            s.stop('No secrets found in file.');
            return;
        }

        // 2. Dynamically resolve the exact region from Terraform
        let targetRegion = process.env.AWS_REGION;
        try {
            const mainTfPath = path.join(process.cwd(), 'terraform', 'main.tf');
            const mainTfContent = await fs.readFile(mainTfPath, 'utf-8');
            const regionMatch = mainTfContent.match(/region\s*=\s*"([^"]+)"/);
            if (regionMatch) {
                targetRegion = regionMatch[1];
            }
        } catch (e) {
            // Silently fallback to AWS profile defaults if file read fails
        }

        // 3. Initialize the AWS Client locked to the correct region
        const client = new SecretsManagerClient(targetRegion ? { region: targetRegion } : {});

        // 4. Update the secret string in AWS
        const command = new UpdateSecretCommand({
            SecretId: `${projectName}-secrets`,
            SecretString: JSON.stringify(parsedSecrets),
        });

        await client.send(command);

        const keys = Object.keys(parsedSecrets);
        const keysFilePath = path.join(process.cwd(), 'terraform', 'secret_keys.json');

        await fs.writeFile(keysFilePath, JSON.stringify(keys, null, 2));

        s.stop(`✅ Successfully pushed ${Object.keys(parsedSecrets).length} secrets to AWS (${targetRegion || 'default region'})!`);
        console.log(color.cyan(`\nUpdated ${keysFilePath}`));
        console.log(color.green('Commit this file and push to GitHub to trigger a deployment with your new variables.'));
        console.log(color.blue(`\n📘 Learn how secrets reach your app: ${color.underline('https://github.com/anton-codes-iac/deploy-stack/blob/main/docs/guides/secrets-management.md')}`));

        trackEvent('secrets_pushed', {
            projectName,
            secret_count: Object.keys(parsedSecrets).length,
            success: true
        });
        await flushTelemetry();

    } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
            s.stop(color.red(`❌ Secrets Vault "${projectName}-secrets" does not exist in AWS yet.`));
            console.log(color.yellow('\n💡 Next Step:'));
            console.log(`Run ${color.cyan('npx --yes deploy-stack apply')} first to provision the infrastructure and Secrets Manager vault.`);
            console.log(`Once applied, run ${color.cyan(`npx deploy-stack secrets push ${envFilePath}`)} to upload your environment variables.\n`);
        } else {
            s.stop(`❌ Failed to push secrets: ${error.message}`);
        }

        trackEvent('secrets_pushed', {
            projectName,
            success: false,
            error_code: error.name || 'UNKNOWN',
            error_message: error.message
        });
        await flushTelemetry();
        process.exit(1);
    }
}