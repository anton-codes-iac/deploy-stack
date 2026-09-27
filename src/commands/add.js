import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import color from 'picocolors';
import { intro, outro, select, text, spinner, log, cancel, isCancel } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, isActiveEnvValue } from '../core/telemetry.js';
import { resolveRegion, resolveProjectName } from '../utils/resolvers.js';
import { ADDON_REGISTRY } from '../utils/addons.js';
import { parseFlags } from '../utils/args.js';
import { failCommand } from '../utils/command.js';
import { syncDocCostEstimate } from '../utils/visualizer.js';
import {
    FALLBACK_BEDROCK_MODEL,
    GENERIC_MODEL_HINT,
    findCatalogEntry,
    loadBedrockCatalog,
    normalizeProviderName,
    refreshBedrockCatalog,
    resolveModelIdForRegion,
} from '../utils/bedrock-catalog.js';

export { ADDON_REGISTRY };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_PARTITION_KEY = 'id';
export const PARTITION_KEY_RE = /^[a-zA-Z0-9_.-]+$/;
export const DEFAULT_BEDROCK_MODEL = loadBedrockCatalog().defaultModelId || FALLBACK_BEDROCK_MODEL;
export const MODEL_ID_RE = /^[a-zA-Z0-9_.:-]+$/;
export const CUSTOM_MODEL_VALUE = '__custom__';

const TEMPLATES_DIR = path.join(__dirname, '../../templates/terraform/addons');

const ADDON_ENV_VARS = {
    'storage:s3': [
        { name: 'S3_BUCKET_NAME', value: '${aws_s3_bucket.storage.id}' },
        { name: 'S3_CDN_URL', value: 'https://${aws_cloudfront_distribution.storage_cdn.domain_name}' },
    ],
    'db:dynamodb': [
        { name: 'DYNAMODB_TABLE_NAME', value: '${aws_dynamodb_table.main.name}' },
    ],
    'db:redis': [
        { name: 'REDIS_URL', value: 'redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}' },
    ],
    'queue:sqs': [
        { name: 'SQS_QUEUE_URL', value: '${aws_sqs_queue.main.id}' },
        { name: 'SQS_DLQ_URL', value: '${aws_sqs_queue.dlq.id}' },
    ],
    'ai:bedrock': [
        { name: 'BEDROCK_MODEL_ID', value: '{{BEDROCK_MODEL_ID}}' },
    ],
};

export function parseAddArgs(argv = []) {
    const args = [...argv];
    if (args[0] === 'add') args.shift();
    const { options: parsed, rest } = parseFlags(args, {
        string: ['region', 'project-name', 'partition-key', 'model'],
        boolean: ['force', { name: 'headless', key: 'isHeadless' }],
        bareBoolean: ['list-models', 'refresh'],
    });
    const options = {
        partitionKey: DEFAULT_PARTITION_KEY,
        model: DEFAULT_BEDROCK_MODEL,
        modelProvided: false,
        listModels: false,
        refresh: false,
        isHeadless: false,
        force: false,
        ...parsed,
    };
    if (parsed.model !== undefined) options.modelProvided = true;
    for (const arg of rest) {
        if (typeof arg === 'string' && !arg.startsWith('-') && options.capability === undefined) {
            options.capability = arg;
        }
    }
    return options;
}

// Locates the first `environment = [...]` array of the primary container in
// `aws_ecs_task_definition."<taskDefinitionName>"`. Returns the bracket
// bounds or null when the resource or array cannot be found.
function findEnvBlockBounds(content, taskDefinitionName) {
    const resourceIdx = content.indexOf(`resource "aws_ecs_task_definition" "${taskDefinitionName}"`);
    if (resourceIdx === -1) return null;
    const envPattern = /environment\s*=\s*\[/g;
    envPattern.lastIndex = resourceIdx;
    const match = envPattern.exec(content);
    if (!match) return null;
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
    if (closeIdx === -1) return null;
    return { openIdx, closeIdx };
}

function envNameExists(block, name) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) return false;
    const exists = new RegExp(`"name"\\s*[:=]\\s*"${name}"|\\bname\\s*=\\s*"${name}"`);
    return exists.test(block);
}

