import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/e2e/tier0.e2e.test.js'],
        testTimeout: 300000,
    },
});
