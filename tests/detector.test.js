import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectMigrationCommand } from '../src/utils/detector.js';

function makeProject(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-migrate-'));
    for (const [name, content] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return dir;
}

describe('detectMigrationCommand', () => {
    it('prefers the db:migrate npm script', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ scripts: { 'db:migrate': 'prisma migrate deploy', migrate: 'other' } }),
        });
        expect(detectMigrationCommand(dir)).toBe('npm run db:migrate');
    });

    it('falls back to the migrate npm script', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ scripts: { migrate: 'knex migrate:latest' } }),
        });
        expect(detectMigrationCommand(dir)).toBe('npm run migrate');
    });

    it('detects Prisma via schema file or dependency', () => {
        expect(detectMigrationCommand(makeProject({ 'prisma/schema.prisma': 'datasource db {}' })))
            .toBe('npx prisma migrate deploy');
        expect(detectMigrationCommand(makeProject({
            'package.json': JSON.stringify({ dependencies: { prisma: '^5.0.0' } }),
        }))).toBe('npx prisma migrate deploy');
        expect(detectMigrationCommand(makeProject({
            'package.json': JSON.stringify({ devDependencies: { prisma: '^5.0.0' } }),
        }))).toBe('npx prisma migrate deploy');
    });

    it('detects Drizzle via config file extensions', () => {
        for (const file of ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs']) {
            expect(detectMigrationCommand(makeProject({ [file]: 'export default {}' })))
                .toBe('npx drizzle-kit migrate');
        }
    });

    it('detects Alembic, Django, and Rails markers', () => {
        expect(detectMigrationCommand(makeProject({ 'alembic.ini': '[alembic]' })))
            .toBe('alembic upgrade head');
        expect(detectMigrationCommand(makeProject({ 'manage.py': '# django' })))
            .toBe('python manage.py migrate --noinput');
        expect(detectMigrationCommand(makeProject({ 'bin/rails': '#!/usr/bin/env ruby' })))
            .toBe('bundle exec rails db:migrate');
        expect(detectMigrationCommand(makeProject({ Gemfile: 'source "https://rubygems.org"\ngem "rails"\n' })))
            .toBe('bundle exec rails db:migrate');
    });

    it('ignores a Gemfile without rails', () => {
        const dir = makeProject({ Gemfile: 'source "https://rubygems.org"\ngem "sinatra"\n' });
        expect(detectMigrationCommand(dir)).toBeNull();
    });

    it('returns null for empty projects and survives malformed files', () => {
        expect(detectMigrationCommand(makeProject({}))).toBeNull();
        expect(detectMigrationCommand(makeProject({ 'package.json': 'not-json{{{' }))).toBeNull();
        expect(detectMigrationCommand('/nonexistent-dir-xyz')).toBeNull();
    });

    it('keeps priority order across mixed markers', () => {
        const dir = makeProject({
            'package.json': JSON.stringify({ scripts: { migrate: 'x' }, dependencies: { prisma: '1' } }),
            'manage.py': '# django',
        });
        expect(detectMigrationCommand(dir)).toBe('npm run migrate');
    });
});
