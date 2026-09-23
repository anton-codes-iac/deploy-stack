import { ECRClient, DescribeRepositoriesCommand, DescribeImagesCommand, BatchDeleteImageCommand } from '@aws-sdk/client-ecr';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { EC2Client, DescribeAddressesCommand, ReleaseAddressCommand } from '@aws-sdk/client-ec2';
import fsSync from 'fs';
import path from 'path';
import color from 'picocolors';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';

export const FALLBACK_REGION = 'us-east-2';
export const CONFIRM_MESSAGE = 'Are you sure you want to permanently delete these orphaned resources? (y/N)';

function readFileSafe(filePath) {
    try {
        if (fsSync.existsSync(filePath)) return fsSync.readFileSync(filePath, 'utf8');
    } catch {
        // Fall through to defaults
    }
    return null;
}

export function readTerraformRegion(cwd = process.cwd()) {
    const mainTf = readFileSafe(path.join(cwd, 'terraform', 'main.tf'));
    if (!mainTf) return null;
    const match = mainTf.match(/region\s*=\s*"([^"]+)"/);
    if (!match || match[1].includes('{{')) return null;
    return match[1];
}

export function resolveRegion(options = {}, cwd = process.cwd()) {
    if (typeof options.region === 'string' && options.region.trim()) {
        return options.region.trim();
    }
    if (typeof process.env.AWS_REGION === 'string' && process.env.AWS_REGION.trim()) {
        return process.env.AWS_REGION.trim();
    }
    return readTerraformRegion(options.cwd || cwd) || FALLBACK_REGION;
}

export function resolveProjectName(options = {}, cwd = process.cwd()) {
    const base = options.cwd || cwd;
    if (typeof options.projectName === 'string' && options.projectName.trim()) {
        return options.projectName.trim();
    }
    return path.basename(path.resolve(base));
}

export function parseGcArgs(argv = []) {
    const args = [...argv];
    if (args[0] === 'gc') args.shift();
    const options = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--region' && i + 1 < args.length) {
            options.region = args[++i];
        } else if (arg.startsWith('--region=')) {
            options.region = arg.slice('--region='.length);
        } else if (arg === '--project-name' && i + 1 < args.length) {
            options.projectName = args[++i];
        } else if (arg.startsWith('--project-name=')) {
            options.projectName = arg.slice('--project-name='.length);
        }
        // NOTE: intentionally no --yes flag. Deletion always requires
        // explicit interactive confirmation to prevent CI accidents.
    }
    return options;
}

export function isUntaggedImageDetail(detail = {}) {
    if (Array.isArray(detail.imageTags)) return detail.imageTags.length === 0;
    if (typeof detail.imageTag === 'string') return detail.imageTag.trim().length === 0;
    if (detail.imageTag == null && detail.imageDigest) return true;
    return !detail.imageTags;
}

export function filterUntaggedImages(imageDetails = []) {
    return (imageDetails || []).filter(isUntaggedImageDetail);
}

export function isUnattachedAddress(address = {}) {
    return !address.AssociationId;
}

export function filterUnattachedAddresses(addresses = []) {
    return (addresses || []).filter(isUnattachedAddress);
}

function matchesProjectRepo(repositoryName, projectName) {
    return typeof repositoryName === 'string' && repositoryName.startsWith(`${projectName}-`);
}

