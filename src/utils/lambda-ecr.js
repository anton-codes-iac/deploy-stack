import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// Day-0 ECR seeding for `--target lambda` projects. Lambda's CreateFunction
// API rejects images outside a private same-account ECR repository, so a
// fresh `terraform apply` would fail before the first CI push. `apply.js`
// seeds a minimal valid Docker schema-2 image under `:latest` instead —
// built entirely in memory (no Docker daemon) and pushed with the AWS CLI,
// which `doctor` already requires. All helpers shell out through an
// injectable spawnSync-shaped `run` (mirroring sleep-targets.js) and never
// throw for AWS-side failures: they return `{ ok, reason, detail }`.

export const PLACEHOLDER_TAG = 'latest';

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tailLines(output, count = 5) {
    return String(output ?? '').split('\n').slice(-count).join('\n').trim();
}

function cliResult(res, operation) {
    if (res?.error?.code === 'ENOENT') return { ok: false, reason: 'cli-missing', operation };
    if (res?.status !== 0) {
        const tail = tailLines(res?.stderr || res?.stdout);
        return { ok: false, reason: 'aws-failed', operation, detail: tail ? `${operation}: ${tail}` : operation };
    }
    return { ok: true, stdout: res?.stdout ?? '' };
}

// Builds a minimal Docker schema-2 image (empty gzipped tar layer plus an
// amd64/linux config) with runtime-computed digests, so the manifest ECR
// receives is always self-consistent. Lambda only checks image existence
// and architecture at CreateFunction time; CI replaces this placeholder
// with the real application image on the first push.
export function buildPlaceholderImage() {
    const emptyTar = Buffer.alloc(1024);
    const layerBlob = zlib.gzipSync(emptyTar);
    const layerDigest = `sha256:${sha256Hex(layerBlob)}`;
    const config = {
        architecture: 'amd64',
        os: 'linux',
        config: { Entrypoint: ['/bootstrap'] },
        rootfs: { type: 'layers', diff_ids: [`sha256:${sha256Hex(emptyTar)}`] },
        history: [{ created: '1970-01-01T00:00:00Z', comment: 'grada lambda placeholder' }],
    };
    const configBlob = Buffer.from(JSON.stringify(config));
    const configDigest = `sha256:${sha256Hex(configBlob)}`;
    const manifest = {
        schemaVersion: 2,
        mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        config: {
            mediaType: 'application/vnd.docker.container.image.v1+json',
            size: configBlob.length,
            digest: configDigest,
        },
        layers: [
            {
                mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
                size: layerBlob.length,
                digest: layerDigest,
            },
        ],
    };
    return {
        manifest,
        manifestJson: JSON.stringify(manifest),
        configBlob,
        configDigest,
        layerBlob,
        layerDigest,
    };
}

// True when `repository:tag` already exists. A missing image resolves to
// `{ ok: true, exists: false }`; every other failure (missing CLI, missing
// repository, auth errors) resolves to `{ ok: false, reason }`.
export function ecrImageExists({ run, repository, tag = PLACEHOLDER_TAG, region }) {
    const res = run('aws', [
        'ecr', 'describe-images',
        '--repository-name', repository,
        '--image-ids', `imageTag=${tag}`,
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' });
    if (res?.error?.code === 'ENOENT') return { ok: false, reason: 'cli-missing' };
    if (res?.status !== 0) {
        const detail = tailLines(res?.stderr || res?.stdout);
        if (/ImageNotFound/i.test(detail)) return { ok: true, exists: false };
        return { ok: false, reason: 'describe-failed', detail };
    }
    try {
        const details = JSON.parse(res.stdout || '{}').imageDetails || [];
        return { ok: true, exists: details.length > 0 };
    } catch {
        return { ok: false, reason: 'bad-response' };
    }
}

function uploadBlob({ run, repository, region, blob, digest, tmpDir, label }) {
    const blobPath = path.join(tmpDir, `${label}.blob`);
    fs.writeFileSync(blobPath, blob);

    const initiated = cliResult(run('aws', [
        'ecr', 'initiate-layer-upload',
        '--repository-name', repository,
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' }), 'initiate-layer-upload');
    if (!initiated.ok) return initiated;
    let uploadId;
    try {
        uploadId = JSON.parse(initiated.stdout || '{}').uploadId;
    } catch {
        return { ok: false, reason: 'bad-response' };
    }
    if (!uploadId) return { ok: false, reason: 'bad-response' };

    const parted = cliResult(run('aws', [
        'ecr', 'upload-layer-part',
        '--repository-name', repository,
        '--upload-id', uploadId,
        '--part-first-byte', '0',
        '--part-last-byte', String(blob.length - 1),
        // The blob parameter is --layer-part-blob (not --body); fileb://
        // forces the CLI to read blob bytes from disk, while a bare path
        // would be uploaded as literal content and fail the digest check
        // at complete-layer-upload.
        '--layer-part-blob', `fileb://${blobPath}`,
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' }), 'upload-layer-part');
    if (!parted.ok) return parted;

    return cliResult(run('aws', [
        'ecr', 'complete-layer-upload',
        '--repository-name', repository,
        '--upload-id', uploadId,
        '--layer-digests', digest,
        '--region', region,
        '--output', 'json',
    ], { encoding: 'utf8' }), 'complete-layer-upload');
}

// Pushes the placeholder image under `repository:tag`. ECR requires every
// referenced blob to exist before `put-image`, so both the config and the
// layer are uploaded first.
export function seedPlaceholderImage({ run, repository, tag = PLACEHOLDER_TAG, region }) {
    const image = buildPlaceholderImage();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grada-lambda-seed-'));
    try {
        for (const [label, blob, digest] of [
            ['config', image.configBlob, image.configDigest],
            ['layer', image.layerBlob, image.layerDigest],
        ]) {
            const uploaded = uploadBlob({ run, repository, region, blob, digest, tmpDir, label });
            if (!uploaded.ok) return uploaded;
        }
        const put = cliResult(run('aws', [
            'ecr', 'put-image',
            '--repository-name', repository,
            '--image-tag', tag,
            '--image-manifest', image.manifestJson,
            '--region', region,
            '--output', 'json',
        ], { encoding: 'utf8' }), 'put-image');
        if (!put.ok) return put;
        return { ok: true, seeded: true };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// Ensures `repository:tag` exists, seeding the placeholder only when the
// tag is absent (idempotent: reruns after a real CI push are no-ops).
export function ensureLambdaSeedImage({ run, repository, tag = PLACEHOLDER_TAG, region }) {
    const checked = ecrImageExists({ run, repository, tag, region });
    if (!checked.ok) return checked;
    if (checked.exists) return { ok: true, seeded: false };
    return seedPlaceholderImage({ run, repository, tag, region });
}
