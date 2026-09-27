import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/funes/lod/preview.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const model = (level) => ({ asset: { data: { lodLevels: 3 } }, numSplats: 1000 / (level + 1), type: 'splat', worldBound: { center: {}, halfExtents: { length: () => 1 } },
    destroyed: false, destroy() { this.destroyed = true; this.scene?.remove(this); } });

function setup(load) {
    const exports = {};
    const handlers = new Map();
    const windowHandlers = new Map();
    const calls = { spinner: [], loads: [], focused: 0, cleared: 0 };
    vm.runInNewContext(compiled, { exports, File, ArrayBuffer, AbortController, DOMException,
        window: { addEventListener: (name, fn) => windowHandlers.set(name, fn) } });
    const events = { fire: name => calls.spinner.push(name), function: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) };
    const scene = {
        models: [],
        assetLoader: { load: async (request) => { calls.loads.push(request); return load ? load(request) : model(request.lodPreviewLevel); } },
        camera: { focus: () => calls.focused++ },
        add(value) { value.scene = this; this.models.push(value); },
        getElementsByType() { return this.models; },
        remove(value) { this.models = this.models.filter(item => item !== value); },
        clear() { calls.cleared++; for (const item of this.models) item.destroy(); this.models = []; }
    };
    const dispose = exports.registerLodPreview(events, scene, scene.assetLoader.load);
    return { scene, calls, dispose, pagehide: () => windowHandlers.get('pagehide')(),
        cancel: () => handlers.get('lod.preview.cancel')(), load: (request) => handlers.get('lod.preview.load')(request) };
}

test('preview reuses its ZIP across true level loads, frees the old scene and frames only once', async () => {
    const s = setup();
    const data = Uint8Array.of(1, 2, 3).buffer;
    const first = await s.load({ data, level: 0, manifestPath: 'scene/lod-meta.json' });
    const old = s.scene.models[0];
    const second = await s.load({ level: 2 });
    assert.deepEqual(s.calls.spinner, ['startSpinner', 'stopSpinner', 'startSpinner', 'stopSpinner']);
    assert.equal(first.pointCount, 1000);
    assert.equal(second.pointCount, 1000 / 3);
    assert.equal(second.lodLevels, 3);
    assert.equal(s.calls.loads[0].contents, s.calls.loads[1].contents);
    assert.deepEqual([...new Uint8Array(await s.calls.loads[1].contents.arrayBuffer())], [1, 2, 3]);
    assert.equal(s.calls.loads[1].lodPreviewLevel, 2);
    assert.equal(s.calls.loads[1].lodManifestPath, 'scene/lod-meta.json');
    assert.equal(s.calls.loads[1].animationFrame, true);
    assert.equal(s.calls.focused, 1);
    assert.equal(old.destroyed, true);
    assert.equal(s.scene.models.length, 1);
    const active = s.scene.models[0];
    s.pagehide();
    assert.equal(active.destroyed, true);
    await assert.rejects(s.load({ level: 1 }), { name: 'AbortError' });
});

test('superseded decoding is cancelled and released before the next level starts', async () => {
    const firstDecode = deferred();
    const s = setup((request) => request.lodPreviewLevel === 0 ? firstDecode.promise : model(request.lodPreviewLevel));
    const first = s.load({ data: new ArrayBuffer(2), level: 0 });
    const rejected = assert.rejects(first, { name: 'AbortError' });
    await flush();
    const second = s.load({ level: 1 });
    assert.equal(s.calls.loads[0].signal.aborted, true);
    await flush();
    assert.equal(s.calls.loads.length, 1);
    const stale = model(0);
    firstDecode.resolve(stale);
    await rejected;
    await second;
    assert.equal(stale.destroyed, true);
    assert.equal(s.scene.models.length, 1);
    assert.equal(s.scene.models[0].numSplats, 500);
    assert.equal(s.calls.focused, 1);
    s.dispose();
});

test('failed or cancelled replacement leaves the previous preview intact and allows retry', async () => {
    let fail = true;
    const s = setup((request) => {
        if (request.lodPreviewLevel === 1 && fail) throw new Error('texture failed');
        return model(request.lodPreviewLevel);
    });
    await s.load({ data: new ArrayBuffer(2), level: 0 });
    const previous = s.scene.models[0];
    await assert.rejects(s.load({ level: 1 }), /texture failed/);
    assert.equal(previous.destroyed, false);
    assert.equal(s.scene.models[0], previous);
    fail = false;
    await s.load({ level: 1 });
    assert.equal(previous.destroyed, true);
    assert.equal(s.calls.focused, 1);
    s.dispose();
});

test('close during an in-flight decode destroys the late resource without installing it', async () => {
    const decode = deferred();
    const s = setup(() => decode.promise);
    const loading = s.load({ data: new ArrayBuffer(2), level: 0 });
    const rejected = assert.rejects(loading, { name: 'AbortError' });
    await flush();
    s.dispose();
    const late = model(0);
    decode.resolve(late);
    await rejected;
    assert.equal(late.destroyed, true);
    assert.equal(s.scene.models.length, 0);
});

test('invalid ZIP inputs and unsupported levels do not allocate loader resources', async () => {
    const s = setup();
    for (const request of [{ level: 0 }, { data: new ArrayBuffer(0), level: 0 },
        { data: new ArrayBuffer(1), level: -1 }, { data: new ArrayBuffer(1), level: 0.5 }, { data: new ArrayBuffer(1), level: 32 }]) {
        await assert.rejects(s.load(request));
    }
    assert.equal(s.calls.loads.length, 0);
    s.dispose();
});

test('failed preview loading always releases the native spinner', async () => {
    const s = setup(async () => { throw new Error('decode failed'); });
    await assert.rejects(s.load({ data: new ArrayBuffer(2), level: 0 }), /decode failed/);
    assert.deepEqual(s.calls.spinner, ['startSpinner', 'stopSpinner']);
});
