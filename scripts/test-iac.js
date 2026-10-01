#!/usr/bin/env node
// Local parity check for the Terraform + TFLint steps in
// .github/workflows/iac-validation.yml (no Docker builds or Trivy scans).
// Scaffolds a base project, a full addons + domain project, one project per
// non-default database engine, and the Lambda equivalents (base, full
// Aurora addons + domain, MySQL conversion) in temp dirs, runs
// `terraform init -backend=false`, `terraform validate`, and (when
// installed) `tflint --init` + `tflint` in each, then cleans up.
// Exits non-zero on any failure. Run with: npm run test:iac
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');

// Shared provider cache across runs so the second project (and repeat runs)
// skip re-downloading providers. Lives outside the per-run temp root so
// cleanup never deletes it.
const pluginCacheDir = path.join(os.tmpdir(), 'grada-iac-plugin-cache');
fs.mkdirSync(pluginCacheDir, { recursive: true });

const baseEnv = {
    ...process.env,
    CI_MOCK_AWS: 'true',
    DO_NOT_TRACK: '1',
    TF_PLUGIN_CACHE_DIR: pluginCacheDir,
};

function section(title) {
    console.log(`\n=== ${title} ===`);
}

function run(cmd, args, options) {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, { stdio: 'inherit', ...options });
}

function commandExists(cmd) {
    try {
        execFileSync(cmd, ['--version'], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

if (!commandExists('terraform')) {
    console.error('ERROR: terraform is not installed. Install it (https://developer.hashicorp.com/terraform/install) and re-run.');
    process.exit(1);
}

const tflintAvailable = commandExists('tflint');
if (!tflintAvailable) {
    console.log('WARNING: tflint not found on PATH — lint steps will be skipped. Install it with `brew install tflint` (macOS) or see https://github.com/terraform-linters/tflint, then re-run.');
}

function checkTerraform(terraformDir) {
    run('terraform', ['init', '-backend=false'], { cwd: terraformDir, env: baseEnv });
    run('terraform', ['validate'], { cwd: terraformDir, env: baseEnv });
    if (tflintAvailable) {
        run('tflint', ['--init'], { cwd: terraformDir, env: baseEnv });
        run('tflint', [], { cwd: terraformDir, env: baseEnv });
    }
}

const ADDONS = 'storage:s3,db:dynamodb,db:redis,queue:sqs,ai:bedrock,email:ses,cron';

// Mirrors the Scaffold steps of the validate-addons job: without these seed
// files init cannot generate worker.tf or the migration gate.
function seedAddonsProject(dir) {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"db:migrate":"prisma migrate deploy"}}');
    fs.writeFileSync(path.join(dir, 'Procfile'), 'web: node index.js\nworker: node worker.js\n');
}

// Lambda variant: web-only Procfile (Lambda targets run a single function,
// so worker processes are skipped) plus a migration script (the ECS-based
// migration gate is skipped with a warning on Lambda).
function seedLambdaAddonsProject(dir) {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"db:migrate":"prisma migrate deploy"}}');
    fs.writeFileSync(path.join(dir, 'Procfile'), 'web: node index.js\n');
}

function assertAddonsFiles(dir) {
    for (const file of ['terraform/database.tf', 'terraform/ses.tf', 'terraform/bedrock.tf', 'terraform/cron.tf', 'terraform/worker.tf', 'terraform/domain.tf']) {
        if (!fs.existsSync(path.join(dir, file))) {
            throw new Error(`expected ${file} to be generated`);
        }
    }
    const deployYml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
    if (!deployYml.includes('grada:db-migrate-start')) {
        throw new Error('expected the migration gate (grada:db-migrate-start) in .github/workflows/deploy.yml');
    }
}

function assertEngineFiles(dir, engine, marker) {
    const databaseTf = fs.readFileSync(path.join(dir, 'terraform', 'database.tf'), 'utf-8');
    if (!databaseTf.includes(marker)) {
        throw new Error(`expected ${marker} in terraform/database.tf for --db-engine=${engine}`);
    }
}