function escapeRegExp(raw) {
    return String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Finds the `{ ... }` object enclosing `index` by brace depth. Interpolation
// braces inside quoted values (`${...}`) net to zero, so they never disturb
// the count. Returns null when the index is not inside an object.
function enclosingBraceBounds(text, index) {
    let openIdx = -1;
    let depth = 0;
    for (let i = index - 1; i >= 0; i--) {
        if (text[i] === '}') depth++;
        else if (text[i] === '{') {
            if (depth === 0) {
                openIdx = i;
                break;
            }
            depth--;
        }
    }
    if (openIdx === -1) return null;
    depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) return { openIdx, closeIdx: i };
        }
    }
    return null;
}

// Replaces the `value` of the `{ name = "<name>", value = "..." }` object
// inside an environment block, in either HCL or JSON spelling. Returns the
// block unchanged when the entry is missing or already holds newValue.
function upsertEnvValueInBlock(block, name, newValue) {
    const namePattern = new RegExp(`(?:"name"|name)\\s*[:=]\\s*"${escapeRegExp(name)}"`);
    const nameMatch = namePattern.exec(block);
    if (!nameMatch) return block;
    const bounds = enclosingBraceBounds(block, nameMatch.index);
    if (!bounds) return block;
    const objText = block.slice(bounds.openIdx, bounds.closeIdx + 1);
    const valuePattern = /((?:"value"|value)\s*[:=]\s*")([^"]*)(")/;
    const valueMatch = objText.match(valuePattern);
    if (!valueMatch || valueMatch[2] === newValue) return block;
    const replacement = objText.replace(valuePattern, () => `${valueMatch[1]}${newValue}${valueMatch[3]}`);
    return block.slice(0, bounds.openIdx) + replacement + block.slice(bounds.closeIdx + 1);
}

// Inserts { name, value } entries into the first `environment = [...]` array
// of the primary container in `aws_ecs_task_definition."<taskDefinitionName>"`
// (`"app"` for main.tf, `"worker"` for worker.tf), skipping keys that already
// exist so reruns (e.g. with --force) stay idempotent — except keys listed in
// `options.upsertKeys`, whose values are replaced in place (Day-2 switching
// for `BEDROCK_MODEL_ID`, migration refreshes like `REDIS_URL`). Returns the
// content unchanged when the resource or array cannot be found.
export function injectContainerEnvVars(tfContent, envEntries = [], taskDefinitionName = 'app', options = {}) {
    if (typeof taskDefinitionName === 'object' && taskDefinitionName !== null) {
        options = taskDefinitionName;
        taskDefinitionName = options.taskDefinitionName || 'app';
    }
    if (!Array.isArray(envEntries) || envEntries.length === 0) return tfContent;
    const content = String(tfContent ?? '');
    const upsertKeys = new Set(options.upsertKeys || []);

    const bounds = findEnvBlockBounds(content, taskDefinitionName);
    if (!bounds) return content;
    const { openIdx, closeIdx } = bounds;

    const block = content.slice(openIdx, closeIdx + 1);
    const missing = envEntries.filter(({ name }) => !envNameExists(block, name));
    let updated = content;
    if (missing.length > 0) {
        const inner = content.slice(openIdx + 1, closeIdx);
        const glue = inner.trim() === '' ? '\n        ' : ',\n        ';
        const insertion = missing
            .map(({ name, value }) => `{ name = "${name}", value = "${value}" }`)
            .join(',\n        ');
        updated = `${content.slice(0, closeIdx)}${glue}${insertion}\n      ${content.slice(closeIdx)}`;
    }

    const upserts = envEntries.filter(({ name }) => upsertKeys.has(name));
    if (upserts.length === 0) return updated;
    const upsertBounds = findEnvBlockBounds(updated, taskDefinitionName);
    if (!upsertBounds) return updated;
    let upsertBlock = updated.slice(upsertBounds.openIdx, upsertBounds.closeIdx + 1);
    for (const { name, value } of upserts) {
        upsertBlock = upsertEnvValueInBlock(upsertBlock, name, value);
    }
    return updated.slice(0, upsertBounds.openIdx) + upsertBlock + updated.slice(upsertBounds.closeIdx + 1);
}

