import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';
import { Entity, Mat4, Quat, Vec3 } from 'playcanvas';
import * as pc from 'playcanvas';
const api = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/funes/adapters/set-origin.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports: api, require: () => pc });
const close = (a, b) => assert.ok(a.distance(b) < 0.0001, `${a} != ${b}`);
function setup() {
  const entity = new Entity();
  entity.setLocalPosition(4, -7, 3);
  entity.setLocalRotation(new Quat().setFromEulerAngles(20, 40, -15));
  entity.setLocalScale(2, 3, 0.5);
  const palette = [new Mat4(), new Mat4().setTRS(new Vec3(2,1,4), new Quat().setFromEulerAngles(0,30,0), new Vec3(0.8,0.8,0.8))];
  const ids = [0,1,0,1];
  const splat = { entity, localFrameOrigin: new Vec3(1,2,3), localFrame: new Quat().setFromEulerAngles(0,20,0),
    instances: { count: ids.length, transformIndex: i => ids[i], setTransformIndex: (i,n) => { ids[i] = n; } },
    transformPalette: { alloc: () => { palette.push(new Mat4()); return palette.length-1; }, free: n => palette.splice(-n),
      getTransform: (i,m) => m.copy(palette[i]), setTransform: (i,m) => { palette[i] = m.clone(); } },
    move: p => entity.setLocalPosition(p), setLocalFrame(o,q) { this.localFrameOrigin.copy(o); this.localFrame.copy(q); },
    async updatePositions() {} };
  // Same entity * palette composition consumed by native export.
  const world = () => ids.map((index, i) => new Mat4().mul2(entity.getLocalTransform(), palette[index]).transformPoint(new Vec3(i, i+1, -i)));
  return { splat, ids, palette, world };
}
test('set origin rebases every point, preserving rotation, scale and exported world geometry; undo/redo restore state', async () => {
  const h = setup(); const before = h.world(); const position = h.splat.entity.getLocalPosition().clone();
  const rotation = h.splat.entity.getLocalRotation().clone(), scale = h.splat.entity.getLocalScale().clone();
  const op = new api.SetModelOriginOp(h.splat);
  await op.do();
  close(h.splat.entity.getLocalPosition(), Vec3.ZERO);
  close(h.splat.localFrameOrigin, Vec3.ZERO);
  assert.ok(h.splat.entity.getLocalRotation().equals(rotation));
  close(h.splat.entity.getLocalScale(), scale);
  h.world().forEach((p,i) => close(p,before[i]));
  await op.undo();
  close(h.splat.entity.getLocalPosition(), position);
  assert.deepEqual(h.ids, [0,1,0,1]); assert.equal(h.palette.length, 2);
  close(h.splat.localFrameOrigin, new Vec3(1,2,3));
  await op.do(); h.world().forEach((p,i) => close(p,before[i]));
});
test('a second origin operation does not accumulate translation', async () => {
  const h = setup(); const before = h.world();
  await new api.SetModelOriginOp(h.splat).do();
  await new api.SetModelOriginOp(h.splat).do();
  h.world().forEach((p,i) => close(p,before[i]));
});
test('invalid zero scale fails before altering transforms', async () => {
  const h = setup(); h.splat.entity.setLocalScale(0,1,1);
  await assert.rejects(new api.SetModelOriginOp(h.splat).do(), /scale/);
  assert.deepEqual(h.ids, [0,1,0,1]); assert.equal(h.palette.length, 2);
});
