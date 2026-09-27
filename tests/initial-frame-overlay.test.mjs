import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import * as pc from 'playcanvas';
const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const projection = {};
vm.runInNewContext(await compile('../src/funes/adapters/overlay-projection.ts'), { exports: projection, require: () => pc });
const exports = {};
vm.runInNewContext(await compile('../src/funes/ui/initial-frame-overlay.ts'), {
  exports, require: name => name === 'playcanvas' ? pc : projection,
  document: { body: { classList: { contains: () => true } } }
});
const element = () => ({ style: {}, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }, getComputedTextLength: () => 100 });
test('composition frame stays fixed during camera changes and only responds to viewport resize', () => {
  const overlay = Object.create(exports.InitialFrameOverlay.prototype);
  Object.assign(overlay, { container: { clientWidth: 1000, clientHeight: 800 }, safeFrameAspect: 2,
    path: element(), svg: element(), label: element(),
    scene: { get camera() { throw new Error('Screen-space framing must not depend on camera pose'); } } });
  overlay.update();
  assert.equal(overlay.path.attrs.d, 'M 100,200 h 800 v 400 h -800 Z');
  for (let i = 0; i < 5; i++) overlay.update();
  assert.equal(overlay.path.attrs.d, 'M 100,200 h 800 v 400 h -800 Z');
  overlay.container.clientWidth = 800;
  overlay.update();
  assert.equal(overlay.path.attrs.d, 'M 80,240 h 640 v 320 h -640 Z');
});

test('narrow, wide and high-DPI viewports preserve the saved 45-degree composition', () => {
  for (const [width, height] of [[320,700], [800,600], [1920,900], [3840,1800]]) {
    const aspect = 16/9;
    const frame = projection.fitCompositionFrame(width, height, aspect);
    assert.ok(frame.x >= width * 0.099 && frame.y >= height * 0.099);
    assert.ok(frame.x + frame.width < width && frame.y + frame.height < height);
    assert.ok(Math.abs(frame.width/frame.height - aspect) < 1e-10);
    for (const horizontal of [true, false]) {
      const fov = projection.compositionFov(width, height, aspect, horizontal);
      const verticalTangent = Math.tan(fov * Math.PI/360) / (horizontal ? width/height : 1);
      // A fixed world-space point has the same relative Y inside the frame
      // as it does in the saved viewer, regardless of available editor width.
      assert.ok(Math.abs(verticalTangent * frame.height/height - Math.tan(Math.PI/8)) < 1e-10);
    }
  }
});
