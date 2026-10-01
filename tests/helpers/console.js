// Centralized process/console spy helpers for the test suite.
//
// The recurring trio (`process.exit` + `console.log` + `console.error`) is
// available as one bundle; individual spies cover the pair/single cases.
// Bespoke variants (e.g. an exit spy that throws) stay inline in their files.
//
// Usage:
//   import { mockConsoleTrio } from './helpers/console.js';
//   let spies;
//   beforeEach(() => { spies = mockConsoleTrio(); });
//   afterEach(() => { spies.restore(); });
//   // assertions read spies.exitSpy / spies.logSpy / spies.errorSpy
import { vi } from 'vitest';

export function mockProcessExit() {
    return vi.spyOn(process, 'exit').mockImplementation(() => {});
}

export function mockConsoleLog() {
    return vi.spyOn(console, 'log').mockImplementation(() => {});
}

export function mockConsoleError() {
    return vi.spyOn(console, 'error').mockImplementation(() => {});
}

export function mockConsoleTrio() {
    const exitSpy = mockProcessExit();
    const logSpy = mockConsoleLog();
    const errorSpy = mockConsoleError();
    return {
        exitSpy,
        logSpy,
        errorSpy,
        restore() {
            exitSpy.mockRestore();
            logSpy.mockRestore();
            errorSpy.mockRestore();
        },
    };
}
