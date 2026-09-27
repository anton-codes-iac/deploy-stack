import { describe, it, expect, vi } from 'vitest';
import { pollUntil, parseTimeoutSeconds } from '../src/utils/system.js';

describe('parseTimeoutSeconds', () => {
    it('returns the default when omitted or blank', () => {
        expect(parseTimeoutSeconds(undefined, 600)).toBe(600);
        expect(parseTimeoutSeconds(null, 900)).toBe(900);
        expect(parseTimeoutSeconds('', 600)).toBe(600);
        expect(parseTimeoutSeconds('   ', 600)).toBe(600);
    });

    it('parses positive integers', () => {
        expect(parseTimeoutSeconds('60', 600)).toBe(60);
        expect(parseTimeoutSeconds(' 120 ', 600)).toBe(120);
        expect(parseTimeoutSeconds(30, 600)).toBe(30);
    });

    it.each(['0', '-5', 'abc', '60s', '1.5', '0x10'])('rejects %s', (value) => {
        expect(parseTimeoutSeconds(value, 600)).toBeNull();
    });
});

describe('pollUntil', () => {
    it('resolves immediately when the first tick is done', async () => {
        const sleepFn = vi.fn(() => Promise.resolve());
        const outcome = await pollUntil({
            intervalMs: 1000,
            timeoutMs: 60000,
            sleepFn,
            nowFn: () => 0,
            onTick: async () => ({ done: true, value: 'v' }),
        });
        expect(outcome).toEqual({ done: true, value: 'v' });
        expect(sleepFn).not.toHaveBeenCalled();
    });

    it('ticks until done, reporting elapsed time', async () => {
        let now = 0;
        const seen = [];
        const outcome = await pollUntil({
            intervalMs: 100,
            timeoutMs: 10000,
            sleepFn: async () => { now += 100; },
            nowFn: () => now,
            onTick: async ({ elapsedMs }) => {
                seen.push(elapsedMs);
                return seen.length >= 3 ? { done: true, value: 'late' } : { done: false };
            },
        });
        expect(outcome).toEqual({ done: true, value: 'late' });
        expect(seen).toEqual([0, 100, 200]);
    });

    it('times out without running the tick past the deadline', async () => {
        let now = 0;
        let ticks = 0;
        const outcome = await pollUntil({
            intervalMs: 100,
            timeoutMs: 250,
            sleepFn: async () => { now += 100; },
            nowFn: () => now,
            onTick: async () => {
                ticks += 1;
                return { done: false };
            },
        });
        expect(outcome).toEqual({ timedOut: true });
        expect(ticks).toBe(3);
    });
});
