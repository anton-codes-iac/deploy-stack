// Centralized `node:net` mock for the test suite.
//
// `db-tunnel.js` is the only production module importing `node:net`, so a
// file-level mock stays tightly scoped:
//
//   import { netMockFactory, resetNetMock } from './helpers/net.js';
//   vi.mock('node:net', () => netMockFactory());
//
// The mock simulates a fake loopback network instead of binding real sockets
// (restricted CI sandboxes reject binds with EPERM). Servers that `listen(0)`
// allocate from a deterministic fake-port counter and register as open, so
// `connect` to a listening port emits `connect` and anywhere else emits
// `error` — the `pollUntil` retry loop in `waitForTcpPort` stays fully
// exercised, never stubbed.
//
// Per-test control: call `resetNetMock()` at the start of each TCP test for
// deterministic ports. `mockNetConnect` call counts pin retry behavior
// (a closed port must probe more than once before timing out).
import { EventEmitter } from 'events';
import { vi } from 'vitest';

const FAKE_PORT_START = 50000;

let nextFakePort = FAKE_PORT_START;
const openPorts = new Set();

export function resetNetMock() {
    nextFakePort = FAKE_PORT_START;
    openPorts.clear();
}

class FakeSocket extends EventEmitter {
    constructor({ open }) {
        super();
        this._timer = null;
        // Real sockets emit asynchronously so handlers attached after
        // `connect()` still fire; mirror that with nextTick.
        process.nextTick(() => {
            if (open) {
                this.emit('connect');
            } else {
                this.emit('error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' }));
            }
        });
    }
    setTimeout(timeoutMs, callback) {
        this._timer = setTimeout(callback, timeoutMs);
        return this;
    }
    destroy() {
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        return this;
    }
}

class FakeServer extends EventEmitter {
    constructor() {
        super();
        this._port = null;
    }
    listen(port, host, callback) {
        if (typeof host === 'function') {
            callback = host;
            host = undefined;
        }
        this._port = port === 0 ? nextFakePort++ : port;
        openPorts.add(this._port);
        if (typeof callback === 'function') process.nextTick(callback);
        return this;
    }
    address() {
        return { address: '127.0.0.1', family: 'IPv4', port: this._port };
    }
    close(callback) {
        if (this._port !== null) openPorts.delete(this._port);
        this._port = null;
        if (typeof callback === 'function') process.nextTick(callback);
        return this;
    }
}

export const mockNetConnect = vi.fn(({ port } = {}) => new FakeSocket({ open: openPorts.has(port) }));
export const mockNetCreateServer = vi.fn(() => new FakeServer());

export function netMockFactory() {
    const api = { connect: mockNetConnect, createServer: mockNetCreateServer };
    return { ...api, default: api };
}
