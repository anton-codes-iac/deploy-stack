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
};
