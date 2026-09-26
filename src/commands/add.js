import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import color from 'picocolors';
import { intro, outro } from '@clack/prompts';
import { trackEvent, flushTelemetry } from '../core/telemetry.js';
import { resolveRegion, resolveProjectName } from '../utils/resolvers.js';
import { ADDON_REGISTRY } from '../utils/addons.js';
import { syncDocCostEstimate } from '../utils/visualizer.js';

export { ADDON_REGISTRY };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_PARTITION_KEY = 'id';
export const PARTITION_KEY_RE = /^[a-zA-Z0-9_.-]+$/;

const TEMPLATES_DIR = path.join(__dirname, '../../templates/terraform/addons');

const ADDON_ENV_VARS = {
    'storage:s3': [
        { name: 'S3_BUCKET_NAME', value: '${aws_s3_bucket.storage.id}' },
        { name: 'S3_CDN_URL', value: 'https://${aws_cloudfront_distribution.storage_cdn.domain_name}' },
    ],
    'db:dynamodb': [
        { name: 'DYNAMODB_TABLE_NAME', value: '${aws_dynamodb_table.main.name}' },
    ],
};

export function parseAddArgs(argv = []) {
    const args = [...argv];
    if (args[0] === 'add') args.shift();
    const options = { partitionKey: DEFAULT_PARTITION_KEY, force: false };
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
        } else if (arg === '--partition-key' && i + 1 < args.length) {
            options.partitionKey = args[++i];
        } else if (arg.startsWith('--partition-key=')) {
            options.partitionKey = arg.slice('--partition-key='.length);
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg.startsWith('--force=')) {
            options.force = arg.slice('--force='.length) === 'true';
        } else if (!arg.startsWith('-') && options.capability === undefined) {
            options.capability = arg;
        }
    }
    return options;
}

