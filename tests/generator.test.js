import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { generateTemplates } from '../src/utils/generator.js';

describe('Infrastructure Generator', () => {
    const testTargetDir = path.join(process.cwd(), 'tests', '.tmp-test-env');

    beforeAll(async () => {
        await fs.mkdir(testTargetDir, { recursive: true });
    });

    afterAll(async () => {
        await fs.rm(testTargetDir, { recursive: true, force: true });
    });

    it('generates correct terraform output for a standard Postgres architecture', async () => {
        const dummyConfig = {
            PROJECT_NAME: 'test-project',
            REGION: 'us-east-1',
            PORT: '8000',
            CPU: '256',
            MEMORY: '512',
            COMPUTE_TIER: 'Micro',
            ESTIMATED_COST: '~$30',
            STATE_BUCKET: 'test-bucket-123',
            AWS_ACCOUNT_ID: '123456789012',
            HEALTH_CHECK_PATH: '/health',
            DESIRED_COUNT: '1',
            DEPLOY_BRANCH: 'main',
            BUILD_DIR: 'dist',
            finalFramework: 'django',
            NEEDS_DATABASE: true,
            DJANGO_WSGI: 'gunicorn config.wsgi',
            DISABLE_DEFAULT_CI: false,
            PROCFILE: null,
            VERCEL_RULES: null,
            DOCKER_COMPOSE: null,
            ENABLE_PR_PREVIEWS: false,
            TASK_COMMAND: '',
            WORKER_COMMAND: '',
            DB_ENV_VARS: '',
            COMPOSE_WEB_ENV_VARS: '',
            EXTRA_CONTAINERS: '',
            TASK_SECRETS: '',
            INITIAL_SECRET_MAP: '{\n  }',
            SAFE_ALB_NAME: 'test-project',
            VERCEL_EDGE_ROUTING: ''
        };

        await generateTemplates(testTargetDir, dummyConfig);

        const mainTfPath = path.join(testTargetDir, 'terraform', 'main.tf');
        const mainTfContent = await fs.readFile(mainTfPath, 'utf-8');

        // This will create a __snapshots__ folder on the first run.
        // Future runs will fail if the generator output changes without explicit approval.
        expect(mainTfContent).toMatchSnapshot();
    });
});