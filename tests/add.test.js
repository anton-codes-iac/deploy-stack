import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    runAdd,
    parseAddArgs,
    injectContainerEnvVars,
    ADDON_REGISTRY,
    DEFAULT_PARTITION_KEY,
} from '../src/commands/add.js';
import { syncDocCostEstimate, COST_ESTIMATE_MARKER, LEGACY_COST_ESTIMATE_MARKER } from '../src/utils/visualizer.js';
import { trackEvent, flushTelemetry } from '../src/core/telemetry.js';

const S3_ENV = [
    { name: 'S3_BUCKET_NAME', value: '${aws_s3_bucket.storage.id}' },
    { name: 'S3_CDN_URL', value: 'https://${aws_cloudfront_distribution.storage_cdn.domain_name}' },
];

vi.mock('@clack/prompts', () => ({
    intro: vi.fn(),
    outro: vi.fn(),
}));

vi.mock('../src/core/telemetry.js', () => ({
    trackEvent: vi.fn(),
    flushTelemetry: vi.fn().mockResolvedValue(),
}));

let tmpDirs = [];
let exitSpy;

function makeTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-test-'));
    tmpDirs.push(dir);
    return dir;
}

function writeMainTf(dir, environment = '') {
    fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'terraform', 'main.tf'),
        [
            'locals {',
            '  app_name = "myapp${local.env_suffix}"',
            '}',
            '',
            'resource "aws_ecs_task_definition" "app" {',
            '  family = "myapp-task"',
            '  container_definitions = jsonencode([',
            '    {',
            '      name      = "myapp-container"',
            '      essential = true',
            '',
            '      environment = [',
            `        ${environment}`,
            '      ]',
            '    },',
            '    {',
            '      name      = "sidecar"',
            '      essential = true',
            '      environment = [',
            '        { "name": "SIDECAR_VAR", "value": "1" }',
            '      ]',
            '    }',
            '  ])',
            '}',
            '',
        ].join('\n')
    );
}

beforeEach(() => {
    tmpDirs = [];
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
});

afterEach(() => {
    exitSpy.mockRestore();
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('parseAddArgs', () => {
    it('parses the capability positional', () => {
        expect(parseAddArgs(['add', 'storage:s3']).capability).toBe('storage:s3');
        expect(parseAddArgs(['add', 'db:dynamodb']).capability).toBe('db:dynamodb');
    });

    it('defaults the partition key to id and force to false', () => {
        const options = parseAddArgs(['add', 'db:dynamodb']);
        expect(options.partitionKey).toBe(DEFAULT_PARTITION_KEY);
        expect(options.force).toBe(false);
    });

    it('supports --flag value and --flag=value forms', () => {
        const spaced = parseAddArgs(['add', 'db:dynamodb', '--region', 'eu-west-1', '--project-name', 'shop', '--partition-key', 'userId']);
        expect(spaced).toMatchObject({ region: 'eu-west-1', projectName: 'shop', partitionKey: 'userId' });
        const joined = parseAddArgs(['add', 'db:dynamodb', '--region=eu-west-1', '--project-name=shop', '--partition-key=userId']);
        expect(joined).toMatchObject({ region: 'eu-west-1', projectName: 'shop', partitionKey: 'userId' });
    });

    it('supports bare --force as well as --force=true and --force=false', () => {
        expect(parseAddArgs(['add', 'storage:s3', '--force']).force).toBe(true);
        expect(parseAddArgs(['add', 'storage:s3', '--force=true']).force).toBe(true);
        expect(parseAddArgs(['add', 'storage:s3', '--force=false']).force).toBe(false);
    });
});

describe('precondition guards', () => {
    it('fails with TERRAFORM_NOT_INITIALIZED when terraform/main.tf is missing', async () => {
        const result = await runAdd({ cwd: makeTmp(), capability: 'storage:s3' });
        expect(result.ok).toBe(false);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            capability: 'storage:s3',
            success: false,
            error_code: 'TERRAFORM_NOT_INITIALIZED',
        });
        expect(flushTelemetry).toHaveBeenCalled();
    });

    it('fails with UNSUPPORTED_CAPABILITY for unknown or missing capabilities', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'unknown:foo' });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            capability: 'unknown:foo',
            success: false,
            error_code: 'UNSUPPORTED_CAPABILITY',
        });

        vi.clearAllMocks();
        await runAdd({ cwd: dir });
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            capability: 'none',
            success: false,
            error_code: 'UNSUPPORTED_CAPABILITY',
        });
    });

    it('rejects an invalid --partition-key with INVALID_PARTITION_KEY telemetry', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:dynamodb', partitionKey: 'bad key!' });
        expect(result.ok).toBe(false);
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            projectName: 'myapp',
            capability: 'db:dynamodb',
            success: false,
            error_code: 'INVALID_PARTITION_KEY',
        });
        expect(flushTelemetry).toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, 'terraform', 'dynamodb.tf'))).toBe(false);
    });

    it('refuses to overwrite an existing addon file without --force', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const target = path.join(dir, 'terraform', 's3.tf');
        fs.writeFileSync(target, '# user edits — do not clobber\n');
        const result = await runAdd({ cwd: dir, capability: 'storage:s3' });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('addon-already-exists');
        expect(exitSpy).not.toHaveBeenCalled();
        expect(fs.readFileSync(target, 'utf-8')).toBe('# user edits — do not clobber\n');
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            projectName: 'myapp',
            capability: 'storage:s3',
            success: false,
            error_code: 'ADDON_ALREADY_EXISTS',
        });
    });

    it('overwrites the addon file when --force is passed', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const target = path.join(dir, 'terraform', 's3.tf');
        fs.writeFileSync(target, '# stale\n');
        const result = await runAdd({ cwd: dir, capability: 'storage:s3', force: true });
        expect(result.ok).toBe(true);
        expect(fs.readFileSync(target, 'utf-8')).toContain('aws_s3_bucket');
    });
});

