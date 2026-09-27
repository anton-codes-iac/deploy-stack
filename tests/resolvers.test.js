import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readTerraformProjectName, resolveProjectName, resolveRegion, resolveLogGroup } from '../src/utils/resolvers.js';

let tmpDirs = [];

function makeTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolvers-test-'));
    tmpDirs.push(dir);
    return dir;
}

beforeEach(() => {
    tmpDirs = [];
});

afterEach(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('readTerraformProjectName', () => {
    it('returns null when terraform/main.tf is missing', () => {
        expect(readTerraformProjectName(makeTmp())).toBeNull();
    });

    it('extracts the project name from local.app_name', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "myapp${local.env_suffix}"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBe('myapp');
    });

    it('falls back to the aws_ecr_repository app name', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'resource "aws_ecr_repository" "app" {\n  name = "fallback-app-repo"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBe('fallback-app');
    });

    it('returns null when neither pattern matches', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'terraform', 'main.tf'), 'provider "aws" {}\n');
        expect(readTerraformProjectName(dir)).toBeNull();
    });

    it('prefers a plain app_name over the ECR repository heuristic', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "billing-app"\n}\nresource "aws_ecr_repository" "app" {\n  name = "other-repo"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBe('billing-app');
    });

    it('strips ${...} suffixes and trailing separators from a plain app_name', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "billing-app-${var.env}"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBe('billing-app');
    });

    it('ignores unrendered template placeholders', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "{{PROJECT_NAME}}"\n}\n'
        );
        expect(readTerraformProjectName(dir)).toBeNull();
    });
});

describe('resolveProjectName', () => {
    it('prefers an explicit --project-name option', () => {
        const dir = makeTmp();
        expect(resolveProjectName({ projectName: 'explicit' }, dir)).toBe('explicit');
    });

    it('reads the rendered terraform/main.tf before the directory basename', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "tf-app${local.env_suffix}"\n}\n'
        );
        expect(resolveProjectName({}, dir)).toBe('tf-app');
    });

    it('falls back to the directory basename', () => {
        const dir = makeTmp();
        expect(resolveProjectName({}, dir)).toBe(path.basename(dir));
    });

    it('still resolves the region from flags as before', () => {
        expect(resolveRegion({ region: 'eu-west-1' }, makeTmp())).toBe('eu-west-1');
    });

    it('reads a plain app_name the same way for every consumer', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'terraform'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'terraform', 'main.tf'),
            'locals {\n  app_name = "billing-app"\n}\nresource "aws_ecr_repository" "app" {\n  name = "other-repo"\n}\n'
        );
        expect(resolveProjectName({}, dir)).toBe('billing-app');
    });
});

describe('resolveLogGroup', () => {
    it('prefers explicit flags, then env, then the project default', () => {
        const dir = makeTmp();
        expect(resolveLogGroup({ logGroup: '  /custom/group  ' }, dir)).toBe('/custom/group');
        expect(resolveLogGroup({ logGroupName: '/named/group' }, dir)).toBe('/named/group');
        process.env.ECS_LOG_GROUP = '/env/group';
        try {
            expect(resolveLogGroup({}, dir)).toBe('/env/group');
        } finally {
            delete process.env.ECS_LOG_GROUP;
        }
        expect(resolveLogGroup({ projectName: 'myapp' }, dir)).toBe('/ecs/myapp');
    });
});
