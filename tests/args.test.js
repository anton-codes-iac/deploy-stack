import { describe, it, expect } from 'vitest';
import { parseFlags, normalizeOptions, normalizeArgv } from '../src/utils/args.js';

describe('parseFlags', () => {
    it('parses string flags in space and = forms with last-wins', () => {
        expect(parseFlags(['--region', 'a', '--region=b'], { string: ['region'] })).toEqual({
            options: { region: 'b' },
            rest: [],
        });
        expect(parseFlags(['--project-name=x'], { string: ['project-name'] }).options).toEqual({
            projectName: 'x',
        });
    });

    it('supports explicit key overrides', () => {
        expect(parseFlags(['--headless'], { boolean: [{ name: 'headless', key: 'isHeadless' }] }).options).toEqual({
            isHeadless: true,
        });
    });

    it('drops trailing string flags without a value', () => {
        expect(parseFlags(['--cluster'], { string: ['cluster'] })).toEqual({ options: {}, rest: [] });
    });

    it('consumes the next arg as a value even when it looks like a flag', () => {
        expect(parseFlags(['--cluster', '--service', 'x'], { string: ['cluster', 'service'] })).toEqual({
            options: { cluster: '--service' },
            rest: ['x'],
        });
    });

    it('coerces number flags in both forms', () => {
        expect(parseFlags(['--tail', '50'], { number: ['tail'] }).options).toEqual({ tail: 50 });
        expect(parseFlags(['--tail=25'], { number: ['tail'] }).options).toEqual({ tail: 25 });
    });

    it('parses booleans bare and =true/=false', () => {
        expect(parseFlags(['--force'], { boolean: ['force'] }).options).toEqual({ force: true });
        expect(parseFlags(['--force=false'], { boolean: ['force'] }).options).toEqual({ force: false });
        expect(parseFlags(['--force=yes'], { boolean: ['force'] }).options).toEqual({ force: false });
    });

    it('ignores =forms on bare-only booleans', () => {
        expect(parseFlags(['--error'], { bareBoolean: ['error'] }).options).toEqual({ error: true });
        expect(parseFlags(['--error=false'], { bareBoolean: ['error'] })).toEqual({ options: {}, rest: [] });
    });

    it('expands single-dash aliases to their long flags', () => {
        expect(parseFlags(['-f'], { bareBoolean: ['follow'], alias: { f: 'follow' } }).options).toEqual({
            follow: true,
        });
        expect(parseFlags(['-x'], { bareBoolean: ['follow'], alias: { f: 'follow' } }).rest).toEqual(['-x']);
    });

    it('returns positionals and unknown args in rest', () => {
        expect(parseFlags(['a', '--unknown', 'b', '--unknown=x'], { string: ['region'] })).toEqual({
            options: {},
            rest: ['a', 'b'],
        });
    });
});

describe('normalizeOptions', () => {
    it('passes objects through untouched', () => {
        const options = { region: 'x' };
        expect(normalizeOptions(options)).toBe(options);
        expect(normalizeOptions({})).toEqual({});
    });

    it.each([null, undefined, 'string', 42, true])('coerces %s to {}', (value) => {
        expect(normalizeOptions(value)).toEqual({});
    });
});

describe('normalizeArgv', () => {
    it('copies arrays', () => {
        const argv = ['db', 'migrate'];
        const copy = normalizeArgv(argv);
        expect(copy).toEqual(argv);
        expect(copy).not.toBe(argv);
    });

    it.each([null, undefined, 'string', 42, true, { port: 'string' }])('coerces %s to []', (value) => {
        expect(normalizeArgv(value)).toEqual([]);
    });
});
