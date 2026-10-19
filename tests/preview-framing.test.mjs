import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoader, pc } from './load-ts.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const framing = { version: 1, position: [5, 8, 13], target: [2, -3, 4], fov: 45, safeFrameAspect: 16 / 9 };

function setup() {
    const handlers = new Map();
    const container = { clientWidth: 800, clientHeight: 600 };
    const load = createLoader({}, { document: { getElementById: () => container,
        createElement() { throw new Error('A read-only preview must not add editor controls'); } } });
    const camera = { position: new pc.Vec3(), target: new pc.Vec3(), ortho: true,
        fov: 60, distance: 2, sceneRadius: 3, camera: { horizontalFov: true }, poses: 0,
        get fovFactor() { return Math.sin(this.fov * Math.PI / 360); },
        setDistance(value) { this.distance = value; },
        setPose(position, target) { this.poses++; this.position.copy(position); this.target.copy(target);
            this.setDistance(position.distance(target) / this.sceneRadius * this.fovFactor); } };
    const scene = { camera, targetSize: { width: 1600, height: 1200 },
        events: { on: (name, fn) => handlers.set(name, fn), off: name => handlers.delete(name) },
        get models() { throw new Error('Presentation must not touch geometry'); } };
    const api = load('funes/adapters/preview-framing.ts');
    return { ...api, camera, container, scene, handlers,
        resize(width, height, horizontal) {
            container.clientWidth = width; container.clientHeight = height;
            camera.camera.horizontalFov = horizontal;
            handlers.get('prerender')();
        } };
}

test('preview lens matches the inset saved composition without moving its physical pose on resize', () => {
    const s = setup();
    const dispose = s.attachPreviewFraming(s.scene, s.readPreviewFraming(framing));
    const distance = new pc.Vec3(...framing.position).distance(new pc.Vec3(...framing.target));
    assert.equal(s.camera.ortho, false);
    for (const [width, height, horizontal] of [[320, 700, false], [1920, 900, true], [3840, 1800, true], [800, 600, false]]) {
        s.resize(width, height, horizontal);
        const fittedHeight = Math.min(height * 0.8, width * 0.8 / framing.safeFrameAspect);
        const verticalTangent = Math.tan(s.camera.fov * Math.PI / 360) / (horizontal ? width / height : 1);
        close(verticalTangent * fittedHeight / height, Math.tan(Math.PI / 8));
        close(s.camera.distance * s.camera.sceneRadius / s.camera.fovFactor, distance);
        assert.ok(s.camera.position.equals(new pc.Vec3(...framing.position)));
        assert.ok(s.camera.target.equals(new pc.Vec3(...framing.target)));
        assert.equal(s.camera.poses, 1);
    }
    dispose();
    assert.equal(s.handlers.has('prerender'), false);
});

test('resizing after user orbit, pan and zoom preserves the newly chosen comparison pose', () => {
    const s = setup();
    const dispose = s.attachPreviewFraming(s.scene, s.readPreviewFraming(framing));
    const position = new pc.Vec3(10, -8, 6), target = new pc.Vec3(-2, 4, 1);
    s.camera.setPose(position, target);
    s.resize(400, 800, false);
    close(s.camera.distance * s.camera.sceneRadius / s.camera.fovFactor, position.distance(target));
    assert.ok(s.camera.position.equals(position));
    assert.ok(s.camera.target.equals(target));
    assert.equal(s.camera.poses, 2);
    dispose();
});

test('lazy scene bounds update the native camera radius before a large physical pose is restored', () => {
    const s = setup();
    s.camera.sceneRadius = 1;
    s.camera.setDistance = function (value) { this.distance = Math.max(1e-6, Math.min(10, value)); };
    Object.defineProperty(s.scene, 'bound', { get() {
        // Scene.bound emits scene.boundChanged; Camera.onBoundChanged updates
        // this radius only when the lazy bound is read after scene.add().
        const previousDistance = s.camera.distance * s.camera.sceneRadius;
        s.camera.sceneRadius = 100;
        s.camera.setDistance(previousDistance / s.camera.sceneRadius);
        return {};
    } });
    const snapshot = s.readPreviewFraming({ ...framing, position: [0, 0, 150], target: [0, 0, 0] });
    const dispose = s.attachPreviewFraming(s.scene, snapshot);
    close(s.camera.distance * s.camera.sceneRadius / s.camera.fovFactor, 150);
    dispose();
});

test('snapshot validation rejects malformed explicit views and owns a copy of the accepted pose', () => {
    const s = setup();
    for (const value of [null, {}, { ...framing, version: 2 }, { ...framing, fov: 60 },
        { ...framing, position: [0, 0] }, { ...framing, position: [NaN, 0, 0] },
        { ...framing, position: [1e10, 0, 0] }, { ...framing, target: framing.position },
        ...[0, -1, Infinity, '2'].map(safeFrameAspect => ({ ...framing, safeFrameAspect }))]) {
        assert.throws(() => s.readPreviewFraming(value), /preview.*view/i);
    }
    const original = { ...framing, position: [...framing.position], target: [...framing.target] };
    const snapshot = s.readPreviewFraming(original);
    original.position[0] = 100; original.target[1] = 100;
    assert.equal(snapshot.position[0], framing.position[0]);
    assert.equal(snapshot.target[1], framing.target[1]);
});
