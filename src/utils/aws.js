import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutBucketTaggingCommand } from '@aws-sdk/client-s3';
import { DeleteBucketCommand, ListObjectVersionsCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";

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

        await s3Client.send(new PutBucketTaggingCommand({
            Bucket: stateBucketName,
            Tagging: {
                TagSet: [
                    { Key: "ManagedBy", Value: "deploy-stack" }
                ]
            }
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

export async function teardownStateBucket(region, bucketName) {
    const client = new S3Client({ region });

    try {
        // 1. Fetch all object versions and delete markers
        const listCommand = new ListObjectVersionsCommand({ Bucket: bucketName });
        const { Versions, DeleteMarkers } = await client.send(listCommand);

        const objectsToDelete = [];
        if (Versions) objectsToDelete.push(...Versions.map(v => ({ Key: v.Key, VersionId: v.VersionId })));
        if (DeleteMarkers) objectsToDelete.push(...DeleteMarkers.map(v => ({ Key: v.Key, VersionId: v.VersionId })));

        // 2. Delete all contents if any exist
        if (objectsToDelete.length > 0) {
            const deleteCommand = new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: { Objects: objectsToDelete }
            });
            await client.send(deleteCommand);
        }

        // 3. Delete the now-empty bucket
        const deleteBucketCommand = new DeleteBucketCommand({ Bucket: bucketName });
        await client.send(deleteBucketCommand);

        return true;
    } catch (error) {
        if (error.name === 'NoSuchBucket') return true; // Already deleted
        throw error;
    }
}