// Queue-depth auto-scaling for the dedicated ECS worker service. Rendered
// active when terraform/worker.tf exists, otherwise commented out so users
// can uncomment it after adding a worker. Application Auto Scaling creates
// the AWSServiceRoleForApplicationAutoScaling_ECSService service-linked
// role automatically upon target registration.
export const WORKER_AUTOSCALING_HCL = `# --- SQS Queue-Depth Auto-Scaling (worker service only) ---
# Scales aws_ecs_service.worker between 0 and 5 tasks. Never attach
# min_capacity = 0 scaling to aws_ecs_service.app (it serves HTTP traffic).
resource "aws_appautoscaling_target" "worker_scale" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/\${aws_ecs_cluster.main.name}/\${aws_ecs_service.worker.name}"
  min_capacity       = 0
  max_capacity       = 5
}

resource "aws_appautoscaling_policy" "worker_scale_out" {
  name               = "\${local.app_name}-worker-scale-out"
  service_namespace  = aws_appautoscaling_target.worker_scale.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker_scale.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker_scale.resource_id
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type = "ChangeInCapacity"
    cooldown        = 60

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "sqs_queue_high" {
  alarm_name          = "\${local.app_name}-sqs-queue-high"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Average"
  threshold           = 1

  dimensions = {
    QueueName = aws_sqs_queue.main.name
  }

  alarm_actions = [aws_appautoscaling_policy.worker_scale_out.arn]
}

resource "aws_appautoscaling_policy" "worker_scale_in" {
  name               = "\${local.app_name}-worker-scale-in"
  service_namespace  = aws_appautoscaling_target.worker_scale.service_namespace
  scalable_dimension = aws_appautoscaling_target.worker_scale.scalable_dimension
  resource_id        = aws_appautoscaling_target.worker_scale.resource_id
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type = "ChangeInCapacity"
    cooldown        = 300

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -5
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "sqs_queue_empty" {
  alarm_name          = "\${local.app_name}-sqs-queue-empty"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 5
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0

  dimensions = {
    QueueName = aws_sqs_queue.main.name
  }

  alarm_actions = [aws_appautoscaling_policy.worker_scale_in.arn]
}`;

export function renderWorkerAutoscalingBlock(hasWorker) {
    if (hasWorker) return WORKER_AUTOSCALING_HCL;
    return WORKER_AUTOSCALING_HCL.split('\n')
        .map((line) => (line === '' ? '#' : `# ${line}`))
        .join('\n');
}

function renderAddonTemplate(templateName, { region, partitionKey, model, hasWorker }) {
    const raw = fsSync.readFileSync(path.join(TEMPLATES_DIR, templateName), 'utf-8');
    return raw
        .replaceAll('{{REGION}}', region)
        .replaceAll('{{PARTITION_KEY}}', partitionKey)
        .replaceAll('{{BEDROCK_MODEL_ID}}', model ?? DEFAULT_BEDROCK_MODEL)
        .replaceAll('{{WORKER_AUTOSCALING_BLOCK}}', renderWorkerAutoscalingBlock(hasWorker === true));
}

// Idempotently adds `lifecycle { ignore_changes = [desired_count] }` to
// `aws_ecs_service.worker` so queue-depth auto-scaling does not cause
// Terraform drift on existing projects. Returns the content unchanged when
// the resource is missing or already ignores changes.
export function ensureWorkerDesiredCountLifecycle(workerTfContent) {
    const content = String(workerTfContent ?? '');
    const resourceIdx = content.indexOf('resource "aws_ecs_service" "worker"');
    if (resourceIdx === -1) return content;
    const openIdx = content.indexOf('{', resourceIdx);
    if (openIdx === -1) return content;

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
        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                closeIdx = i;
                break;
            }
        }
    }
    if (closeIdx === -1) return content;

    const block = content.slice(openIdx, closeIdx + 1);
    if (block.includes('ignore_changes')) return content;

    const insertion = '\n  lifecycle {\n    ignore_changes = [desired_count]\n  }\n';
    return `${content.slice(0, closeIdx)}${insertion}${content.slice(closeIdx)}`;
}

