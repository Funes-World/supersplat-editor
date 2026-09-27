import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as pc from 'playcanvas';
import ts from 'typescript';
const source = await readFile(new URL('../src/funes/adapters/framing.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports, require: () => pc });
const { captureFraming, restoreFraming } = exports;
test('save/open cycles preserve physical pose and never access model transforms', () => {
  let position = new pc.Vec3(4, 6, 8);
  let target = new pc.Vec3(1, 2, 3);
  const camera = { ortho: false, mainCamera: { getPosition: () => position },
    get focalPoint() { return target; },
    setPose(p, t) { position = p; target = t; } };
  const scene = { camera, get models() { throw new Error('Framing must not touch geometry'); } };
  const first = captureFraming(scene);
  for (let i = 0; i < 4; i++) {
    assert.equal(restoreFraming(scene, JSON.parse(JSON.stringify(first))), true);
    assert.deepEqual(captureFraming(scene), first);
  }
  assert.equal(first.cameraDistance, Math.sqrt(50));
});
test('orthographic export fails explicitly rather than saving an incompatible perspective', () => {
  assert.throws(() => captureFraming({ camera: { ortho: true } }), /perspective/);
  assert.equal(restoreFraming({ camera: {} }, { version: 2 }), false);
});
test('wheel distance updates the percentage without overwriting focused input', () => {
  const handlers = {};
  const input = { value: '', setAttribute() {}, addEventListener() {} };
  const panel = { appendChild() {} };
  const container = { clientWidth: 800, clientHeight: 600, appendChild() {} };
  const document = { activeElement: null, body: { classList: { add() {} } },
    createElement: tag => tag === 'input' ? input : panel, getElementById: () => container };
  const camera = { distance: 10, sceneRadius: 1, fovFactor: 1, fov: 45, camera: { horizontalFov: false },
    controller: { update() {} }, focalPointTween: { value: { x: 0, y: 0, z: 0 } }, focalPoint: { x: 0, y: 0, z: 0 } };
  const api = {};
  vm.runInNewContext(compiled, { exports: api, document, window: { addEventListener() {} },
    require: name => name === 'playcanvas' ? pc : { compositionFov: () => 45 } });
  api.attachFraming({ camera, targetSize: { width: 800, height: 600 }, events: { on: (event, fn) => { handlers[event] = fn; } } });
  handlers.prerender();
  assert.equal(input.value, '100');
  camera.distance = 5;
  handlers.prerender();
  assert.equal(input.value, '200');
  document.activeElement = input;
  input.value = '2'; camera.distance = 20;
  handlers.prerender();
  assert.equal(input.value, '2');
  document.activeElement = null;
  handlers.prerender();
  assert.equal(input.value, '50');
});

test('world origin stays the real orbit target after pan/fly input without touching model geometry', () => {
  let modelPosition = new pc.Vec3(3, 4, 5);
  const camera = { focalPointTween: { value: { x: 4, y: 2, z: 1 } }, focalPoint: new pc.Vec3(4,2,1),
    lookCameraPos: null,
    setFocalPoint(p) { this.focalPoint.copy(p); this.focalPointTween.value = { x:p.x, y:p.y, z:p.z }; this.lookCameraPos = null; },
    controller: { update() { camera.focalPoint.set(10,20,30); camera.lookCameraPos = new pc.Vec3(1,2,3); } } };
  const originalUpdate = camera.controller.update;
  const unlock = exports.lockFramingOrigin({ camera, get models() { throw new Error('Do not change model geometry'); } });
  assert.equal(camera.focalPoint.length(), 0);
  for (let i=0;i<5;i++) {
    modelPosition.addScalar(1); // Native Move operations must remain independent.
    camera.controller.update(0.016);
    assert.equal(camera.focalPoint.length(), 0);
    assert.equal(camera.focalPointTween.value.x, 0);
    assert.equal(camera.lookCameraPos, null);
  }
  assert.equal(modelPosition.x, 8);
  unlock(); assert.equal(camera.controller.update, originalUpdate);
});
