import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoader, pc } from './load-ts.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const model = (level) => ({ asset: { data: { lodLevels: 3 } }, numSplats: 1000 / (level + 1), type: 'splat', worldBound: { center: {}, halfExtents: { length: () => 1 } },
    destroyed: false, destroy() { this.destroyed = true; this.scene?.remove(this); } });

function setup(load) {
    const exports = {};
    const handlers = new Map();
    const windowHandlers = new Map();
    const calls = { spinner: [], loads: [], focused: 0, cleared: 0, poses: [] };
    const loadModule = createLoader({}, { window: { addEventListener: (name, fn) => windowHandlers.set(name, fn) },
        document: { getElementById: () => ({ clientWidth: 800, clientHeight: 600 }) } });
    Object.assign(exports, loadModule('funes/lod/preview.ts'));
    const events = { fire: name => calls.spinner.push(name), function: (name, fn) => handlers.set(name, fn),
        on: (name, fn) => handlers.set(name, fn), off: name => handlers.delete(name) };
    const scene = {
        models: [],
        assetLoader: { load: async (request) => { calls.loads.push(request); return load ? load(request) : model(request.lodPreviewLevel); } },
        events,
        targetSize: { width: 800, height: 600 },
        camera: { focus: () => calls.focused++, fov: 45, distance: 1, sceneRadius: 1,
            camera: { horizontalFov: true },
            get fovFactor() { return Math.sin(this.fov * Math.PI / 360); },
            setDistance(distance) { this.distance = distance; },
            setPose(position, target) { calls.poses.push({ position, target });
                this.distance = position.distance(target) / this.sceneRadius * this.fovFactor; } },
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

test('first preview inherits the editor world camera and later levels preserve the comparison view', async () => {
    const s = setup();
    const framing = { version: 1, position: [4, 6, 8], target: [1, 2, 3], fov: 45, safeFrameAspect: 2 };
    await s.load({ data: new ArrayBuffer(2), level: 0, framing });
    assert.equal(s.calls.focused, 0, 'provided framing must replace the bounds fit');
    assert.equal(s.calls.poses.length, 1);
    assert.ok(s.calls.poses[0].position.equals(new pc.Vec3(4, 6, 8)), 'do not flip the native editor camera');
    assert.ok(s.calls.poses[0].target.equals(new pc.Vec3(1, 2, 3)), 'do not lock or rewrite a preview target');
    s.scene.camera.setPose(new pc.Vec3(10, 11, 12), new pc.Vec3(3, 4, 5));
    const cameraDistance = s.scene.camera.distance;
    await s.load({ level: 2 });
    assert.equal(s.calls.poses.length, 2, 'a level change must not restore the original snapshot');
    assert.equal(s.scene.camera.distance, cameraDistance);
    s.dispose();
});

test('malformed supplied framing fails before loading or replacing a visible level', async () => {
    const s = setup();
    await s.load({ data: new ArrayBuffer(2), level: 0 });
    const previous = s.scene.models[0];
    for (const framing of [null, {}, { version: 1, position: [1, 2, 3], target: [1, 2, 3], fov: 45 },
        { version: 1, position: [1, 2, Infinity], target: [0, 0, 0], fov: 45 },
        { version: 1, position: [1, 2, 3], target: [0, 0, 0], fov: 60 }]) {
        await assert.rejects(s.load({ data: new ArrayBuffer(2), level: 0, framing }), /preview.*view/i);
    }
    assert.equal(s.calls.loads.length, 1);
    assert.equal(s.scene.models[0], previous);
    assert.equal(previous.destroyed, false);
    s.dispose();
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

test('a cancelled archive never installs its camera and a fresh archive applies its own snapshot', async () => {
    const decode = deferred();
    const s = setup(request => request.lodPreviewLevel === 0 ? decode.promise : model(request.lodPreviewLevel));
    const firstFraming = { version: 1, position: [1, 2, 3], target: [0, 0, 0], fov: 45 };
    const first = s.load({ data: new ArrayBuffer(2), level: 0, framing: firstFraming });
    const rejected = assert.rejects(first, { name: 'AbortError' });
    await flush();
    const latestFraming = { ...firstFraming, position: [7, 8, 9] };
    const second = s.load({ data: new ArrayBuffer(3), level: 1, framing: latestFraming });
    decode.resolve(model(0));
    await rejected;
    await second;
    assert.equal(s.calls.poses.length, 1);
    assert.ok(s.calls.poses[0].position.equals(new pc.Vec3(7, 8, 9)));
    await s.load({ data: new ArrayBuffer(4), level: 2, framing: firstFraming });
    assert.equal(s.calls.poses.length, 2);
    assert.ok(s.calls.poses[1].position.equals(new pc.Vec3(1, 2, 3)));
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