async function promptBedrockProvider(catalog) {
    const providerOptions = catalog.providers.map((group) => ({
        value: group.provider,
        label: group.provider,
        hint: group.models.map((entry) => entry.name).slice(0, 3).join(', '),
    }));
    providerOptions.push({ value: CUSTOM_MODEL_VALUE, label: 'Custom model ID...' });
    return select({ message: 'Choose a Bedrock provider:', options: providerOptions });
}

async function promptBedrockModel(group) {
    const modelOptions = group.models.map((entry) => ({
        value: entry.id,
        label: `${entry.name} (${entry.id})`,
        hint: entry.hint,
    }));
    modelOptions.push({ value: CUSTOM_MODEL_VALUE, label: 'Custom model ID...' });
    return select({ message: `Choose a ${group.provider} model:`, options: modelOptions });
}

async function promptCustomModelId() {
    return text({ message: 'Enter a Bedrock model ID:', placeholder: DEFAULT_BEDROCK_MODEL });
}

// Renders the model catalog as scannable provider sections: one header line
// per provider plus a `• id — hint` bullet per model. Returns one block per
// provider (callers log each block once, keeping bullets contiguous instead
// of separated by logger chrome). Groups that normalize to the same provider
// (live data spells some two ways: writer/Writer, moonshotai/Moonshot AI)
// merge into a single section.
export function formatCatalogListing(catalog) {
    const grouped = new Map();
    for (const group of catalog?.providers || []) {
        const name = normalizeProviderName(group?.provider);
        if (!grouped.has(name)) grouped.set(name, []);
        grouped.get(name).push(...(group?.models || []));
    }
    const blocks = [];
    for (const [name, models] of grouped) {
        const lines = [`${color.bold(name)} (${models.length}):`];
        for (const model of models) {
            const scopeTag = Array.isArray(model.scopes) && model.scopes.length > 1
                ? ` [${model.scopes.join(', ')}]`
                : '';
            lines.push(`  ${color.cyan(`• ${model.id}`)}${scopeTag} — ${color.dim(model.hint || GENERIC_MODEL_HINT)}`);
        }
        blocks.push(lines.join('\n'));
    }
    return blocks;
}

