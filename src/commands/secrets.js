import { SecretsManagerClient, UpdateSecretCommand } from "@aws-sdk/client-secrets-manager";
import dotenv from "dotenv";
import fs from 'fs/promises';
import { spinner } from '@clack/prompts';
import color from 'picocolors';
import path from 'path';

export async function pushSecrets(envFilePath, projectName) {
    const s = spinner();
    s.start(`Reading ${envFilePath} and pushing to AWS Secrets Manager...`);

    try {
        // 1. Read and parse the local .env file
        const envPath = path.resolve(process.cwd(), envFilePath);
        const envContent = await fs.readFile(envPath, 'utf-8');
        const parsedSecrets = dotenv.parse(envContent);

        if (Object.keys(parsedSecrets).length === 0) {
            s.stop('No secrets found in file.');
            return;
        }

        // 2. Initialize the AWS Client
        // It automatically uses the AWS credentials the user set in their terminal
        const client = new SecretsManagerClient({});

        // 3. Update the secret string in AWS
        // The SecretId matches the name we generated in secrets.tf
        const command = new UpdateSecretCommand({
            SecretId: `${projectName}-secrets`,
            SecretString: JSON.stringify(parsedSecrets),
        });

        await client.send(command);

        const keys = Object.keys(parsedSecrets);
        const keysFilePath = path.join(process.cwd(), 'terraform', 'secret_keys.json');

        await fs.writeFile(keysFilePath, JSON.stringify(keys, null, 2));

        s.stop(`✅ Successfully pushed ${Object.keys(parsedSecrets).length} secrets to AWS!`);
        console.log(color.cyan(`\nUpdated ${keysFilePath}`));
        console.log(color.green('Commit this file and push to GitHub to trigger a deployment with your new variables.'));

    } catch (error) {
        s.stop(`❌ Failed to push secrets: ${error.message}`);
    }
}