import fsSync from 'fs';
import path from 'path';

export const FALLBACK_REGION = 'us-east-2';

export function readFileSafe(filePath) {
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

export function readTerraformProjectName(cwd = process.cwd()) {
    const mainTf = readFileSafe(path.join(cwd, 'terraform', 'main.tf'));
    if (!mainTf) return null;
    const appNameMatch = mainTf.match(/app_name\s*=\s*"([^"$]+)\$\{local\.env_suffix\}"/);
    if (appNameMatch) return appNameMatch[1];
    // Hand-written files may set a plain app_name (possibly with some other
    // ${...} suffix); it still outranks the ECR heuristic below.
    const genericMatch = mainTf.match(/app_name\s*=\s*"([^"]+)"/);
    if (genericMatch && !genericMatch[1].includes('{{')) {
        const stripped = genericMatch[1].replace(/\$\{.*$/, '').replace(/[-_]$/, '');
        if (stripped) return stripped;
    }
    const ecrMatch = mainTf.match(/resource\s+"aws_ecr_repository"\s+"app"\s*\{[^}]*?name\s*=\s*"([^"]+)-repo"/);
    if (ecrMatch) return ecrMatch[1];
    return null;
}

export function resolveProjectName(options = {}, cwd = process.cwd()) {
    const base = options.cwd || cwd;
    if (typeof options.projectName === 'string' && options.projectName.trim()) {
        return options.projectName.trim();
    }
    return readTerraformProjectName(base) || path.basename(path.resolve(base));
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

export function resolveLogGroup(options = {}, cwd = process.cwd()) {
    if (typeof options.logGroup === 'string' && options.logGroup.trim()) {
        return options.logGroup.trim();
    }
    if (typeof options.logGroupName === 'string' && options.logGroupName.trim()) {
        return options.logGroupName.trim();
    }
    if (typeof process.env.ECS_LOG_GROUP === 'string' && process.env.ECS_LOG_GROUP.trim()) {
        return process.env.ECS_LOG_GROUP.trim();
    }
    return `/ecs/${resolveProjectName(options, cwd)}`;
}

// Reads the local Terraform workspace (e.g. a PR-preview environment).
// Returns '' for the default workspace so names stay un-suffixed.
export function resolveWorkspaceSuffix(options = {}, cwd = process.cwd()) {
    const base = options.cwd || cwd;
    let workspace = null;
    if (typeof options.workspace === 'string' && options.workspace.trim()) {
        workspace = options.workspace.trim();
    } else {
        const detected = readFileSafe(path.join(base, '.terraform', 'environment'));
        if (typeof detected === 'string' && detected.trim()) workspace = detected.trim();
    }
    if (!workspace || workspace === 'default') return '';
    return `-${workspace}`;
}
