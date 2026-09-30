import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectProjectCapabilities } from '../src/utils/capabilities.js';

let tmpDirs = [];

function makeTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capabilities-test-'));
    tmpDirs.push(dir);
    return dir;
}

function writeFile(dir, relPath, content) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
}

function writeJson(dir, relPath, value) {
    return writeFile(dir, relPath, JSON.stringify(value, null, 2));
}

beforeEach(() => {
    tmpDirs = [];
});

afterEach(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('detectProjectCapabilities: empty and malformed projects', () => {
    it('returns a blank shape for an empty directory', () => {
        const result = detectProjectCapabilities(makeTmp());
        expect(result.relationalDb).toEqual({ detected: false, evidence: [] });
        expect(result.worker).toEqual({ detected: false, suggestedCommand: null, evidence: [] });
        expect(result.migration).toEqual({ detected: false, command: null });
        expect(result.upcomingHints).toEqual({ vector: false, cron: false, mysql: false });
        expect(Object.keys(result.addons)).toEqual([
            'storage:s3', 'db:dynamodb', 'db:redis', 'queue:sqs', 'ai:bedrock', 'email:ses', 'cron',
        ]);
        for (const addon of Object.values(result.addons)) {
            expect(addon).toEqual({ detected: false, evidence: [] });
        }
    });

    it('never throws on malformed manifests', () => {
        const dir = makeTmp();
        writeFile(dir, 'package.json', '{not json');
        writeFile(dir, 'requirements.txt', '\x00\x01binary');
        writeFile(dir, 'go.mod', '((((');
        writeFile(dir, 'vercel.json', '[unclosed');
        writeFile(dir, 'docker-compose.yml', ':\t: bad: [yaml');
        expect(() => detectProjectCapabilities(dir)).not.toThrow();
        const result = detectProjectCapabilities(dir);
        expect(result.relationalDb.detected).toBe(false);
        expect(result.migration.detected).toBe(false);
    });
});

describe('detectProjectCapabilities: relational database signals', () => {
    it('detects Node postgres drivers by exact key', () => {
        const dir = makeTmp();
        writeJson(dir, 'package.json', { dependencies: { pg: '^8.0.0' }, devDependencies: { 'drizzle-kit': '^1.0.0' } });
        const result = detectProjectCapabilities(dir);
        expect(result.relationalDb.detected).toBe(true);
        expect(result.relationalDb.evidence).toContain('pg');
        expect(result.relationalDb.evidence).toContain('drizzle-kit');
    });

    it('detects Python, Go, and Ruby postgres signals with normalization', () => {
        const dir = makeTmp();
        writeFile(dir, 'requirements.txt', 'psycopg2-binary==2.9.9\nDjango>=4.0\n');
        writeFile(dir, 'go.mod', 'module example.com/app\n\ngo 1.21\n\nrequire github.com/jackc/pgx/v5 v5.0.0\n');
        writeFile(dir, 'Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\n");
        const result = detectProjectCapabilities(dir);
        expect(result.relationalDb.detected).toBe(true);
        expect(result.relationalDb.evidence).toContain('psycopg2-binary');
        expect(result.relationalDb.evidence).toContain('django');
        expect(result.relationalDb.evidence).not.toContain('github.com/jackc/pgx/v5');
        // pgx v5 module path is distinct from the listed v4 signal
        expect(result.relationalDb.evidence).toContain('rails');
    });

    it('detects pyproject.toml and Pipfile dependencies', () => {
        const dir = makeTmp();
        writeFile(dir, 'pyproject.toml', '[project]\ndependencies = [\n  "sqlalchemy>=2.0",\n  "alembic",\n]\n');
        const fromPyproject = detectProjectCapabilities(dir);
        expect(fromPyproject.relationalDb.evidence).toContain('sqlalchemy');
        expect(fromPyproject.relationalDb.evidence).toContain('alembic');

        const dir2 = makeTmp();
        writeFile(dir2, 'Pipfile', '[packages]\nasyncpg = "*"\n');
        expect(detectProjectCapabilities(dir2).relationalDb.evidence).toContain('asyncpg');
    });

    it('triggers on Drizzle, Alembic, Django, and Rails markers', () => {
        for (const marker of ['drizzle.config.ts', 'alembic.ini', 'manage.py', 'bin/rails']) {
            const dir = makeTmp();
            writeFile(dir, marker, '# marker');
            const result = detectProjectCapabilities(dir);
            expect(result.relationalDb.detected).toBe(true);
            expect(result.relationalDb.evidence).toContain(marker);
        }
    });

    it('honors the prisma provider: postgres yes, mysql/sqlite/mongodb no', () => {
        const withProvider = (provider) => {
            const dir = makeTmp();
            writeJson(dir, 'package.json', { dependencies: { '@prisma/client': '^5.0.0' } });
            writeFile(dir, 'prisma/schema.prisma', `datasource db {\n  provider = "${provider}"\n}\n`);
            return detectProjectCapabilities(dir);
        };
        expect(withProvider('postgresql').relationalDb.detected).toBe(true);
        expect(withProvider('postgresql').relationalDb.evidence).toContain('prisma/schema.prisma');
        expect(withProvider('mysql').relationalDb.detected).toBe(false);
        expect(withProvider('mysql').upcomingHints.mysql).toBe(true);
        expect(withProvider('sqlite').relationalDb.detected).toBe(false);
        expect(withProvider('mongodb').relationalDb.detected).toBe(false);

        // Bare client without a schema still counts as relational.
        const bare = makeTmp();
        writeJson(bare, 'package.json', { dependencies: { prisma: '^5.0.0' } });
        expect(detectProjectCapabilities(bare).relationalDb.detected).toBe(true);
    });

    it('detects compose postgres images and env keys', () => {
        const dir = makeTmp();
        writeFile(dir, 'docker-compose.yml', 'services:\n  db:\n    image: postgis/postgis:16-3.4\n');
        writeFile(dir, '.env.example', 'DATABASE_URL=postgresql://user:pass@localhost/db\n');
        const result = detectProjectCapabilities(dir);
        expect(result.relationalDb.evidence).toContain('docker-compose postgis/postgis');
        expect(result.relationalDb.evidence).toContain('DATABASE_URL');
    });

    it('keeps MySQL-only projects out of relationalDb with a mysql hint', () => {
        const dir = makeTmp();
        writeJson(dir, 'package.json', { dependencies: { mysql2: '^3.0.0' } });
        writeFile(dir, '.env.example', 'MYSQL_URL=mysql://user:pass@localhost/db\n');
        const result = detectProjectCapabilities(dir);
        expect(result.relationalDb.detected).toBe(false);
        expect(result.upcomingHints.mysql).toBe(true);

        const both = makeTmp();
        writeJson(both, 'package.json', { dependencies: { pg: '^8.0.0', mysql2: '^3.0.0' } });
        const mixed = detectProjectCapabilities(both);
        expect(mixed.relationalDb.detected).toBe(true);
        expect(mixed.upcomingHints.mysql).toBe(true);
    });
});

describe('detectProjectCapabilities: addon signals', () => {
    it('detects redis across ecosystems, compose, and env keys', () => {
        const dir = makeTmp();
        writeJson(dir, 'package.json', { dependencies: { ioredis: '^5.0.0', bullmq: '^5.0.0' } });
        writeFile(dir, 'requirements.txt', 'celery\nredis\n');
        writeFile(dir, 'compose.yaml', 'services:\n  cache:\n    image: valkey/valkey:8\n');
        const result = detectProjectCapabilities(dir);
        expect(result.addons['db:redis'].detected).toBe(true);
        expect(result.addons['db:redis'].evidence).toEqual(
            expect.arrayContaining(['ioredis', 'bullmq', 'redis', 'celery', 'docker-compose valkey/valkey'])
        );
    });

    it('requires celery+redis co-presence for the celery redis signal', () => {
        const alone = makeTmp();
        writeFile(alone, 'requirements.txt', 'celery\n');
        expect(detectProjectCapabilities(alone).addons['db:redis'].detected).toBe(false);
    });

    it('detects sqs, s3, dynamodb, bedrock, and ses signals', () => {
        const dir = makeTmp();
        writeJson(dir, 'package.json', {
            dependencies: {
                '@aws-sdk/client-sqs': '^3.0.0',
                '@aws-sdk/client-s3': '^3.0.0',
                '@aws-sdk/client-dynamodb': '^3.0.0',
                '@aws-sdk/client-bedrock-runtime': '^3.0.0',
                '@aws-sdk/client-sesv2': '^3.0.0',
            },
        });
        writeFile(dir, 'Gemfile', "gem 'shoryuken'\ngem 'aws-sdk-ses'\ngem 'aws-sdk-bedrockruntime'\ngem 'aws-sdk-dynamodb'\n");
        const result = detectProjectCapabilities(dir);
        expect(result.addons['queue:sqs'].evidence).toEqual(expect.arrayContaining(['@aws-sdk/client-sqs', 'shoryuken']));
        expect(result.addons['storage:s3'].evidence).toContain('@aws-sdk/client-s3');
        expect(result.addons['db:dynamodb'].evidence).toEqual(
            expect.arrayContaining(['@aws-sdk/client-dynamodb', 'aws-sdk-dynamodb'])
        );
        expect(result.addons['ai:bedrock'].evidence).toEqual(
            expect.arrayContaining(['@aws-sdk/client-bedrock-runtime', 'aws-sdk-bedrockruntime'])
        );
        expect(result.addons['email:ses'].evidence).toEqual(
            expect.arrayContaining(['@aws-sdk/client-sesv2', 'aws-sdk-ses'])
        );
    });

    it('detects localstack only when SERVICES includes sqs', () => {
        const withSqs = makeTmp();
        writeFile(withSqs, 'docker-compose.yml', 'services:\n  aws:\n    image: localstack/localstack:3\n    environment:\n      SERVICES: s3,sqs\n');
        expect(detectProjectCapabilities(withSqs).addons['queue:sqs'].evidence)
            .toContain('docker-compose localstack');

        const withoutSqs = makeTmp();
        writeFile(withoutSqs, 'docker-compose.yml', 'services:\n  aws:\n    image: localstack/localstack:3\n    environment:\n      SERVICES: s3\n');
        expect(detectProjectCapabilities(withoutSqs).addons['queue:sqs'].detected).toBe(false);

        const bare = makeTmp();
        writeFile(bare, 'docker-compose.yml', 'services:\n  aws:\n    image: localstack/localstack:3\n');
        expect(detectProjectCapabilities(bare).addons['queue:sqs'].evidence)
            .toContain('docker-compose localstack');
    });

    it('detects minio, dynamodb-local, and ses env keys', () => {
        const dir = makeTmp();
        writeFile(dir, 'docker-compose.yml', 'services:\n  s3:\n    image: minio/minio:latest\n  ddb:\n    image: amazon/dynamodb-local:latest\n');
        writeFile(dir, '.env.sample', 'export SES_FROM_EMAIL=noreply@example.com\nSES_REGION=us-east-2\n');
        const result = detectProjectCapabilities(dir);
        expect(result.addons['storage:s3'].evidence).toContain('docker-compose minio/minio');
        expect(result.addons['db:dynamodb'].evidence).toContain('docker-compose amazon/dynamodb-local');
        expect(result.addons['email:ses'].evidence).toEqual(expect.arrayContaining(['SES_FROM_EMAIL', 'SES_REGION']));
    });
});

describe('detectProjectCapabilities: tokenization and privacy', () => {
    it('never fires on substring false-positives', () => {
        const dir = makeTmp();
        writeJson(dir, 'package.json', { dependencies: { 'node-cron-parser': '1.0.0', pgvector: '1.0.0' } });
        writeFile(dir, 'requirements.txt', 'my-pg-helper\nnot-cron-at-all\n');
        writeFile(dir, 'Gemfile', "gem 'pg_search'\n");
        writeFile(dir, 'go.mod', 'module example.com/app\n\nrequire github.com/foo/pgbar v1.0.0\n');
        const result = detectProjectCapabilities(dir);
        expect(result.relationalDb.detected).toBe(false);
        expect(result.upcomingHints.cron).toBe(false);
        // pgvector is an exact package: vector hint yes, relational pg no.
        expect(result.upcomingHints.vector).toBe(true);
        expect(result.relationalDb.evidence).not.toContain('pg');
    });

    it('treats sidekiq-cron as cron only, not as sidekiq redis', () => {
        const dir = makeTmp();
        writeFile(dir, 'Gemfile', "gem 'sidekiq-cron'\n");
        const result = detectProjectCapabilities(dir);
        expect(result.upcomingHints.cron).toBe(true);
        expect(result.addons['db:redis'].detected).toBe(false);
    });

    it('reads env key names but never values', () => {
        const dir = makeTmp();
        writeFile(dir, '.env', 'REDIS_URL=redis://:s3cret-pw@db.internal:6379/0\n');
        writeFile(dir, '.env.example', 'FOO=SQS_QUEUE_URL\n# SQS_DLQ_URL=commented-out\n');
        const result = detectProjectCapabilities(dir);
        expect(result.addons['db:redis'].evidence).toContain('REDIS_URL');
        // A signal appearing as a VALUE (or in a comment) must not fire.
        expect(result.addons['queue:sqs'].detected).toBe(false);
        expect(JSON.stringify(result)).not.toContain('s3cret-pw');
        expect(JSON.stringify(result)).not.toContain('db.internal');
    });
});

describe('detectProjectCapabilities: worker, migration, and hints', () => {
    it('suggests npm run commands from worker-ish script names and bodies', () => {
        const byName = makeTmp();
        writeJson(byName, 'package.json', { scripts: { start: 'node index.js', 'queue:work': 'node queue.js' } });
        const named = detectProjectCapabilities(byName);
        expect(named.worker.detected).toBe(true);
        expect(named.worker.suggestedCommand).toBe('npm run queue:work');

        const byBody = makeTmp();
        writeJson(byBody, 'package.json', { scripts: { jobs: 'node bull-board.js' } });
        expect(detectProjectCapabilities(byBody).worker.suggestedCommand).toBe('npm run jobs');
    });

    it('detects worker deps, Procfile workers, and compose worker services', () => {
        const dir = makeTmp();
        writeFile(dir, 'requirements.txt', 'dramatiq\n');
        writeFile(dir, 'Procfile', 'web: gunicorn app.wsgi\nworker: celery -A app worker\n');
        writeFile(dir, 'docker-compose.yml', 'services:\n  web:\n    image: app:latest\n    ports: ["3000:3000"]\n  mail-worker:\n    image: app:latest\n');
        const result = detectProjectCapabilities(dir);
        expect(result.worker.detected).toBe(true);
        expect(result.worker.evidence).toEqual(expect.arrayContaining(['dramatiq', 'Procfile', 'docker-compose worker']));
    });

    it('delegates migration detection to detectMigrationCommand', () => {
        const dir = makeTmp();
        writeJson(dir, 'package.json', { scripts: { 'db:migrate': 'prisma migrate deploy' } });
        const result = detectProjectCapabilities(dir);
        expect(result.migration.detected).toBe(true);
        expect(result.migration.command).toContain('db:migrate');
    });

    it('detects vector and cron hints across ecosystems', () => {
        const dir = makeTmp();
        writeFile(dir, 'requirements.txt', 'pgvector\napscheduler\n');
        writeFile(dir, 'docker-compose.yml', 'services:\n  db:\n    image: pgvector/pgvector:pg16\n');
        writeFile(dir, 'vercel.json', JSON.stringify({ crons: [{ path: '/api/cron', schedule: '0 5 * * *' }] }));
        const result = detectProjectCapabilities(dir);
        expect(result.upcomingHints).toEqual({ vector: true, cron: true, mysql: false });

        const emptyCrons = makeTmp();
        writeFile(emptyCrons, 'vercel.json', JSON.stringify({ crons: [] }));
        expect(detectProjectCapabilities(emptyCrons).upcomingHints.cron).toBe(false);
    });
});