function engineProject(engine, marker) {
    return {
        name: `engine: ${engine}`,
        dirName: `test-app-engine-${engine}`,
        steps() {
            return [
                ['scaffold', () => run('node', [CLI, 'init', '--headless', '--framework=node', '--needsDatabase', '--db-engine', engine], { cwd: this.dir, env: baseEnv })],
                ['assert files', () => assertEngineFiles(this.dir, engine, marker)],
                ['terraform', () => checkTerraform(path.join(this.dir, 'terraform'))],
            ];
        },
    };
}

function assertLambdaBaseFiles(dir) {
    const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
    for (const marker of [
        'resource "aws_lambda_function" "app"',
        'resource "aws_apigatewayv2_api" "main"',
        'ignore_changes = [image_uri]',
        'output "api_gateway_url"',
    ]) {
        if (!mainTf.includes(marker)) throw new Error(`expected ${marker} in terraform/main.tf`);
    }
    if (mainTf.includes('aws_ecs_service')) throw new Error('expected no ECS resources in terraform/main.tf');
    const cloudfrontTf = fs.readFileSync(path.join(dir, 'terraform', 'cloudfront.tf'), 'utf-8');
    if (!cloudfrontTf.includes('origin_protocol_policy = "https-only"')) {
        throw new Error('expected the https-only API Gateway origin in terraform/cloudfront.tf');
    }
    const dockerfile = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf-8');
    if (!dockerfile.includes('aws-lambda-adapter')) throw new Error('expected the Lambda Web Adapter in Dockerfile');
    const deployYml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
    if (!deployYml.includes('aws lambda update-function-code')) {
        throw new Error('expected update-function-code in .github/workflows/deploy.yml');
    }
    if (fs.existsSync(path.join(dir, 'terraform', 'worker.tf'))) {
        throw new Error('expected no terraform/worker.tf on a lambda project');
    }
}

function assertLambdaAddonsFiles(dir) {
    for (const file of ['terraform/database.tf', 'terraform/ses.tf', 'terraform/bedrock.tf', 'terraform/cron.tf', 'terraform/redis.tf', 'terraform/domain.tf']) {
        if (!fs.existsSync(path.join(dir, file))) {
            throw new Error(`expected ${file} to be generated`);
        }
    }
    const mainTf = fs.readFileSync(path.join(dir, 'terraform', 'main.tf'), 'utf-8');
    if (!mainTf.includes('vpc_config {')) throw new Error('expected vpc_config in terraform/main.tf');
    if (!mainTf.includes('REDIS_URL = ')) throw new Error('expected REDIS_URL in the function variables map');
    if (!mainTf.includes('image_config {')) throw new Error('expected image_config from the Procfile web command');
    const cronTf = fs.readFileSync(path.join(dir, 'terraform', 'cron.tf'), 'utf-8');
    if (!cronTf.includes('aws_lambda_function.app.arn')) throw new Error('expected the Lambda scheduler target in terraform/cron.tf');
    const databaseTf = fs.readFileSync(path.join(dir, 'terraform', 'database.tf'), 'utf-8');
    if (!databaseTf.includes('resource "random_password" "db_password"')) {
        throw new Error('expected random_password.db_password in terraform/database.tf');
    }
    const deployYml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
    if (deployYml.includes('grada:db-migrate-start')) {
        throw new Error('expected no ECS migration gate in the lambda deploy workflow');
    }
}