// Inserts { name, value } entries into the first `environment = [...]` array
// of the primary app container in `aws_ecs_task_definition.app`, skipping
// keys that already exist so reruns (e.g. with --force) stay idempotent.
// Returns the content unchanged when the resource or array cannot be found.
export function injectContainerEnvVars(mainTfContent, envEntries = []) {
    if (!Array.isArray(envEntries) || envEntries.length === 0) return mainTfContent;
    const content = String(mainTfContent ?? '');
    const resourceIdx = content.indexOf('resource "aws_ecs_task_definition" "app"');
    if (resourceIdx === -1) return content;
    const envPattern = /environment\s*=\s*\[/g;
    envPattern.lastIndex = resourceIdx;
    const match = envPattern.exec(content);
    if (!match) return content;
    const openIdx = match.index + match[0].length - 1;

    // Walk balanced brackets to find the end of the environment array,
    // skipping over double-quoted strings (which may contain brackets).
    let depth = 0;
    let inString = false;
    let closeIdx = -1;
    for (let i = openIdx; i < content.length; i++) {
        const ch = content[i];
        if (inString) {
            if (ch === '\\') {
                i++;
                continue;
            }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '[') {
            depth++;
        } else if (ch === ']') {
            depth--;
            if (depth === 0) {
                closeIdx = i;
                break;
            }
        }
    }
    if (closeIdx === -1) return content;

    const block = content.slice(openIdx, closeIdx + 1);
    const missing = envEntries.filter(({ name }) => {
        if (!/^[A-Za-z0-9_]+$/.test(name)) return true;
        const exists = new RegExp(`"name"\\s*[:=]\\s*"${name}"|\\bname\\s*=\\s*"${name}"`);
        return !exists.test(block);
    });
    if (missing.length === 0) return content;

    const inner = content.slice(openIdx + 1, closeIdx);
    const glue = inner.trim() === '' ? '\n        ' : ',\n        ';
    const insertion = missing
        .map(({ name, value }) => `{ name = "${name}", value = "${value}" }`)
        .join(',\n        ');
    return `${content.slice(0, closeIdx)}${glue}${insertion}\n      ${content.slice(closeIdx)}`;
}

function renderAddonTemplate(templateName, { region, partitionKey }) {
    const raw = fsSync.readFileSync(path.join(TEMPLATES_DIR, templateName), 'utf-8');
    return raw
        .replaceAll('{{REGION}}', region)
        .replaceAll('{{PARTITION_KEY}}', partitionKey);
}

export async function runAdd(options = {}) {
    const cwd = options.cwd || process.cwd();
    const capability = typeof options.capability === 'string' ? options.capability.trim() : '';
    const partitionKey = options.partitionKey ?? DEFAULT_PARTITION_KEY;
    const force = options.force === true || options.force === 'true';
    const addon = ADDON_REGISTRY[capability];
    const projectName = resolveProjectName(options, cwd);

    intro(color.bgCyan(color.black(' deploy-stack add 🧩 ')));

    if (!addon) {
        console.log(color.red(`\n✖ Unknown capability "${capability || 'none'}".`));
        console.log(`  Supported capabilities: ${color.cyan(Object.keys(ADDON_REGISTRY).join(', '))}\n`);
        trackEvent('add_run', { capability: capability || 'none', success: false, error_code: 'UNSUPPORTED_CAPABILITY' });
        await flushTelemetry();
        process.exit(1);
        return { ok: false, reason: 'unsupported-capability', capability: capability || 'none' };
    }

    // --partition-key only applies to db:dynamodb; other addons ignore it.
    if (capability === 'db:dynamodb' && !PARTITION_KEY_RE.test(String(partitionKey))) {
        console.log(color.red(`\n✖ Invalid partition key "${partitionKey}".`));
        console.log(color.dim('  Use only letters, numbers, underscore, hyphen, and dot (e.g. --partition-key userId).\n'));
        trackEvent('add_run', { projectName, capability, success: false, error_code: 'INVALID_PARTITION_KEY' });
        await flushTelemetry();
        process.exit(1);
        return { ok: false, reason: 'invalid-partition-key', capability, projectName };
    }

    const mainTfPath = path.join(cwd, 'terraform', 'main.tf');
    if (!fsSync.existsSync(mainTfPath)) {
        console.log(color.red('\n✖ No terraform/main.tf found. Run "deploy-stack init" first before adding services.\n'));
        trackEvent('add_run', { capability, success: false, error_code: 'TERRAFORM_NOT_INITIALIZED' });
        await flushTelemetry();
        process.exit(1);
        return { ok: false, reason: 'terraform-not-initialized', capability };
    }

    const region = resolveRegion(options, cwd);
    const targetPath = path.join(cwd, 'terraform', addon.file);
    if (fsSync.existsSync(targetPath) && !force) {
        console.log(color.yellow(`\n⚠ terraform/${addon.file} already exists. Pass --force to overwrite.\n`));
        trackEvent('add_run', { projectName, capability, success: false, error_code: 'ADDON_ALREADY_EXISTS' });
        await flushTelemetry();
        return { ok: false, reason: 'addon-already-exists', capability, projectName, region };
    }

    const rendered = renderAddonTemplate(addon.template, { region, partitionKey });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, rendered);

    const envVars = ADDON_ENV_VARS[capability] || [];
    const mainTfContent = await fs.readFile(mainTfPath, 'utf-8');
    const updated = injectContainerEnvVars(mainTfContent, envVars);
    const envInjected = updated !== mainTfContent;
    if (envInjected) {
        await fs.writeFile(mainTfPath, updated);
    }

    console.log(color.green(`\n✅ Created terraform/${addon.file}${envInjected ? ' and injected container environment variables' : ''}.`));
    for (const { name } of envVars) {
        console.log(`  ${color.dim('env:')} ${color.cyan(name)}`);
    }
    console.log(color.yellow(`\n💰 Cost Impact: ${addon.cost.summary}`));

    await syncDocCostEstimate(cwd);

    outro(
        `Run ${color.green('deploy-stack apply')} (or commit and push to trigger CI) to provision ${capability}. ` +
        `Available in your container as ${envVars.map((e) => e.name).join(', ')}.`
    );
    trackEvent('add_run', { projectName, capability, success: true });
    await flushTelemetry();
    return { ok: true, capability, projectName, region, file: `terraform/${addon.file}`, envInjected };
}

export default runAdd;
