// Single source of truth for `deploy-stack add` capabilities.
// Imported by both src/commands/add.js and src/utils/visualizer.js.
// Keep this module dependency-free so neither importer creates a cycle.
export const ADDON_REGISTRY = {
    'storage:s3': {
        file: 's3.tf',
        template: 's3.tf',
        label: 'S3 + CloudFront OAC',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed baseline; billed per GB stored ($0.023/GB-mo), S3 PUT/GET requests, and CloudFront egress',
        },
    },
    'db:dynamodb': {
        file: 'dynamodb.tf',
        template: 'dynamodb.tf',
        label: 'DynamoDB (On-Demand + PITR)',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed instance baseline (VPC Gateway Endpoint is free); billed per read/write request, table storage ($0.25/GB-mo), and PITR continuous backups ($0.20/GB-mo once data is written)',
        },
    },
    'db:redis': {
        file: 'redis.tf',
        template: 'redis.tf',
        label: 'ElastiCache Valkey 8.0',
        cost: {
            model: 'fixed-baseline',
            monthlyFixed: 9.49,
            summary: '~$9.49/mo fixed baseline ($0.013/hr Valkey 8.0 cache.t4g.micro in us-east-2); $0 intra-AZ VPC transfer',
        },
    },
    'queue:sqs': {
        file: 'sqs.tf',
        template: 'sqs.tf',
        label: 'SQS + DLQ',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed baseline; first 1M requests/mo free, then $0.40 per million requests',
        },
    },
    'ai:bedrock': {
        file: 'bedrock.tf',
        template: 'bedrock.tf',
        label: 'Bedrock Runtime IAM',
        cost: {
            model: 'usage-based',
            monthlyFixed: 0,
            summary: '$0/mo fixed baseline; billed per 1K input/output tokens on InvokeModel calls',
        },
    },
};
