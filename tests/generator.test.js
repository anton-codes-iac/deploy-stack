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

    const matrix = [
        // 1. Backend APIs & Monoliths
        { name: 'Django_Postgres', framework: 'django', needsDb: true, buildDir: '' },
        { name: 'Rails_Postgres', framework: 'rails', needsDb: true, buildDir: '' },
        { name: 'Go_Distroless', framework: 'go', needsDb: false, buildDir: '' },
        { name: 'FastAPI_Python', framework: 'python', needsDb: false, buildDir: '' },

        // 2. Frontend & Meta-Frameworks
        { name: 'NextJS_Standalone', framework: 'nextjs', needsDb: false, buildDir: '.next/standalone' },
        { name: 'Nuxt_SSR', framework: 'nuxt', needsDb: false, buildDir: '.output/server' },
        { name: 'Vite_Static_SPA', framework: 'static', needsDb: false, buildDir: 'dist' },
        { name: 'SvelteKit_Node', framework: 'svelte', needsDb: false, buildDir: 'build' },

        // 3. Migration Engines
        {
            name: 'Heroku_Procfile_Migration',
            framework: 'django',
            needsDb: true,
            buildDir: '',
            procfile: { web: ['gunicorn config.wsgi'], worker: ['celery -A config worker'] }
        },
        {
            name: 'Vercel_Edge_Migration',
            framework: 'nextjs',
            needsDb: false,
            buildDir: '.next/standalone',
            vercelRouting: '{"routes": [{"src": "/api/(.*)", "dest": "https://api.example.com/$1"}]}'
        },
        {
            name: 'Docker_Compose_Sidecars',
            framework: 'node',
            needsDb: false,
            buildDir: '',
            dockerCompose: [{ name: 'web', port: 3000 }, { name: 'redis', image: 'redis:alpine' }]
        }
    ];

    for (const tc of matrix) {
        it(`generates correct infrastructure, CI/CD, and Dockerfile for ${tc.name}`, async () => {
            await fs.rm(testTargetDir, { recursive: true, force: true }).catch(() => { });
            await fs.mkdir(path.join(testTargetDir, '.github', 'workflows'), { recursive: true });

            const dummyConfig = {
                PROJECT_NAME: `test-${tc.name.toLowerCase()}`,
                REGION: 'us-east-2',
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
                BUILD_DIR: tc.buildDir,
                finalFramework: tc.framework,
                NEEDS_DATABASE: tc.needsDb,
                DJANGO_WSGI: tc.framework === 'django' ? 'gunicorn config.wsgi' : '',
                DISABLE_DEFAULT_CI: false,
                PROCFILE: tc.procfile || null,
                VERCEL_RULES: tc.vercelRouting ? { routes: [] } : null,
                VERCEL_EDGE_ROUTING: tc.vercelRouting || '',
                DOCKER_COMPOSE: tc.dockerCompose || null,
                ENABLE_PR_PREVIEWS: true,
                TASK_COMMAND: '',
                WORKER_COMMAND: '',
                DB_ENV_VARS: '',
                COMPOSE_WEB_ENV_VARS: '',
                EXTRA_CONTAINERS: '',
                TASK_SECRETS: '',
                INITIAL_SECRET_MAP: '{\n  }',
                SAFE_ALB_NAME: `test-alb`,
            };

            await generateTemplates(testTargetDir, dummyConfig);

            const mainTfPath = path.join(testTargetDir, 'terraform', 'main.tf');
            const networkTfPath = path.join(testTargetDir, 'terraform', 'network.tf');
            const databaseTfPath = path.join(testTargetDir, 'terraform', 'database.tf');
            const workerTfPath = path.join(testTargetDir, 'terraform', 'worker.tf');

            const deployYmlPath = path.join(testTargetDir, '.github', 'workflows', 'deploy.yml');
            const previewYmlPath = path.join(testTargetDir, '.github', 'workflows', 'preview.yml');
            const teardownYmlPath = path.join(testTargetDir, '.github', 'workflows', 'teardown.yml');

            const dockerfilePath = path.join(testTargetDir, 'Dockerfile');

            // Read contents (falling back to a string if they correctly don't exist)
            const mainTfContent = await fs.readFile(mainTfPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const networkTfContent = await fs.readFile(networkTfPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const databaseTfContent = await fs.readFile(databaseTfPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const workerTfContent = await fs.readFile(workerTfPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');

            const deployYmlContent = await fs.readFile(deployYmlPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const previewYmlContent = await fs.readFile(previewYmlPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');
            const teardownYmlContent = await fs.readFile(teardownYmlPath, 'utf-8').catch(() => 'FILE_NOT_FOUND');

            const dockerfileContent = await fs.readFile(dockerfilePath, 'utf-8').catch(() => 'FILE_NOT_FOUND');

            // Snapshot everything
            expect(mainTfContent).toMatchSnapshot(`${tc.name} - main.tf`);
            expect(networkTfContent).toMatchSnapshot(`${tc.name} - network.tf`);
            expect(databaseTfContent).toMatchSnapshot(`${tc.name} - database.tf`);
            expect(workerTfContent).toMatchSnapshot(`${tc.name} - worker.tf`);

            expect(deployYmlContent).toMatchSnapshot(`${tc.name} - deploy.yml`);
            expect(previewYmlContent).toMatchSnapshot(`${tc.name} - preview.yml`);
            expect(teardownYmlContent).toMatchSnapshot(`${tc.name} - teardown.yml`);

            expect(dockerfileContent).toMatchSnapshot(`${tc.name} - Dockerfile`);
        });
    }
});