describe('injectContainerEnvVars', () => {
    it('injects into the primary container only and stays idempotent', () => {
        const dir = makeTmp();
        writeMainTf(dir, '{ "name": "EXISTING", "value": "1" },');
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        const once = injectContainerEnvVars(before, S3_ENV);
        expect(once).toContain('S3_BUCKET_NAME');
        expect(once).toContain('S3_CDN_URL');
        // Sidecar block is untouched.
        expect(once.match(/SIDECAR_VAR/g)).toHaveLength(1);
        const twice = injectContainerEnvVars(once, S3_ENV);
        expect(twice).toBe(once);
        expect(once.match(/S3_BUCKET_NAME/g)).toHaveLength(1);
    });

    it('skips keys that already exist in either HCL or JSON form', () => {
        const dir = makeTmp();
        writeMainTf(dir, '{ name = "S3_BUCKET_NAME", value = "custom" },');
        const before = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        const after = injectContainerEnvVars(before, S3_ENV);
        expect(after).toContain('S3_CDN_URL');
        expect(after.match(/S3_BUCKET_NAME/g)).toHaveLength(1);
    });

    it('returns content unchanged when the task definition is missing', () => {
        expect(injectContainerEnvVars('provider "aws" {}\n', [{ name: 'X', value: 'Y' }])).toBe('provider "aws" {}\n');
    });
});

describe('generated terraform', () => {
    it('renders s3.tf with the sanitized bucket expression, OAC, AES256, CORS, and task role wiring', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'storage:s3' });
        expect(result.ok).toBe(true);
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 's3.tf'), 'utf-8');
        expect(rendered).toContain(
            '"${trimsuffix(substr(replace(lower(local.app_name), "_", "-"), 0, 42), "-")}-storage-${data.aws_caller_identity.current.account_id}"'
        );
        expect(rendered).toContain('aws_cloudfront_origin_access_control');
        expect(rendered).toContain('sse_algorithm = "AES256"');
        expect(rendered).toContain('aws_s3_bucket_cors_configuration');
        expect(rendered).toContain('role = aws_iam_role.task_role.id');
        expect(rendered).toContain('output "s3_bucket_name"');
        expect(rendered).toContain('output "s3_cdn_domain"');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('S3_BUCKET_NAME');
        expect(mainTf).toContain('S3_CDN_URL');
    });

    it('renders dynamodb.tf with PAY_PER_REQUEST, PITR, gateway endpoint, and task role wiring', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        const result = await runAdd({ cwd: dir, capability: 'db:dynamodb', region: 'eu-west-1', partitionKey: 'userId' });
        expect(result.ok).toBe(true);
        expect(result.region).toBe('eu-west-1');
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'dynamodb.tf'), 'utf-8');
        expect(rendered).toContain('billing_mode = "PAY_PER_REQUEST"');
        expect(rendered).toContain('point_in_time_recovery');
        expect(rendered).toContain('vpc_endpoint_type = "Gateway"');
        expect(rendered).toContain('com.amazonaws.eu-west-1.dynamodb');
        expect(rendered).toContain('[aws_route_table.public.id]');
        expect(rendered).toContain('role = aws_iam_role.task_role.id');
        expect(rendered).toContain('hash_key     = "userId"');
        expect(rendered).not.toContain('{{PARTITION_KEY}}');
        expect(rendered).not.toContain('{{REGION}}');
        const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
        expect(mainTf).toContain('DYNAMODB_TABLE_NAME');
    });

    it('defaults the partition key to id', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'db:dynamodb' });
        const rendered = fs.readFileSync(path.join(dir, 'terraform', 'dynamodb.tf'), 'utf-8');
        expect(rendered).toContain('hash_key     = "id"');
    });

    it('emits a success telemetry event', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'storage:s3' });
        expect(trackEvent).toHaveBeenCalledWith('add_run', {
            projectName: 'myapp',
            capability: 'storage:s3',
            success: true,
        });
        expect(flushTelemetry).toHaveBeenCalled();
    });
});

