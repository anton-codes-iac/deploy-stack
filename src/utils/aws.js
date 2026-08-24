import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand } from '@aws-sdk/client-s3';

export async function provisionStateBucket(region, projectName) {
    const stsClient = new STSClient({ region });
    let awsAccountId;

    // 1. Get AWS Account ID
    const { Account } = await stsClient.send(new GetCallerIdentityCommand({}));
    awsAccountId = Account;

    // 2. Format Bucket Name
    let stateBucketName = `${projectName}-tfstate-${awsAccountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (stateBucketName.length > 63) {
        stateBucketName = stateBucketName.substring(0, 63).replace(/-$/, '');
    }

    // 3. Create S3 Bucket & Enable Versioning
    const s3Client = new S3Client({ region });
    try {
        await s3Client.send(new CreateBucketCommand({
            Bucket: stateBucketName,
            CreateBucketConfiguration: region === 'us-east-1' ? undefined : { LocationConstraint: region }
        }));

        await s3Client.send(new PutBucketVersioningCommand({
            Bucket: stateBucketName,
            VersioningConfiguration: { Status: 'Enabled' }
        }));
    } catch (error) {
        // Ignore if the bucket already exists and is owned by the user
        if (error.name !== 'BucketAlreadyOwnedByYou') {
            throw error;
        }
    }

    return { awsAccountId, stateBucketName };
}