const projects = [
    {
        name: 'base (no domain)',
        dirName: 'test-app-base',
        steps() {
            return [
                ['scaffold', () => run('node', [CLI, 'init', '--headless', '--framework=node', '--needsDatabase'], { cwd: this.dir, env: baseEnv })],
                ['terraform', () => checkTerraform(path.join(this.dir, 'terraform'))],
            ];
        },
    },
    engineProject('mysql', 'engine            = "mysql"'),
    engineProject('aurora-postgresql', 'resource "aws_rds_cluster" "postgres"'),
    {
        name: 'addons + domain',
        dirName: 'test-app-addons',
        steps() {
            return [
                ['seed', () => seedAddonsProject(this.dir)],
                ['scaffold', () => run('node', [CLI, 'init', '--headless', '--framework=node', '--needsDatabase', '--with', ADDONS, '--domain', 'example.com', '--zone-id', 'Z1234567890ABC', '--setup-ci-migrate'], { cwd: this.dir, env: baseEnv })],
                ['domain add', () => run('node', [CLI, 'domain', 'add', 'example.com', '--zone-id', 'Z1234567890ABC'], { cwd: this.dir, env: baseEnv })],
                ['assert files', () => assertAddonsFiles(this.dir)],
                ['terraform', () => checkTerraform(path.join(this.dir, 'terraform'))],
            ];
        },
    },
    {
        name: 'lambda base (no domain)',
        dirName: 'test-app-lambda-base',
        steps() {
            return [
                ['scaffold', () => run('node', [CLI, 'init', '--headless', '--framework=node', '--target', 'lambda'], { cwd: this.dir, env: baseEnv })],
                ['assert files', () => assertLambdaBaseFiles(this.dir)],
                ['terraform', () => checkTerraform(path.join(this.dir, 'terraform'))],
            ];
        },
    },
    {
        name: 'lambda aurora + addons + domain',
        dirName: 'test-app-lambda-addons',
        steps() {
            return [
                ['seed', () => seedLambdaAddonsProject(this.dir)],
                ['scaffold', () => run('node', [CLI, 'init', '--headless', '--framework=node', '--target', 'lambda', '--needsDatabase', '--db-engine', 'aurora-postgresql', '--with', ADDONS, '--domain', 'example.com', '--zone-id', 'Z1234567890ABC', '--setup-ci-migrate'], { cwd: this.dir, env: baseEnv })],
                ['domain add', () => run('node', [CLI, 'domain', 'add', 'example.com', '--zone-id', 'Z1234567890ABC'], { cwd: this.dir, env: baseEnv })],
                ['assert files', () => assertLambdaAddonsFiles(this.dir)],
                ['terraform', () => checkTerraform(path.join(this.dir, 'terraform'))],
            ];
        },
    },
    {
        name: 'lambda mysql (instance conversion)',
        dirName: 'test-app-lambda-mysql',
        steps() {
            return [
                ['scaffold', () => run('node', [CLI, 'init', '--headless', '--framework=node', '--target', 'lambda', '--needsDatabase', '--db-engine', 'mysql'], { cwd: this.dir, env: baseEnv })],
                ['assert files', () => assertEngineFiles(this.dir, 'mysql', 'engine            = "mysql"')],
                ['terraform', () => checkTerraform(path.join(this.dir, 'terraform'))],
            ];
        },
    },
];

const failures = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grada-iac-'));
console.log(`Working directory: ${tmpRoot}`);
try {
    for (const project of projects) {
        project.dir = path.join(tmpRoot, project.dirName);
        fs.mkdirSync(project.dir, { recursive: true });
        section(`Project: ${project.name}`);
        for (const [stepName, stepFn] of project.steps()) {
            try {
                stepFn();
            } catch (error) {
                failures.push({ project: project.name, step: stepName, error });
                console.error(`FAILED: ${project.name} / ${stepName}: ${error.message}`);
                break;
            }
        }
    }
} finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log(`Cleaned up: ${tmpRoot}`);
}

if (failures.length > 0) {
    console.error(`\nIaC validation FAILED (${failures.length} failing step${failures.length === 1 ? '' : 's'}):`);
    for (const failure of failures) {
        console.error(`  - ${failure.project} / ${failure.step}`);
    }
    process.exit(1);
}

console.log('\nIaC validation passed.');