export async function discoverOrphanedResources({ ecrClient, logsClient, ec2Client, projectName }) {
    const untaggedImages = [];
    const orphanedLogGroups = [];
    const unattachedEips = [];

    // Target 1: untagged ECR images in project-prefixed repos.
    // Both DescribeRepositories and DescribeImages are paginated.
    const repositories = [];
    let reposNextToken;
    do {
        const reposResp = await ecrClient.send(new DescribeRepositoriesCommand({ nextToken: reposNextToken }));
        for (const repo of reposResp.repositories || []) {
            if (matchesProjectRepo(repo.repositoryName, projectName)) repositories.push(repo);
        }
        reposNextToken = reposResp.nextToken;
    } while (reposNextToken);
    for (const repo of repositories) {
        let imagesNextToken;
        do {
            const imagesResp = await ecrClient.send(
                new DescribeImagesCommand({ repositoryName: repo.repositoryName, nextToken: imagesNextToken })
            );
            for (const detail of filterUntaggedImages(imagesResp.imageDetails || [])) {
                if (!detail.imageDigest) continue;
                untaggedImages.push({
                    repositoryName: repo.repositoryName,
                    imageDigest: detail.imageDigest,
                    imageSizeInBytes: detail.imageSizeInBytes,
                    imagePushedAt: detail.imagePushedAt,
                });
            }
            imagesNextToken = imagesResp.nextToken;
        } while (imagesNextToken);
    }

    // Target 2: orphaned CloudWatch log groups for deleted preview environments.
    // The live service log group is `/ecs/<project>` (no trailing dash); preview
    // leftovers are `/ecs/<project>-*`, so a prefix scan isolates candidates.
    let nextToken;
    do {
        const logsResp = await logsClient.send(
            new DescribeLogGroupsCommand({ logGroupNamePrefix: `/ecs/${projectName}-`, nextToken })
        );
        for (const group of logsResp.logGroups || []) {
            if (group.logGroupName) orphanedLogGroups.push({ logGroupName: group.logGroupName, storedBytes: group.storedBytes });
        }
        nextToken = logsResp.nextToken;
    } while (nextToken);

    // Target 3: unattached Elastic IPs (hourly charge when idle).
    const addressesResp = await ec2Client.send(new DescribeAddressesCommand({}));
    for (const address of filterUnattachedAddresses(addressesResp.Addresses || [])) {
        unattachedEips.push({ PublicIp: address.PublicIp, AllocationId: address.AllocationId });
    }

    return {
        untaggedImages,
        orphanedLogGroups,
        unattachedEips,
        totalCount: untaggedImages.length + orphanedLogGroups.length + unattachedEips.length,
    };
}

export const ECR_BATCH_DELETE_LIMIT = 100;

export function chunkArray(items = [], size = ECR_BATCH_DELETE_LIMIT) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

export async function deleteDiscoveredResources({ ecrClient, logsClient, ec2Client }, discovered) {
    let deletedImages = 0;
    let deletedLogGroups = 0;
    let releasedEips = 0;

    // Group untagged images by repository for batch deletion.
    // BatchDeleteImage accepts at most 100 image IDs per request.
    const byRepo = new Map();
    for (const image of discovered.untaggedImages || []) {
        if (!byRepo.has(image.repositoryName)) byRepo.set(image.repositoryName, []);
        byRepo.get(image.repositoryName).push({ imageDigest: image.imageDigest });
    }
    for (const [repositoryName, imageIds] of byRepo) {
        for (const batch of chunkArray(imageIds, ECR_BATCH_DELETE_LIMIT)) {
            await ecrClient.send(new BatchDeleteImageCommand({ repositoryName, imageIds: batch }));
            deletedImages += batch.length;
        }
    }

    for (const group of discovered.orphanedLogGroups || []) {
        await logsClient.send(new DeleteLogGroupCommand({ logGroupName: group.logGroupName }));
        deletedLogGroups += 1;
    }

    for (const eip of discovered.unattachedEips || []) {
        await ec2Client.send(new ReleaseAddressCommand({ AllocationId: eip.AllocationId }));
        releasedEips += 1;
    }

    return { deletedImages, deletedLogGroups, releasedEips };
}

