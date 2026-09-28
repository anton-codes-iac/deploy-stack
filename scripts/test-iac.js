#!/usr/bin/env node
// Local parity check for the Terraform + TFLint steps in
// .github/workflows/iac-validation.yml (no Docker builds or Trivy scans).
// Scaffolds a base project and a full addons + domain project in temp dirs,
// runs `terraform init -backend=false`, `terraform validate`, and (when
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
const pluginCacheDir = path.join(os.tmpdir(), 'deploy-stack-iac-plugin-cache');
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

const ADDONS = 'storage:s3,db:dynamodb,db:redis,queue:sqs,ai:bedrock,email:ses';

// Mirrors the Scaffold steps of the validate-addons job: without these seed
// files init cannot generate worker.tf or the migration gate.
function seedAddonsProject(dir) {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"db:migrate":"prisma migrate deploy"}}');
    fs.writeFileSync(path.join(dir, 'Procfile'), 'web: node index.js\nworker: node worker.js\n');
}

function assertAddonsFiles(dir) {
    for (const file of ['terraform/database.tf', 'terraform/ses.tf', 'terraform/bedrock.tf', 'terraform/worker.tf', 'terraform/domain.tf']) {
        if (!fs.existsSync(path.join(dir, file))) {
            throw new Error(`expected ${file} to be generated`);
        }
    }
    const deployYml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'utf-8');
    if (!deployYml.includes('deploy-stack:db-migrate-start')) {
        throw new Error('expected the migration gate (deploy-stack:db-migrate-start) in .github/workflows/deploy.yml');
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
];

const failures = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-stack-iac-'));
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
