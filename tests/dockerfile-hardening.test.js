// Structural hardening contract for the multi-stage Dockerfile templates.
//
// Snapshots pin exact template text; these assertions pin the security
// properties that must survive any template edit: multiple stages, a named
// runner, a non-root final user, and no package-manager installs past the
// last FROM (removal lines like `rm -rf .../npm` are allowed).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TEMPLATES_DIR = path.join(process.cwd(), 'templates', 'docker');
const HARDENED_TEMPLATES = ['node', 'python', 'django'];

function readTemplate(framework) {
    return fs.readFileSync(path.join(TEMPLATES_DIR, `${framework}.Dockerfile`), 'utf-8');
}

function runnerStage(content) {
    const lines = content.split('\n');
    let lastFromIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*FROM\s+/i.test(lines[i])) lastFromIdx = i;
    }
    return lines.slice(lastFromIdx + 1).join('\n');
}

describe('Dockerfile hardening (node, python, django)', () => {
    for (const framework of HARDENED_TEMPLATES) {
        it(`${framework}.Dockerfile uses a multi-stage build with a hardened runner`, () => {
            const content = readTemplate(framework);
            const fromLines = content.split('\n').filter((line) => /^\s*FROM\s+/i.test(line));
            expect(fromLines.length).toBeGreaterThanOrEqual(2);
            expect(fromLines[fromLines.length - 1]).toMatch(/\sAS\s+runner\s*$/i);

            const runner = runnerStage(content);
            const userLines = runner.split('\n').filter((line) => /^\s*USER\s+\S+/i.test(line));
            expect(userLines.length).toBeGreaterThanOrEqual(1);
            const finalUser = userLines[userLines.length - 1].trim().split(/\s+/)[1];
            expect(['root', '0']).not.toContain(finalUser);

            const installLines = runner.split('\n').filter((line) =>
                /\b(npm\s+(ci|install|i\b)|pip3?\s+install)\b/.test(line)
            );
            expect(installLines).toEqual([]);
        });
    }
});
