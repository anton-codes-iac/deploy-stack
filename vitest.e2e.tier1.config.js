import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/e2e/tier1.live.e2e.test.js'],
        testTimeout: 1200000,
    },
});