function printDiscovery(discovered) {
    console.log('');
    console.log(`  ${color.bold('Untagged ECR images:')} ${discovered.untaggedImages.length}`);
    for (const image of discovered.untaggedImages.slice(0, 10)) {
        console.log(`    ${color.dim('-')} ${image.repositoryName}@${String(image.imageDigest).slice(0, 19)}`);
    }
    if (discovered.untaggedImages.length > 10) {
        console.log(`    ${color.dim(`…and ${discovered.untaggedImages.length - 10} more`)}`);
    }
    console.log(`  ${color.bold('Orphaned log groups:')} ${discovered.orphanedLogGroups.length}`);
    for (const group of discovered.orphanedLogGroups.slice(0, 10)) {
        console.log(`    ${color.dim('-')} ${group.logGroupName}`);
    }
    if (discovered.orphanedLogGroups.length > 10) {
        console.log(`    ${color.dim(`…and ${discovered.orphanedLogGroups.length - 10} more`)}`);
    }
    console.log(`  ${color.bold('Unattached Elastic IPs:')} ${discovered.unattachedEips.length}`);
    for (const eip of discovered.unattachedEips) {
        console.log(`    ${color.dim('-')} ${eip.PublicIp || eip.AllocationId}`);
    }
    console.log('');
}

export async function runGc(options = {}) {
    const cwd = options.cwd || process.cwd();
    const region = resolveRegion(options, cwd);
    const projectName = resolveProjectName(options, cwd);

    const ecrClient = options.ecrClient && typeof options.ecrClient.send === 'function'
        ? options.ecrClient
        : new ECRClient({ region });
    const logsClient = options.logsClient && typeof options.logsClient.send === 'function'
        ? options.logsClient
        : new CloudWatchLogsClient({ region });
    const ec2Client = options.ec2Client && typeof options.ec2Client.send === 'function'
        ? options.ec2Client
        : new EC2Client({ region });

    intro(color.bgCyan(color.black(' deploy-stack gc 🧹 ')));

    const s = spinner();
    s.start('Scanning for orphaned resources (dry run)...');

    let discovered;
    try {
        discovered = await discoverOrphanedResources({ ecrClient, logsClient, ec2Client, projectName });
    } catch (error) {
        s.stop(color.red('❌ Discovery failed.'));
        console.log(color.red(`✖ ${error?.message || error}`));
        trackEvent('gc_run', { projectName, success: false, error_message: error?.message });
        await flushTelemetry();
        throw error;
    }
    s.stop('Discovery complete.');

    console.log(color.bold(`\nDry run — orphaned resources for project ${color.cyan(projectName)}:`));
    printDiscovery(discovered);
    console.log(color.dim(`Total orphaned resources: ${discovered.totalCount}`));

    if (discovered.totalCount === 0) {
        outro(color.green('No orphaned resources found. ✅'));
        trackEvent('gc_run', { projectName, success: true, deleted: false, total: 0 });
        await flushTelemetry();
        return { ...discovered, deleted: false };
    }

    // Safety: only a literal `true` from the interactive prompt proceeds.
    // Anything else (false, undefined, cancelled symbol) aborts deletion.
    const confirmed = await confirm({ message: color.yellow(CONFIRM_MESSAGE), initialValue: false });

    if (confirmed !== true) {
        cancel('Cancelled. No resources were deleted.');
        trackEvent('gc_run', { projectName, success: true, deleted: false, total: discovered.totalCount, confirmed: false });
        await flushTelemetry();
        return { ...discovered, deleted: false, confirmed: false };
    }

    const del = spinner();
    del.start('Deleting orphaned resources...');
    const summary = await deleteDiscoveredResources({ ecrClient, logsClient, ec2Client }, discovered);
    del.stop('Deletion complete.');

    outro(color.green(`Deleted ${summary.deletedImages} image(s), ${summary.deletedLogGroups} log group(s), released ${summary.releasedEips} Elastic IP(s). ✅`));
    trackEvent('gc_run', { projectName, success: true, deleted: true, ...summary, total: discovered.totalCount });
    await flushTelemetry();
    return { ...discovered, ...summary, deleted: true, confirmed: true };
}
