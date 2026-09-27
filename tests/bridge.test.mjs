import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoader } from './load-ts.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const setup = (query = '', options = {}) => {
    const messages = [];
    const listeners = new Map();
    const parent = { postMessage: (...args) => messages.push(args) };
    const win = { parent, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
    const load = createLoader({}, { window: win, document: { referrer: options.referrer ?? 'https://cms.example/edit' } });
    const { Events } = load('events.ts');
    const events = new Events();
    events.function('scene.dirty', () => true);
    const exports = [];
    const adapter = { hasModel: () => options.hasModel !== false, export: async (...args) => {
        exports.push(args);
        return options.export ? options.export(...args) : [Uint8Array.of(1, 2, 3)];
    } };
    const bridge = load('funes/bridge.ts').registerBridge(events, new URL(`https://editor.example/?${query}`), adapter);
    const message = (data, origin = 'https://cms.example', source = parent) => listeners.get('message')?.({ data, origin, source });
    return { events, messages, exports, bridge, message, parent };
};

test('hello pins protocol, runtime and real WebGPU-only capabilities to the trusted parent', () => {
    const s = setup('embedOrigin=https://cms.example');
    for (const [origin, source] of [['https://evil.example', s.parent], ['https://cms.example', {}]]) {
        s.message({ type: 'funes:hello', protocolVersion: 1, requestId: 'x' }, origin, source);
    }
    s.message({ type: 'funes:hello', protocolVersion: 2, requestId: 'x' });
    assert.equal(s.messages.length, 0);
    s.message({ type: 'funes:hello', protocolVersion: 1, requestId: 'ok' });
    const [reply, origin] = s.messages[0];
    assert.equal(reply.runtimeVersion, '3.3.0');
    assert.equal(reply.protocolVersion, 1);
    assert.equal(reply.capabilities.fullShPlyExport, true);
    assert.equal(reply.graphicsBackend, 'webgpu');
    assert.equal(reply.capabilities.webglFallback, false);
    assert.equal(reply.capabilities.graphicsDiagnostics, false);
    assert.ok(Object.values(reply.capabilities).every(value => typeof value === 'boolean'));
    assert.equal(origin, 'https://cms.example');
});

test('missing trusted referrer/configured origin fails closed; a safe referrer preserves legacy hosts', () => {
    const blocked = setup('', { referrer: '' });
    blocked.message({ type: 'supersplat:status' });
    assert.equal(blocked.messages.length, 0);
    const invalid = setup('embedOrigin=*');
    invalid.message({ type: 'supersplat:status' });
    assert.equal(invalid.messages.length, 0);
    const legacy = setup();
    legacy.message({ type: 'supersplat:status' });
    assert.equal(legacy.messages[0][0].state, 'loading');
});

test('export requires loaded nonempty model and always defaults to all SH3 independently of display', async () => {
    const s = setup();
    s.message({ type: 'supersplat:export', requestId: 'early' });
    await tick();
    assert.equal(s.messages.at(-1)[0].ok, false);
    s.events.fire('embed.load.status', { state: 'ready' });
    s.message({ type: 'supersplat:export', requestId: 'save', filename: 'model' });
    await tick();
    assert.deepEqual(s.exports[0], ['ply', 'model.ply', 3]);
    const result = s.messages.at(-1)[0];
    assert.equal(result.ok, true);
    assert.deepEqual([...new Uint8Array(result.buffers[0])], [1, 2, 3]);
    const empty = setup('', { hasModel: false });
    empty.events.fire('embed.load.status', { state: 'ready' });
    empty.message({ type: 'supersplat:export' });
    await tick();
    assert.equal(empty.exports.length, 0);
});

test('export preserves typed-array slices and reports failures without falsely succeeding', async () => {
    const s = setup('', { export: async () => [Uint8Array.of(0, 1, 2, 9).subarray(1, 3)] });
    s.events.fire('embed.load.status', { state: 'ready' });
    s.message({ type: 'supersplat:export', exportType: 'sog' });
    await tick();
    assert.deepEqual([...new Uint8Array(s.messages.at(-1)[0].buffers[0])], [1, 2]);
    assert.equal(s.exports[0][0], 'splat', 'legacy sog message still explicitly returns splat bytes');
    for (const result of [[], [new Uint8Array(0)]]) {
        const failed = setup('', { export: async () => result });
        failed.events.fire('embed.load.status', { state: 'ready' });
        failed.message({ type: 'supersplat:export' });
        await tick();
        assert.equal(failed.messages.at(-1)[0].ok, false);
    }
});

test('preview capabilities cannot export and stale level completion cannot overwrite the new result', async () => {
    const s = setup('lodPreview=1');
    const pending = new Map();
    s.events.function('lod.preview.load', request => new Promise(resolve => pending.set(request.level, resolve)));
    s.message({ type: 'funes:hello', requestId: 'h', protocolVersion: 1 });
    assert.equal(s.messages.at(-1)[0].capabilities.gaussianEdit, false);
    s.events.fire('embed.load.status', { state: 'ready' });
    s.message({ type: 'supersplat:export' });
    await tick();
    assert.equal(s.messages.at(-1)[0].ok, false);
    assert.equal(s.exports.length, 0);
    s.message({ type: 'supersplat:lod-preview:load', requestId: 'old', data: new ArrayBuffer(1), level: 0 });
    await tick();
    s.message({ type: 'supersplat:lod-preview:level', requestId: 'new', level: 2 });
    await tick();
    pending.get(2)({ level: 2, pointCount: 4 });
    await tick();
    const count = s.messages.length;
    pending.get(0)({ level: 0, pointCount: 64 });
    await tick();
    assert.equal(s.messages.length, count);
    assert.equal(s.messages.at(-1)[0].level, 2);
    s.bridge.dispose();
    s.message({ type: 'supersplat:status' });
    assert.equal(s.messages.length, count);
});

test('LOD requests fail explicitly when the runtime has no browser generator', async () => {
    const s = setup();
    s.events.fire('embed.load.status', { state: 'ready' });
    s.message({ type: 'supersplat:export', requestId: 'lod', exportType: 'lod', filename: 'model.zip' });
    await tick();
    assert.equal(s.messages.at(-1)[0].ok, false);
    assert.equal(s.exports.length, 0);
});