export async function runAdd(options = {}) {
    const explicitModel = options.modelProvided === true || (options.model !== undefined && options.modelProvided !== false);
    const cwd = options.cwd || process.cwd();
    const capability = typeof options.capability === 'string' ? options.capability.trim() : '';
    const partitionKey = options.partitionKey ?? DEFAULT_PARTITION_KEY;
    let model = options.model ?? DEFAULT_BEDROCK_MODEL;
    const force = options.force === true || options.force === 'true';
    const addon = ADDON_REGISTRY[capability];
    const projectName = resolveProjectName(options, cwd);

    intro(color.bgCyan(color.black(' deploy-stack add 🧩 ')));

    if (!addon) {
        return failCommand({
            print: () => {
                console.log(color.red(`\n✖ Unknown capability "${capability || 'none'}".`));
                console.log(`  Supported capabilities: ${color.cyan(Object.keys(ADDON_REGISTRY).join(', '))}\n`);
            },
            event: 'add_run',
            telemetry: { capability: capability || 'none', error_code: 'UNSUPPORTED_CAPABILITY' },
            reason: 'unsupported-capability',
            resultExtra: { capability: capability || 'none' },
        });
    }

    const failInvalidModel = (badModel) => failCommand({
        message: `\n✖ Invalid model ID "${badModel}".`,
        hint: `  Use only letters, numbers, underscore, dot, colon, and hyphen (e.g. --model ${DEFAULT_BEDROCK_MODEL}).\n`,
        event: 'add_run',
        telemetry: { projectName, capability, error_code: 'INVALID_MODEL_ID' },
        reason: 'invalid-model-id',
        resultExtra: { capability, projectName },
    });

    const cancelSelection = () => failCommand({
        print: () => cancel('Model selection cancelled.'),
        event: 'add_run',
        telemetry: { projectName, capability, reason: 'cancelled' },
        reason: 'cancelled',
        exitCode: null,
    });

    // --partition-key only applies to db:dynamodb; other addons ignore it.
    if (capability === 'db:dynamodb' && !PARTITION_KEY_RE.test(String(partitionKey))) {
        return failCommand({
            message: `\n✖ Invalid partition key "${partitionKey}".`,
            hint: '  Use only letters, numbers, underscore, hyphen, and dot (e.g. --partition-key userId).\n',
            event: 'add_run',
            telemetry: { projectName, capability, error_code: 'INVALID_PARTITION_KEY' },
            reason: 'invalid-partition-key',
            resultExtra: { capability, projectName },
        });
    }

    // --model only applies to ai:bedrock; other addons ignore it.
    if (capability === 'ai:bedrock' && !MODEL_ID_RE.test(String(model))) {
        return failInvalidModel(model);
    }

    // --refresh fetches live models before listing or provisioning.
    let heldCatalog = null;
    if (capability === 'ai:bedrock' && options.refresh) {
        const s = spinner();
        s.start('Refreshing Bedrock model catalog from AWS...');
        heldCatalog = await refreshBedrockCatalog({
            bedrockClient: options.bedrockClient,
            cachePath: options.cachePath,
            region: options.region,
        });
        s.stop('Bedrock model catalog refreshed.');
    }

    // --list-models works anywhere, even outside a Terraform project.
    if (capability === 'ai:bedrock' && options.listModels) {
        const catalog = heldCatalog || loadBedrockCatalog({ cachePath: options.cachePath });
        for (const block of formatCatalogListing(catalog)) {
            log.info(block);
        }
        outro(`Bedrock catalog ready — ${catalog.providers.length} providers (updated ${catalog.updatedAt}).`);
        await trackSuccess('add_run', { projectName, capability, action: 'list_models' });
        return { ok: true, action: 'list-models', models: catalog.providers };
    }

    const mainTfPath = path.join(cwd, 'terraform', 'main.tf');
    if (!fsSync.existsSync(mainTfPath)) {
        return failCommand({
            message: '\n✖ No terraform/main.tf found. Run "deploy-stack init" first before adding services.\n',
            event: 'add_run',
            telemetry: { capability, error_code: 'TERRAFORM_NOT_INITIALIZED' },
            reason: 'terraform-not-initialized',
            resultExtra: { capability },
        });
    }

    // Interactive model selection runs only on real TTYs without an explicit
    // model, so headless runs, CI, and unit tests never block on prompts.
    const isInteractive = options.interactive ?? (
        !options.isHeadless &&
        !isActiveEnvValue(process.env.CI) &&
        !isActiveEnvValue(process.env.VITEST) &&
        process.env.NODE_ENV !== 'test' &&
        Boolean(process.stdout?.isTTY)
    );
    let selectedInteractively = false;
    let customTypedModel = false;
    if (capability === 'ai:bedrock' && isInteractive && !explicitModel) {
        const catalog = heldCatalog || loadBedrockCatalog({ cachePath: options.cachePath });
        const providerChoice = await promptBedrockProvider(catalog);
        if (isCancel(providerChoice)) return cancelSelection();
        if (providerChoice === CUSTOM_MODEL_VALUE) {
            const custom = await promptCustomModelId();
            if (isCancel(custom)) return cancelSelection();
            model = String(custom).trim();
            if (!MODEL_ID_RE.test(model)) return failInvalidModel(model);
            customTypedModel = true;
        } else {
            const group = catalog.providers.find((candidate) => candidate.provider === providerChoice);
            const modelChoice = await promptBedrockModel(group);
            if (isCancel(modelChoice)) return cancelSelection();
            if (modelChoice === CUSTOM_MODEL_VALUE) {
                const custom = await promptCustomModelId();
                if (isCancel(custom)) return cancelSelection();
                model = String(custom).trim();
                if (!MODEL_ID_RE.test(model)) return failInvalidModel(model);
                customTypedModel = true;
            } else {
                model = modelChoice;
            }
        }
        selectedInteractively = true;
    }

    const region = resolveRegion(options, cwd);
    if (capability === 'ai:bedrock' && !explicitModel && !customTypedModel) {
        // Catalog-derived IDs (default or picker choice) align to the
        // project's region; user-typed IDs stay verbatim.
        const catalog = heldCatalog || loadBedrockCatalog({ cachePath: options.cachePath });
        model = resolveModelIdForRegion(findCatalogEntry(catalog, model) || model, region);
    }
    const targetPath = path.join(cwd, 'terraform', addon.file);
    if (fsSync.existsSync(targetPath) && !force) {
        const canSwitchBedrock = capability === 'ai:bedrock' && (explicitModel || selectedInteractively);
        if (!canSwitchBedrock) {
            return failCommand({
                message: `\n⚠ terraform/${addon.file} already exists. Pass --force to overwrite.\n`,
                tone: 'yellow',
                event: 'add_run',
                telemetry: { projectName, capability, error_code: 'ADDON_ALREADY_EXISTS' },
                reason: 'addon-already-exists',
                resultExtra: { capability, projectName, region },
                exitCode: null,
            });
        }
    }

    const workerTfPath = path.join(cwd, 'terraform', 'worker.tf');
    const hasWorker = fsSync.existsSync(workerTfPath);
    const rendered = renderAddonTemplate(addon.template, { region, partitionKey, model, hasWorker });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, rendered);

    const envVars = (ADDON_ENV_VARS[capability] || []).map(({ name, value }) => ({
        name,
        value: String(value).replaceAll('{{BEDROCK_MODEL_ID}}', model),
    }));
    const upsertKeys = { 'ai:bedrock': ['BEDROCK_MODEL_ID'], 'db:redis': ['REDIS_URL'] }[capability];
    const injectOptions = upsertKeys ? { upsertKeys } : {};
    const mainTfContent = await fs.readFile(mainTfPath, 'utf-8');
    const updated = injectContainerEnvVars(mainTfContent, envVars, 'app', injectOptions);
    const envInjected = updated !== mainTfContent;
    if (envInjected) {
        await fs.writeFile(mainTfPath, updated);
    }

    let workerEnvInjected = false;
    if (hasWorker) {
        const workerTfContent = await fs.readFile(workerTfPath, 'utf-8');
        const updatedWorker = injectContainerEnvVars(workerTfContent, envVars, 'worker', injectOptions);
        workerEnvInjected = updatedWorker !== workerTfContent;
        let finalWorker = updatedWorker;
        if (capability === 'queue:sqs') {
            finalWorker = ensureWorkerDesiredCountLifecycle(updatedWorker);
        }
        if (finalWorker !== workerTfContent) {
            await fs.writeFile(workerTfPath, finalWorker);
        }
    }

    console.log(color.green(`\n✅ Created terraform/${addon.file}${envInjected ? ' and injected container environment variables' : ''}.`));
    if (workerEnvInjected) {
        console.log(`  ${color.dim('worker:')} injected container environment variables into terraform/worker.tf`);
    }
    for (const { name } of envVars) {
        console.log(`  ${color.dim('env:')} ${color.cyan(name)}`);
    }
    console.log(color.yellow(`\n💰 Cost Impact: ${addon.cost.summary}`));

    await syncDocCostEstimate(cwd);

    outro(
        `Run ${color.green('deploy-stack apply')} (or commit and push to trigger CI) to provision ${capability}. ` +
        `Available in your container as ${envVars.map((e) => e.name).join(', ')}.`
    );
    await trackSuccess('add_run', { projectName, capability });
    return { ok: true, capability, projectName, region, file: `terraform/${addon.file}`, envInjected };
}

export default runAdd;