describe('cost transparency', () => {
    let logSpy;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it('re-exports ADDON_REGISTRY from the shared addons module', async () => {
        const shared = await import('../src/utils/addons.js');
        expect(ADDON_REGISTRY).toBe(shared.ADDON_REGISTRY);
    });

    it('prints the 💰 Cost Impact line with the registry summary', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        await runAdd({ cwd: dir, capability: 'storage:s3' });
        const output = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(output).toContain('💰 Cost Impact:');
        expect(output).toContain(ADDON_REGISTRY['storage:s3'].cost.summary);

        vi.clearAllMocks();
        const dir2 = makeTmp();
        writeMainTf(dir2);
        await runAdd({ cwd: dir2, capability: 'db:dynamodb' });
        const output2 = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
        expect(output2).toContain('💰 Cost Impact:');
        expect(output2).toContain(ADDON_REGISTRY['db:dynamodb'].cost.summary);
    });

    it('syncs the cost baseline into README.md and lists active addons', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        fs.writeFileSync(
            path.join(dir, 'README.md'),
            `# myapp\n\n* **${LEGACY_COST_ESTIMATE_MARKER}** ~$9.99 / month\n\n## Usage\n`
        );
        await runAdd({ cwd: dir, capability: 'storage:s3' });
        const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf-8');
        expect(readme).not.toContain('~$9.99');
        expect(readme).toContain(COST_ESTIMATE_MARKER);
        expect(readme).toContain('### Active Addons (Usage-Based)');
        expect(readme).toContain('`storage:s3`');
    });

    it('prefers DEPLOYMENT.md over README.md and replaces reruns idempotently', async () => {
        const dir = makeTmp();
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'README.md'), `# myapp\n\n* **${LEGACY_COST_ESTIMATE_MARKER}** ~$9.99 / month\n`);
        fs.writeFileSync(path.join(dir, 'DEPLOYMENT.md'), `# deploy\n\n* **${LEGACY_COST_ESTIMATE_MARKER}** ~$9.99 / month\n`);
        await runAdd({ cwd: dir, capability: 'storage:s3', force: true });
        await runAdd({ cwd: dir, capability: 'db:dynamodb', force: true });
        // README.md untouched; DEPLOYMENT.md updated once per addon, no duplicates.
        expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf-8')).toContain('~$9.99');
        const deployment = fs.readFileSync(path.join(dir, 'DEPLOYMENT.md'), 'utf-8');
        expect(deployment).not.toContain('~$9.99');
        expect(deployment.match(/### Active Addons \(Usage-Based\)/g)).toHaveLength(1);
        expect(deployment).toContain('`storage:s3`');
        expect(deployment).toContain('`db:dynamodb`');
    });

    it('syncDocCostEstimate no-ops without a marker or terraform project', () => {
        const dir = makeTmp();
        writeMainTf(dir);
        fs.writeFileSync(path.join(dir, 'README.md'), '# myapp\n\nNo cost section here.\n');
        expect(syncDocCostEstimate(dir)).toBeNull();
        expect(syncDocCostEstimate(makeTmp())).toBeNull();
    });
});
