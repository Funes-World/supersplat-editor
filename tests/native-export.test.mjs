import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoader, pc, st } from './load-ts.mjs';

class Control extends pc.EventHandler {
    children = [];
    constructor(options = {}) { super(); Object.assign(this, options); }
    append(child) { this.children.push(child); }
}
class VectorControl extends Control { inputs = [new Control(), new Control(), new Control()]; }
const load = createLoader({ '@playcanvas/pcui': { Container: Control, Label: Control, NumericInput: Control, VectorInput: VectorControl } });
const { writeSplatFile } = load('splat-serialize.ts');
const { Events } = load('events.ts');
const { registerPivotEvents } = load('pivot.ts');
const { EntityTransformHandler } = load('entity-transform-handler.ts');
const { Transform: TransformPanel } = load('ui/transform.ts');

const fixture = (bands = 3) => {
    const n = [0, 9, 24, 45][bands];
    const values = { x: [4, 10], y: [6, 12], z: [8, 14], rot_0: [1, 1], rot_1: [0, 0], rot_2: [0, 0], rot_3: [0, 0],
        scale_0: [Math.log(0.2), Math.log(0.2)], scale_1: [Math.log(0.4), Math.log(0.4)], scale_2: [Math.log(0.8), Math.log(0.8)],
        opacity: [0, 0], f_dc_0: [0.1, 0.1], f_dc_1: [0.2, 0.2], f_dc_2: [0.3, 0.3],
        ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`f_rest_${i}`, [(i + 1) / 100, (i + 1) / 100]])) };
    const table = new st.DataTable(Object.entries(values).map(([name, data]) => new st.Column(name, Float32Array.from(data))), st.Transform.PLY);
    const source = st.dataTableToChunkSource(table, 4);
    const entity = new pc.Entity();
    entity.setEulerAngles(0, 0, 180);
    const palette = [new pc.Mat4(), new pc.Mat4().setScale(0.5, 0.5, 0.5)];
    const indices = [0, 0];
    return { entity, resource: { source, shBands: bands }, instances: { count: 2, flags: new Uint8Array(2),
        sourceRow: Uint32Array.of(0, 1), transformIndex: i => indices[i], colorIndex: () => 0 }, indices,
        transformPalette: { getTransform: (i, result) => result.copy(palette[i]) }, colorPalette: { getEntry() {} },
        move(position, rotation, scale) { entity.setLocalPosition(position); entity.setLocalRotation(rotation); entity.setLocalScale(scale); },
        getPivot(result) { result.set(entity.getLocalPosition(), entity.getLocalRotation(), entity.getLocalScale()); } };
};
const serialize = async (splat, format = 'ply') => {
    const fs = new st.MemoryFileSystem();
    await writeSplatFile([splat], { maxSHBands: 3 }, format, `model.${format}`, {}, fs);
    return Buffer.from(fs.results.get(`model.${format}`));
};
const parse = bytes => {
    const start = bytes.indexOf('end_header\n') + 11;
    const header = bytes.subarray(0, start).toString();
    const names = [...header.matchAll(/^property float (.+)$/gm)].map(match => match[1]);
    const count = Number(header.match(/element vertex (\d+)/)[1]);
    return Array.from({ length: count }, (_, row) => Object.fromEntries(names.map((name, col) => [name, bytes.readFloatLE(start + 4 * (row * names.length + col))])));
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

test('real v3 scale control → pivot → entity → native PLY export bakes coordinates, dimensions and all SH3', async () => {
    const splat = fixture();
    const events = new Events();
    registerPivotEvents(events);
    events.function('selection', () => splat);
    events.on('edit.add', op => op.do());
    const panel = new TransformPanel(events);
    new EntityTransformHandler(events).activate();
    const input = panel.children[2].children[1];
    input.value = 0.25;
    input.fire('change', 0.25);
    const rows = parse(await serialize(splat));
    close(rows[0].x, 1); close(rows[0].y, 1.5); close(rows[0].z, 2);
    close(rows[1].x, 2.5);
    close(Math.exp(rows[0].scale_0), 0.05);
    for (let i = 0; i < 45; i++) close(rows[0][`f_rest_${i}`], (i + 1) / 100);
    const bytes = await serialize(splat, 'splat');
    assert.equal(bytes.length, 64);
    close(bytes.readFloatLE(0), 1); close(bytes.readFloatLE(12), 0.05);
    await splat.resource.source.close();
});

test('native export preserves selected instance transforms without changing other rows', async () => {
    const splat = fixture();
    splat.indices[0] = 1;
    const rows = parse(await serialize(splat));
    close(rows[0].x, 2); close(rows[1].x, 10);
    close(Math.exp(rows[0].scale_0), 0.1); close(Math.exp(rows[1].scale_0), 0.2);
    await splat.resource.source.close();
});

test('native ChunkSource concatenation promotes mixed SH by channel and can gather across file boundaries', async () => {
    const { concatenateLod } = load('funes/adapters/chunk-source.ts');
    const combined = await concatenateLod([1, 3].map(bands => ({ count: 2, open: async () => fixture(bands).resource.source })), 3, new AbortController().signal);
    const pool = st.createChunkDataPool({ chunkSize: combined.meta.chunkSize });
    const color = pool.acquire('color', combined.meta.layouts.color, 2);
    await combined.read({ indices: Uint32Array.of(0, 3), indexOffset: 0, count: 2, color });
    const values = new Float32Array(color.data);
    close(values[3], 0.01); close(values[3 + 15], 0.04); close(values[3 + 30], 0.07);
    close(values[6], 0); close(values[48 + 47], 0.45);
    color.release(); pool.destroy(); await combined.close();
});

test('LOD cache releases evicted sources, rejects incorrect decoded counts, and cleans up cancellation', async () => {
    const { concatenateLod } = load('funes/adapters/chunk-source.ts');
    const closed = [];
    const open = index => async () => {
        const source = fixture().resource.source;
        const close = source.close.bind(source);
        source.close = async () => { closed.push(index); await close(); };
        return source;
    };
    const controller = new AbortController();
    const combined = await concatenateLod([0, 1, 2].map(i => ({ count: 2, open: open(i) })), 3, controller.signal);
    const pool = st.createChunkDataPool({ chunkSize: combined.meta.chunkSize });
    const position = pool.acquire('position', combined.meta.layouts.position, 1);
    for (const row of [2, 4]) await combined.read({ indices: Uint32Array.of(row), indexOffset: 0, count: 1, position });
    assert.deepEqual(closed, [0]);
    controller.abort(new DOMException('closed', 'AbortError'));
    await assert.rejects(combined.read({ indices: Uint32Array.of(0), indexOffset: 0, count: 1, position }), { name: 'AbortError' });
    await combined.close();
    assert.deepEqual(closed.sort(), [0, 1, 2]);
    position.release(); pool.destroy();
    await assert.rejects(concatenateLod([{ count: 3, open: open(3) }], 3, new AbortController().signal), /metadata/);
    assert.ok(closed.includes(3));
});

test('partial selection pivot stays at its centre and respects an explicit native local frame', () => {
    const { CenteredSplatsTransformHandler } = load('funes/adapters/transform-handler.ts');
    const splat = fixture();
    splat.numSelected = 1;
    splat.selectionBound = new pc.BoundingBox(new pc.Vec3(4, 6, 8), new pc.Vec3(1, 1, 1));
    const events = new Events();
    registerPivotEvents(events);
    events.function('selection', () => splat);
    const handler = new CenteredSplatsTransformHandler(events);
    handler.activate();
    const pivot = events.invoke('pivot');
    close(pivot.transform.position.x, -4); close(pivot.transform.position.y, -6); close(pivot.transform.position.z, 8);
    splat.hasLocalFrame = true;
    handler.placePivot();
    close(pivot.transform.position.length(), 0);
});

test('extension origin is undoable and reset restores the initial camera after the scene scale changes', () => {
    const events = new Events();
    const splat = fixture();
    splat.entity.setPosition(3, 4, 5);
    splat.localFrameOrigin = new pc.Vec3();
    splat.localFrame = new pc.Quat();
    splat.setLocalFrame = (origin, rotation) => { splat.localFrameOrigin.copy(origin); splat.localFrame.copy(rotation); };
    events.function('selection', () => splat);
    let edit;
    events.on('edit.add', op => { edit = op; op.do(); });
    const camera = { focalPoint: new pc.Vec3(1, 2, 3), azim: 7, elevation: 9, distance: 2, sceneRadius: 4,
        setFocalPoint(v) { this.focalPoint.copy(v); }, setAzimElev(a, e) { this.azim = a; this.elevation = e; },
        setDistance(value) { this.distance = value; } };
    const doc = { body: { classList: { add() {} } }, getElementById: () => ({ appendChild() {} }) };
    const uiLoad = createLoader({ '@playcanvas/pcui': { Button: class extends Control { dom = {}; destroy() {} } },
        '../adapters/editor-v3': { splatsInScene: () => [splat] },
        './origin-marker': { OriginMarker: class { destroy() {} } },
        './initial-frame-overlay': { InitialFrameOverlay: class { destroy() {} } }
    }, { document: doc, window: { addEventListener() {} } });
    let stochastic = 'auto';
    events.on('view.setStochastic', value => { stochastic = value; });
    uiLoad('funes/ui/editor-ui.ts').attachEditorUi(events, { camera }, { canvasContainer: { dom: {} } }, false);
    assert.equal(stochastic, 'disabled', 'embedded editing must not introduce motion sampling noise');
    stochastic = 'movement';
    events.fire('preferences.resume');
    assert.equal(stochastic, 'disabled', 'restored upstream preferences must not re-enable noisy rendering');
    const before = splat.entity.getWorldTransform().clone();
    events.fire('splat.setOrigin');
    assert.ok(splat.entity.getWorldTransform().equals(before), 'setting origin must not move geometry');
    const worldOrigin = before.transformPoint(splat.localFrameOrigin);
    close(worldOrigin.length(), 0);
    edit.undo();
    close(splat.localFrameOrigin.length(), 0);
    events.fire('postrender');
    camera.focalPoint.set(0, 0, 0); camera.azim = 100; camera.sceneRadius = 8;
    events.fire('funes.camera.reset');
    close(camera.focalPoint.x, 1); close(camera.azim, 7); close(camera.distance, 1);
});
