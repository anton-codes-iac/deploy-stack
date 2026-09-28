// Project capability scanner for dependency-aware `init`.
//
// Pure, read-only, and fault-tolerant: every file read is guarded so
// missing or malformed manifests never crash scaffolding. Matching is
// tokenized (exact dependency keys, exact module paths, exact gem names,
// exact env keys) so short tokens like `pg` or `cron` never fire on
// substrings. Environment files contribute KEY NAMES ONLY — values are
// never read, parsed, or logged.
import fsSync from 'fs';
import path from 'path';
import { readFileSafe } from './resolvers.js';
import { ADDON_REGISTRY } from './addons.js';
import { parseDockerCompose } from './dockerCompose.js';
import { detectMigrationCommand } from './detector.js';

// --- Manifest tokenizers ---

function readJsonSafe(cwd, relPath) {
    try {
        const raw = readFileSafe(path.join(cwd, relPath));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// Python ecosystem names compare lowercased with `_` normalized to `-`
// (`APScheduler` -> `apscheduler`, `psycopg2-binary` stays).
function normalizePyName(raw) {
    return String(raw || '').trim().toLowerCase().replace(/_/g, '-');
}

// One normalized package name per line (`name`, `name[extra]==1.0`,
// `name @ https://...`). Skips comments, includes, and flags.
function extractRequirementNames(text) {
    const names = new Set();
    for (const line of String(text || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        const match = /^[a-zA-Z0-9._-]+/.exec(trimmed);
        if (match) names.add(normalizePyName(match[0]));
    }
    return names;
}

function extractPyprojectNames(text) {
    const names = new Set();
    const lines = String(text || '').split('\n');
    let section = '';
    let inDepsArray = false;
    for (const line of lines) {
        const trimmed = line.trim();
        const sectionMatch = /^\[(.+)\]$/.exec(trimmed);
        if (sectionMatch) {
            section = sectionMatch[1].trim();
            inDepsArray = false;
            continue;
        }
        if (/^dependencies\s*=/.test(trimmed)) {
            inDepsArray = true;
            if (trimmed.includes(']')) inDepsArray = false;
        } else if (inDepsArray && trimmed.includes(']')) {
            inDepsArray = false;
        }
        if (inDepsArray || section === 'project') {
            const quoted = trimmed.match(/"([^"]+)"/) || trimmed.match(/'([^']+)'/);
            if (quoted && (inDepsArray || /^dependencies\s*=/.test(trimmed))) {
                const token = /^[a-zA-Z0-9._-]+/.exec(quoted[1].trim());
                if (token) names.add(normalizePyName(token[0]));
            }
        }
        if (section.startsWith('tool.poetry')) {
            const key = /^([a-zA-Z0-9._-]+)\s*=/.exec(trimmed);
            if (key && key[1].toLowerCase() !== 'python') names.add(normalizePyName(key[1]));
        }
    }
    return names;
}

function extractPipfileNames(text) {
    const names = new Set();
    let section = '';
    for (const line of String(text || '').split('\n')) {
        const trimmed = line.trim();
        const sectionMatch = /^\[(.+)\]$/.exec(trimmed);
        if (sectionMatch) {
            section = sectionMatch[1].trim().toLowerCase();
            continue;
        }
        if (section !== 'packages' && section !== 'dev-packages') continue;
        if (!trimmed || trimmed.startsWith('#')) continue;
        const key = /^([a-zA-Z0-9._-]+)\s*=/.exec(trimmed);
        if (key) names.add(normalizePyName(key[1]));
    }
    return names;
}

// Exact module paths: the first whitespace-separated token per line,
// keeping only module-path-shaped tokens (containing `.` or `/`).
function extractGoModules(text) {
    const modules = new Set();
    for (const line of String(text || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        const token = trimmed.split(/\s+/)[0];
        if (token && (token.includes('.') || token.includes('/'))) modules.add(token);
    }
    return modules;
}

function extractGemNames(text) {
    const names = new Set();
    const pattern = /^\s*gem\s+['"]([^'"]+)['"]/gm;
    let match = pattern.exec(String(text || ''));
    while (match) {
        names.add(match[1].trim());
        match = pattern.exec(String(text || ''));
    }
    return names;
}

// Variable key names only (`KEY`, `export KEY`, comments skipped). Values
// after `=` are never captured, so secrets cannot leak into evidence.
function extractEnvKeys(text) {
    const keys = new Set();
    for (const line of String(text || '').split('\n')) {
        let trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        trimmed = trimmed.replace(/^export\s+/, '');
        const match = /^([A-Za-z0-9_]+)\s*=/.exec(trimmed);
        if (match) keys.add(match[1].toUpperCase());
    }
    return keys;
}

function stripImageTag(image) {
    const ref = String(image || '').trim().toLowerCase();
    const lastSlash = ref.lastIndexOf('/');
    const lastColon = ref.lastIndexOf(':');
    if (lastColon > lastSlash) return ref.slice(0, lastColon);
    return ref;
}

function imageMatches(image, signal) {
    const repo = stripImageTag(image);
    return repo === signal || repo.endsWith(`/${signal}`);
}

// --- Signal matrix (canonical evidence tokens) ---

const NODE_SIGNALS = {
    relationalDb: ['pg', 'postgres', 'typeorm', 'sequelize', 'knex', 'mikro-orm', 'drizzle-orm', 'drizzle-kit', '@prisma/client', 'prisma'],
    'db:redis': ['ioredis', 'redis', '@upstash/redis', 'bull', 'bullmq'],
    'queue:sqs': ['@aws-sdk/client-sqs', 'sqs-consumer'],
    'storage:s3': ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', 'multer-s3'],
    'db:dynamodb': ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', 'dynamoose'],
    'ai:bedrock': ['@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-bedrock', '@ai-sdk/amazon-bedrock', '@langchain/aws'],
    'email:ses': ['@aws-sdk/client-ses', '@aws-sdk/client-sesv2'],
};
const NODE_MYSQL = ['mysql2', 'mysql'];
const NODE_CRON = ['node-cron', 'cron', 'agenda'];
const NODE_WORKER_DEPS = ['bullmq', 'bull', 'sqs-consumer'];

const PYTHON_SIGNALS = {
    relationalDb: ['psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'sqlalchemy', 'sqlmodel', 'alembic', 'django'],
    'db:redis': ['redis', 'aioredis', 'rq'],
    'storage:s3': ['django-storages', 's3fs'],
    'db:dynamodb': ['pynamodb', 'aioboto3'],
    'ai:bedrock': ['langchain-aws'],
    'email:ses': ['django-ses'],
};
const PYTHON_MYSQL = ['pymysql', 'mysqlclient', 'aiomysql'];
const PYTHON_CRON = ['apscheduler', 'celery-beat'];
const PYTHON_WORKER_DEPS = ['celery', 'rq', 'dramatiq'];

const GO_SIGNALS = {
    relationalDb: ['github.com/lib/pq', 'github.com/jackc/pgx', 'gorm.io/driver/postgres'],
    'db:redis': ['github.com/redis/go-redis', 'github.com/gomodule/redigo'],
    'queue:sqs': ['github.com/aws/aws-sdk-go-v2/service/sqs'],
    'storage:s3': ['github.com/aws/aws-sdk-go-v2/service/s3'],
    'db:dynamodb': ['github.com/aws/aws-sdk-go-v2/service/dynamodb'],
    'ai:bedrock': ['github.com/aws/aws-sdk-go-v2/service/bedrockruntime'],
    'email:ses': ['github.com/aws/aws-sdk-go-v2/service/ses', 'github.com/aws/aws-sdk-go-v2/service/sesv2'],
};
const GO_MYSQL = ['github.com/go-sql-driver/mysql', 'gorm.io/driver/mysql'];

const RUBY_SIGNALS = {
    relationalDb: ['pg', 'rails'],
    'db:redis': ['redis', 'sidekiq', 'connection_pool'],
    'queue:sqs': ['aws-sdk-sqs', 'shoryuken'],
    'storage:s3': ['aws-sdk-s3', 'shrine', 'carrierwave'],
    'db:dynamodb': ['aws-sdk-dynamodb'],
    'ai:bedrock': ['aws-sdk-bedrockruntime'],
    'email:ses': ['aws-sdk-ses', 'aws-sdk-sesv2'],
};
const RUBY_MYSQL = ['mysql2'];
const RUBY_CRON = ['whenever', 'sidekiq-cron', 'sidekiq-scheduler'];
const RUBY_WORKER_DEPS = ['sidekiq', 'shoryuken', 'good_job'];

const ENV_KEY_SIGNALS = {
    relationalDb: ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'PGHOST'],
    'db:redis': ['REDIS_URL', 'VALKEY_URL', 'REDIS_HOST', 'CELERY_BROKER_URL'],
    'queue:sqs': ['SQS_QUEUE_URL', 'SQS_DLQ_URL', 'AWS_SQS_QUEUE_URL'],
    'storage:s3': ['S3_BUCKET_NAME', 'S3_BUCKET', 'AWS_S3_BUCKET', 'S3_CDN_URL'],
    'db:dynamodb': ['DYNAMODB_TABLE_NAME', 'DYNAMODB_TABLE'],
    'ai:bedrock': ['BEDROCK_MODEL_ID', 'AWS_BEDROCK_MODEL_ID'],
    'email:ses': ['SES_FROM_EMAIL', 'SES_REGION', 'AWS_SES_REGION'],
};
const ENV_MYSQL_KEYS = ['MYSQL_URL', 'MYSQL_HOST'];

const COMPOSE_IMAGE_SIGNALS = {
    relationalDb: ['postgres', 'postgis/postgis'],
    'db:redis': ['redis', 'valkey/valkey', 'bitnami/redis', 'redis/redis-stack'],
    'storage:s3': ['minio/minio'],
    'db:dynamodb': ['amazon/dynamodb-local'],
};
const COMPOSE_MYSQL_IMAGES = ['mysql', 'mariadb'];
const COMPOSE_VECTOR_IMAGES = ['ankane/pgvector', 'pgvector/pgvector'];
const COMPOSE_SQS_IMAGE = 'roribio16/alpine-sqs';
const COMPOSE_LOCALSTACK_IMAGE = 'localstack/localstack';

const DRIZZLE_CONFIG_FILES = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs'];
const ENV_TEMPLATE_FILES = ['.env.example', '.env.sample', '.env.template', '.env'];
const NON_PG_PRISMA_PROVIDERS = ['mysql', 'sqlite', 'mongodb'];
const PG_PRISMA_PROVIDERS = ['postgresql', 'postgres', 'cockroachdb'];

function pushUnique(list, item) {
    if (!list.includes(item)) list.push(item);
}

function collectSetSignals(names, signals, buckets) {
    for (const [bucket, tokens] of Object.entries(signals)) {
        for (const token of tokens) {
            if (names.has(token)) pushUnique(buckets[bucket], token);
        }
    }
}

function collectGoSignals(modules, signals, buckets) {
    for (const [bucket, tokens] of Object.entries(signals)) {
        for (const token of tokens) {
            for (const module of modules) {
                // Exact module path, or a suffix match so vendored paths
                // like `github.com/robfig/cron` still resolve.
                if (module === token || module.endsWith(`/${token}`)) {
                    pushUnique(buckets[bucket], token);
                    break;
                }
            }
        }
    }
}

function fileExists(cwd, relPath) {
    try {
        return fsSync.existsSync(path.join(cwd, relPath));
    } catch {
        return false;
    }
}

function detectNpmScriptWorker(pkg) {
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {};
    const entries = Object.entries(scripts);
    const tokenPattern = /worker|queue:work|bull/i;
    for (const [name] of entries) {
        if (tokenPattern.test(String(name))) return `npm run ${name}`;
    }
    for (const [name, body] of entries) {
        if (tokenPattern.test(String(body))) return `npm run ${name}`;
    }
    return null;
}

// Scans manifests, configs, and env templates under `cwd` and returns
// `{ relationalDb, worker, migration, addons, upcomingHints }` (see the
// dependency-aware-init spec for the full shape). Never throws on
// malformed input and never captures secret values.
export function detectProjectCapabilities(cwd = process.cwd()) {
    const dir = cwd || process.cwd();
    const relationalEvidence = [];
    const mysqlEvidence = [];
    const workerEvidence = [];
    const addonEvidence = {};
    for (const cap of Object.keys(ADDON_REGISTRY)) addonEvidence[cap] = [];
    let cronHint = false;
    let vectorHint = false;

    const recordAddon = (cap, item) => {
        if (addonEvidence[cap]) pushUnique(addonEvidence[cap], item);
    };
    const recordRelational = (item) => pushUnique(relationalEvidence, item);
    const recordMysql = (item) => pushUnique(mysqlEvidence, item);
    const recordWorker = (item) => pushUnique(workerEvidence, item);

    // --- package.json (exact dependency keys) ---
    const pkg = readJsonSafe(dir, 'package.json');
    const nodeDeps = new Set();
    if (pkg && typeof pkg === 'object') {
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
            const block = pkg[field];
            if (block && typeof block === 'object') {
                for (const name of Object.keys(block)) nodeDeps.add(name);
            }
        }
    }

    // Prisma provider can disqualify the Prisma relational signals.
    const prismaSchema = readFileSafe(path.join(dir, 'prisma', 'schema.prisma'));
    let prismaProvider = null;
    if (prismaSchema) {
        const providerMatch = /provider\s*=\s*"([^"]+)"/.exec(prismaSchema);
        if (providerMatch) prismaProvider = providerMatch[1].trim().toLowerCase();
        if (/vector/i.test(prismaSchema)) vectorHint = true;
    }
    const prismaCountsAsRelational = !prismaProvider || !NON_PG_PRISMA_PROVIDERS.includes(prismaProvider);
    if (prismaSchema && prismaProvider && PG_PRISMA_PROVIDERS.includes(prismaProvider)) {
        recordRelational('prisma/schema.prisma');
    }
    if (prismaSchema && prismaProvider === 'mysql') recordMysql('prisma/schema.prisma');

    const buckets = { relationalDb: relationalEvidence, ...addonEvidence };
    collectSetSignals(nodeDeps, NODE_SIGNALS, buckets);
    if (!prismaCountsAsRelational) {
        for (const prismaDep of ['@prisma/client', 'prisma']) {
            const at = relationalEvidence.indexOf(prismaDep);
            if (at !== -1) relationalEvidence.splice(at, 1);
        }
    }
    for (const token of NODE_MYSQL) {
        if (nodeDeps.has(token)) recordMysql(token);
    }
    for (const token of NODE_CRON) {
        if (nodeDeps.has(token)) cronHint = true;
    }
    for (const token of NODE_WORKER_DEPS) {
        if (nodeDeps.has(token)) recordWorker(token);
    }
    if (nodeDeps.has('pgvector')) vectorHint = true;

    // --- Python manifests (normalized names) ---
    const pyNames = new Set();
    for (const name of extractRequirementNames(readFileSafe(path.join(dir, 'requirements.txt')))) pyNames.add(name);
    for (const name of extractPyprojectNames(readFileSafe(path.join(dir, 'pyproject.toml')))) pyNames.add(name);
    for (const name of extractPipfileNames(readFileSafe(path.join(dir, 'Pipfile')))) pyNames.add(name);
    collectSetSignals(pyNames, PYTHON_SIGNALS, buckets);
    for (const token of PYTHON_MYSQL) {
        if (pyNames.has(token)) recordMysql(token);
    }
    for (const token of PYTHON_CRON) {
        if (pyNames.has(token)) cronHint = true;
    }
    for (const token of PYTHON_WORKER_DEPS) {
        if (pyNames.has(token)) recordWorker(token);
    }
    if (pyNames.has('celery') && pyNames.has('redis')) recordAddon('db:redis', 'celery');
    if (pyNames.has('pgvector')) vectorHint = true;

    // --- go.mod (exact module paths) ---
    const goModules = extractGoModules(readFileSafe(path.join(dir, 'go.mod')));
    collectGoSignals(goModules, GO_SIGNALS, buckets);
    for (const token of GO_MYSQL) {
        for (const module of goModules) {
            if (module === token || module.endsWith(`/${token}`)) {
                recordMysql(token);
                break;
            }
        }
    }
    for (const module of goModules) {
        if (module === 'robfig/cron' || module.endsWith('/robfig/cron')) cronHint = true;
        if (module.includes('pgvector')) vectorHint = true;
    }

    // --- Gemfile (exact gem names) ---
    const gemNames = extractGemNames(readFileSafe(path.join(dir, 'Gemfile')));
    collectSetSignals(gemNames, RUBY_SIGNALS, buckets);
    for (const token of RUBY_MYSQL) {
        if (gemNames.has(token)) recordMysql(token);
    }
    for (const token of RUBY_CRON) {
        if (gemNames.has(token)) cronHint = true;
    }
    for (const token of RUBY_WORKER_DEPS) {
        if (gemNames.has(token)) recordWorker(token);
    }
    if (gemNames.has('pgvector')) vectorHint = true;

    // --- Framework marker files ---
    for (const file of DRIZZLE_CONFIG_FILES) {
        if (fileExists(dir, file)) recordRelational(file);
    }
    if (fileExists(dir, 'alembic.ini')) recordRelational('alembic.ini');
    if (fileExists(dir, 'manage.py')) recordRelational('manage.py');
    if (fileExists(dir, path.join('bin', 'rails'))) recordRelational('bin/rails');

    // --- Docker Compose (images, worker-ish services, localstack) ---
    let composeServices = null;
    try {
        composeServices = parseDockerCompose(dir);
    } catch {
        composeServices = null;
    }
    if (Array.isArray(composeServices)) {
        for (const service of composeServices) {
            if (!service || typeof service !== 'object') continue;
            const image = typeof service.image === 'string' ? service.image : '';
            for (const [bucket, signals] of Object.entries(COMPOSE_IMAGE_SIGNALS)) {
                for (const signal of signals) {
                    if (image && imageMatches(image, signal)) {
                        const item = `docker-compose ${signal}`;
                        if (bucket === 'relationalDb') recordRelational(item);
                        else recordAddon(bucket, item);
                    }
                }
            }
            for (const signal of COMPOSE_MYSQL_IMAGES) {
                if (image && imageMatches(image, signal)) recordMysql(`docker-compose ${signal}`);
            }
            for (const signal of COMPOSE_VECTOR_IMAGES) {
                if (image && imageMatches(image, signal)) vectorHint = true;
            }
            if (image && imageMatches(image, COMPOSE_SQS_IMAGE)) {
                recordAddon('queue:sqs', `docker-compose ${COMPOSE_SQS_IMAGE}`);
            }
            if (image && imageMatches(image, COMPOSE_LOCALSTACK_IMAGE)) {
                const env = service.environment && typeof service.environment === 'object' ? service.environment : {};
                const servicesValue = env.SERVICES;
                if (servicesValue === undefined || servicesValue === null) {
                    recordAddon('queue:sqs', 'docker-compose localstack');
                } else {
                    const tokens = String(servicesValue).toLowerCase().split(/[,\s:;]+/).filter(Boolean);
                    if (tokens.includes('sqs')) recordAddon('queue:sqs', 'docker-compose localstack');
                }
            }
            const serviceName = typeof service.name === 'string' ? service.name : '';
            if (serviceName.toLowerCase().includes('worker')) recordWorker('docker-compose worker');
        }
    }

    // --- Procfile worker processes ---
    const procfileContent = readFileSafe(path.join(dir, 'Procfile'));
    if (procfileContent) {
        for (const line of procfileContent.split('\n')) {
            const match = /^\s*([A-Za-z0-9_-]+)\s*:/.exec(line);
            if (match && match[1].toLowerCase() !== 'web' && match[1].toLowerCase().includes('worker')) {
                recordWorker('Procfile');
                break;
            }
        }
    }

    // --- npm script worker suggestion ---
    const suggestedCommand = detectNpmScriptWorker(pkg);
    if (suggestedCommand) recordWorker(suggestedCommand);

    // --- Env template keys (names only, values never touched) ---
    const envKeys = new Set();
    for (const file of ENV_TEMPLATE_FILES) {
        for (const key of extractEnvKeys(readFileSafe(path.join(dir, file)))) envKeys.add(key);
    }
    collectSetSignals(envKeys, ENV_KEY_SIGNALS, buckets);
    for (const key of ENV_MYSQL_KEYS) {
        if (envKeys.has(key)) recordMysql(key);
    }

    // --- vercel.json crons (independent read: the edge-rule parser skips cron-only files) ---
    const vercelJson = readJsonSafe(dir, 'vercel.json');
    if (vercelJson && Array.isArray(vercelJson.crons) && vercelJson.crons.length > 0) cronHint = true;

    // --- Migration command (shared detector) ---
    let migrationCommand = null;
    try {
        migrationCommand = detectMigrationCommand(dir);
    } catch {
        migrationCommand = null;
    }

    const addons = {};
    for (const cap of Object.keys(ADDON_REGISTRY)) {
        addons[cap] = { detected: addonEvidence[cap].length > 0, evidence: [...addonEvidence[cap]] };
    }

    return {
        relationalDb: { detected: relationalEvidence.length > 0, evidence: [...relationalEvidence] },
        worker: {
            detected: workerEvidence.length > 0,
            suggestedCommand,
            evidence: [...workerEvidence],
        },
        migration: { detected: migrationCommand !== null, command: migrationCommand },
        addons,
        upcomingHints: {
            vector: vectorHint,
            cron: cronHint,
            mysql: mysqlEvidence.length > 0,
        },
    };
}
