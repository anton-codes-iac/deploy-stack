import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
    buildPlaceholderImage,
    ecrImageExists,
    seedPlaceholderImage,
    ensureLambdaSeedImage,
    PLACEHOLDER_TAG,
} from '../src/utils/lambda-ecr.js';

function okRun(stdout = '{}') {
    return vi.fn(() => ({ status: 0, stdout, stderr: '' }));
}

describe('lambda-ecr: placeholder image', () => {
    it('builds a self-consistent schema-2 manifest with runtime digests', () => {
        const image = buildPlaceholderImage();
        const manifest = JSON.parse(image.manifestJson);

        expect(manifest.schemaVersion).toBe(2);
        expect(manifest.config.digest).toBe(image.configDigest);
        expect(manifest.config.size).toBe(image.configBlob.length);
        expect(manifest.layers).toHaveLength(1);
        expect(manifest.layers[0].digest).toBe(image.layerDigest);
        expect(manifest.layers[0].size).toBe(image.layerBlob.length);

        // Digests recompute from the blobs (no memorized constants).
        const configDigest = `sha256:${crypto.createHash('sha256').update(image.configBlob).digest('hex')}`;
        const layerDigest = `sha256:${crypto.createHash('sha256').update(image.layerBlob).digest('hex')}`;
        expect(image.configDigest).toBe(configDigest);
        expect(image.layerDigest).toBe(layerDigest);

        // The layer is a valid gzip of an empty tar; the config targets amd64/linux.
        expect(zlib.gunzipSync(image.layerBlob).equals(Buffer.alloc(1024))).toBe(true);
        const config = JSON.parse(image.configBlob.toString('utf8'));
        expect(config.architecture).toBe('amd64');
        expect(config.os).toBe('linux');
    });

    it('defaults to the latest tag', () => {
        expect(PLACEHOLDER_TAG).toBe('latest');
    });
});

describe('lambda-ecr: ecrImageExists', () => {
    const base = { repository: 'myapp-repo', region: 'us-east-2' };

    it('returns exists=true when the tag is present', () => {
        const run = okRun(JSON.stringify({ imageDetails: [{ imageTags: ['latest'] }] }));
        expect(ecrImageExists({ run, ...base })).toEqual({ ok: true, exists: true });
        expect(run).toHaveBeenCalledWith(
            'aws',
            expect.arrayContaining(['ecr', 'describe-images', '--repository-name', 'myapp-repo']),
            expect.anything()
        );
    });

    it('returns exists=false on ImageNotFound and on empty details', () => {
        const missing = vi.fn(() => ({
            status: 254,
            stdout: '',
            stderr: 'An error occurred (ImageNotFoundException) when calling the DescribeImages operation',
        }));
        expect(ecrImageExists({ run: missing, ...base })).toEqual({ ok: true, exists: false });
        expect(ecrImageExists({ run: okRun('{"imageDetails": []}'), ...base })).toEqual({ ok: true, exists: false });
    });

    it('surfaces cli-missing and describe failures instead of throwing', () => {
        const noCli = vi.fn(() => ({ error: { code: 'ENOENT' } }));
        expect(ecrImageExists({ run: noCli, ...base })).toEqual({ ok: false, reason: 'cli-missing' });

        const denied = vi.fn(() => ({ status: 254, stdout: '', stderr: 'AccessDeniedException' }));
        expect(ecrImageExists({ run: denied, ...base })).toMatchObject({ ok: false, reason: 'describe-failed' });
    });
});

