import fsSync from 'fs';
import path from 'path';
import { normalizeOptions } from './args.js';

export const FALLBACK_REGION = 'us-east-2';

export function readFileSafe(filePath) {
    if (typeof filePath !== 'string') return null;
    try {
        if (fsSync.existsSync(filePath)) return fsSync.readFileSync(filePath, 'utf8');
    } catch {
        // Fall through to defaults
    }
    return null;
}

// Working directory for file resolution: an explicit string `cwd` option,
// otherwise the positional `fallback` when it is a usable path, otherwise
// the process cwd. A throwing `process.cwd()` (deleted directory)
// propagates so callers route through PROJECT_NOT_INITIALIZED.
export function resolveCwd(options = {}, fallback) {
    const opts = normalizeOptions(options);
    if (typeof opts.cwd === 'string' && opts.cwd) return opts.cwd;
    if (typeof fallback === 'string' && fallback) return fallback;
    return process.cwd();
}

export function readTerraformRegion(cwd = process.cwd()) {
    const base = resolveCwd({}, cwd);
    const mainTf = readFileSafe(path.join(base, 'terraform', 'main.tf'));
    if (!mainTf) return null;
    const match = mainTf.match(/region\s*=\s*"([^"]+)"/);
    if (!match || match[1].includes('{{')) return null;
    return match[1];
}

export function resolveRegion(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.region === 'string' && opts.region.trim()) {
        return opts.region.trim();
    }
    if (typeof process.env.AWS_REGION === 'string' && process.env.AWS_REGION.trim()) {
        return process.env.AWS_REGION.trim();
    }
    return readTerraformRegion(resolveCwd(opts, cwd)) || FALLBACK_REGION;
}

export function readTerraformProjectName(cwd = process.cwd()) {
    const base = resolveCwd({}, cwd);
    const mainTf = readFileSafe(path.join(base, 'terraform', 'main.tf'));
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
    const opts = normalizeOptions(options);
    const base = resolveCwd(opts, cwd);
    if (typeof opts.projectName === 'string' && opts.projectName.trim()) {
        return opts.projectName.trim();
    }
    return readTerraformProjectName(base) || path.basename(path.resolve(base));
}

export function resolveCluster(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.cluster === 'string' && opts.cluster.trim()) return opts.cluster.trim();
    if (typeof process.env.ECS_CLUSTER === 'string' && process.env.ECS_CLUSTER.trim()) {
        return process.env.ECS_CLUSTER.trim();
    }
    return `${resolveProjectName(opts, cwd)}-cluster`;
}

export function resolveService(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.service === 'string' && opts.service.trim()) return opts.service.trim();
    if (typeof opts.serviceName === 'string' && opts.serviceName.trim()) return opts.serviceName.trim();
    if (typeof process.env.ECS_SERVICE === 'string' && process.env.ECS_SERVICE.trim()) {
        return process.env.ECS_SERVICE.trim();
    }
    return `${resolveProjectName(opts, cwd)}-service`;
}

export function resolveLogGroup(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    if (typeof opts.logGroup === 'string' && opts.logGroup.trim()) {
        return opts.logGroup.trim();
    }
    if (typeof opts.logGroupName === 'string' && opts.logGroupName.trim()) {
        return opts.logGroupName.trim();
    }
    if (typeof process.env.ECS_LOG_GROUP === 'string' && process.env.ECS_LOG_GROUP.trim()) {
        return process.env.ECS_LOG_GROUP.trim();
    }
    return `/ecs/${resolveProjectName(opts, cwd)}`;
}

// True when prompts must not block: explicit headless flags, CI/test
// environments, or non-TTY stdio. An explicit `isHeadless: false` (or
// `headless: false`) forces interactive mode so unit tests can simulate
// TTY prompts. `env`/`stdin`/`stdout` are injectable for tests.
export function resolveHeadless(options = {}, env = process.env, stdin = process.stdin, stdout = process.stdout) {
    const opts = normalizeOptions(options);
    if (opts.isHeadless === false || opts.headless === false) return false;
    return Boolean(
        opts.isHeadless ||
        opts.headless ||
        (env && (env.CI || env.VITEST)) ||
        (env && env.NODE_ENV === 'test') ||
        !stdin?.isTTY ||
        !stdout?.isTTY
    );
}

// Workspace-namespaced application name (`myapp` or `myapp-pr-123`) shared
// by every `db` subcommand. `workspace` is the explicit `--workspace` value
// (or undefined to auto-detect `.terraform/environment` under `cwd`).
export function resolveAppName(projectName, workspace, cwd = process.cwd()) {
    return `${projectName}${resolveWorkspaceSuffix({ workspace, cwd }, cwd)}`;
}

// Reads the local Terraform workspace (e.g. a PR-preview environment).
// Returns '' for the default workspace so names stay un-suffixed.
export function resolveWorkspaceSuffix(options = {}, cwd = process.cwd()) {
    const opts = normalizeOptions(options);
    const base = resolveCwd(opts, cwd);
    let workspace = null;
    if (typeof opts.workspace === 'string' && opts.workspace.trim()) {
        workspace = opts.workspace.trim();
    } else {
        const detected = readFileSafe(path.join(base, '.terraform', 'environment'));
        if (typeof detected === 'string' && detected.trim()) workspace = detected.trim();
    }
    if (!workspace || workspace === 'default') return '';
    return `-${workspace}`;
}
