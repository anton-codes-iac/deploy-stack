// Centralized tmpdir fixture helper for the test suite.
//
// Usage:
//   import { createTmpDirTracker } from './helpers/tmpdir.js';
//   const tmp = createTmpDirTracker();
//   beforeEach(() => { tmp.reset(); });
//   afterEach(() => { tmp.cleanup(); });
//   // tests create dirs with: const dir = tmp.makeTmp('my-test-');
import fs from 'fs';
import os from 'os';
import path from 'path';

export function makeTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function createTmpDirTracker() {
    const dirs = [];
    return {
        dirs,
        makeTmp(prefix) {
            const dir = makeTmpDir(prefix);
            dirs.push(dir);
            return dir;
        },
        reset() {
            dirs.length = 0;
        },
        cleanup() {
            for (const dir of dirs) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
            dirs.length = 0;
        },
    };
}