describe('lambda-ecr: seedPlaceholderImage', () => {
    const base = { repository: 'myapp-repo', region: 'us-east-2' };

    it('uploads both blobs before put-image and tags latest', () => {
        const calls = [];
        const run = vi.fn((cmd, args) => {
            calls.push(args);
            if (args[1] === 'initiate-layer-upload') return { status: 0, stdout: '{"uploadId": "upload-1"}', stderr: '' };
            return { status: 0, stdout: '{}', stderr: '' };
        });

        expect(seedPlaceholderImage({ run, ...base })).toEqual({ ok: true, seeded: true });

        const verbs = calls.map((args) => args[1]);
        expect(verbs).toEqual([
            'initiate-layer-upload', 'upload-layer-part', 'complete-layer-upload',
            'initiate-layer-upload', 'upload-layer-part', 'complete-layer-upload',
            'put-image',
        ]);
        const put = calls[calls.length - 1];
        expect(put).toContain('--image-tag');
        expect(put[put.indexOf('--image-tag') + 1]).toBe('latest');
        const manifest = JSON.parse(put[put.indexOf('--image-manifest') + 1]);
        expect(manifest.schemaVersion).toBe(2);
        expect(manifest.layers).toHaveLength(1);
    });

    it('stops at the first failed upload step', () => {
        const run = vi.fn((cmd, args) => {
            if (args[1] === 'initiate-layer-upload') return { status: 0, stdout: '{"uploadId": "u"}', stderr: '' };
            if (args[1] === 'upload-layer-part') return { status: 1, stdout: '', stderr: 'boom' };
            return { status: 0, stdout: '{}', stderr: '' };
        });
        expect(seedPlaceholderImage({ run, ...base })).toMatchObject({ ok: false });
        expect(run.mock.calls.some(([, args]) => args[1] === 'put-image')).toBe(false);
    });

    it('passes repository, region, and fileb:// blob paths on every call', () => {
        const calls = [];
        const run = vi.fn((cmd, args) => {
            calls.push(args);
            if (args[1] === 'initiate-layer-upload') return { status: 0, stdout: '{"uploadId": "upload-1"}', stderr: '' };
            return { status: 0, stdout: '{}', stderr: '' };
        });
        expect(seedPlaceholderImage({ run, ...base })).toEqual({ ok: true, seeded: true });

        expect(calls).toHaveLength(7);
        for (const args of calls) {
            expect(args[0]).toBe('ecr');
            expect(args).toContain('--repository-name');
            expect(args[args.indexOf('--repository-name') + 1]).toBe('myapp-repo');
            expect(args).toContain('--region');
            expect(args[args.indexOf('--region') + 1]).toBe('us-east-2');
        }
        const parts = calls.filter((args) => args[1] === 'upload-layer-part');
        expect(parts).toHaveLength(2);
        for (const args of parts) {
            expect(args).not.toContain('--body');
            const blob = args[args.indexOf('--layer-part-blob') + 1];
            expect(blob.startsWith('fileb://')).toBe(true);
            expect(args).toContain('--upload-id');
            expect(args).toContain('--part-first-byte');
            expect(args).toContain('--part-last-byte');
        }
        const completes = calls.filter((args) => args[1] === 'complete-layer-upload');
        expect(completes).toHaveLength(2);
        for (const args of completes) {
            expect(args).toContain('--upload-id');
            expect(args).toContain('--layer-digests');
        }
    });

    it('names the failing operation in seed errors', () => {
        const run = vi.fn((cmd, args) => {
            if (args[1] === 'initiate-layer-upload') return { status: 0, stdout: '{"uploadId": "u"}', stderr: '' };
            if (args[1] === 'upload-layer-part') return { status: 1, stdout: '', stderr: 'boom' };
            return { status: 0, stdout: '{}', stderr: '' };
        });
        expect(seedPlaceholderImage({ run, ...base })).toEqual({
            ok: false,
            reason: 'aws-failed',
            operation: 'upload-layer-part',
            detail: 'upload-layer-part: boom',
        });
    });
});

describe('lambda-ecr: ensureLambdaSeedImage', () => {
    const base = { repository: 'myapp-repo', region: 'us-east-2' };

    it('skips seeding when the tag already exists', () => {
        const run = okRun(JSON.stringify({ imageDetails: [{ imageTags: ['latest'] }] }));
        expect(ensureLambdaSeedImage({ run, ...base })).toEqual({ ok: true, seeded: false });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('seeds when the tag is missing and propagates check failures', () => {
        const run = vi.fn((cmd, args) => {
            if (args[1] === 'describe-images') return { status: 0, stdout: '{"imageDetails": []}', stderr: '' };
            if (args[1] === 'initiate-layer-upload') return { status: 0, stdout: '{"uploadId": "u"}', stderr: '' };
            return { status: 0, stdout: '{}', stderr: '' };
        });
        expect(ensureLambdaSeedImage({ run, ...base })).toEqual({ ok: true, seeded: true });

        const noCli = vi.fn(() => ({ error: { code: 'ENOENT' } }));
        expect(ensureLambdaSeedImage({ run: noCli, ...base })).toEqual({ ok: false, reason: 'cli-missing' });
    });
});
