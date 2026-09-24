import fsSync from 'fs';
import path from 'path';

export const FALLBACK_REGION = 'us-east-2';

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

export function resolveCluster(options = {}, cwd = process.cwd()) {
    if (typeof options.cluster === 'string' && options.cluster.trim()) return options.cluster.trim();
    if (typeof process.env.ECS_CLUSTER === 'string' && process.env.ECS_CLUSTER.trim()) {
        return process.env.ECS_CLUSTER.trim();
    }
    return `${resolveProjectName(options, cwd)}-cluster`;
}

export function resolveService(options = {}, cwd = process.cwd()) {
    if (typeof options.service === 'string' && options.service.trim()) return options.service.trim();
    if (typeof options.serviceName === 'string' && options.serviceName.trim()) return options.serviceName.trim();
    if (typeof process.env.ECS_SERVICE === 'string' && process.env.ECS_SERVICE.trim()) {
        return process.env.ECS_SERVICE.trim();
    }
    return `${resolveProjectName(options, cwd)}-service`;
}
