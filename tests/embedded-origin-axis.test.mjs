import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { EventHandler, Quat, Vec3 } from 'playcanvas';
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/funes/ui/editor-ui.ts', import.meta.url),'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText, {exports, require: name => name==='playcanvas'?{Quat,Vec3}:name.includes('pcui')?{Button:class {dom={};on(){}}}:name.includes('origin-marker')?{OriginMarker:class {}}:{}, document:{body:{classList:{add(){}}},getElementById:()=>null},window:{addEventListener(){}}});
function setup() {
 const events=new EventHandler();const pivot=new Vec3(9,8,7);
 events.invoke=()=>({entity:{getLocalPosition:()=>Vec3.ZERO},hasLocalFrame:false,setLocalFrame:(o)=>pivot.copy(o)});
 const scene={camera:{ortho:false,distance:8.35},forceRender:false};
 // Native handler executes first, before the CMS integration handler.
 events.on('camera.align',axis=>{scene.camera.axis=axis;scene.camera.ortho=true;});
 exports.attachEditorUi(events,scene,{canvasContainer:{dom:{}}},false);
 return {events,scene,pivot};
}
test('all six axis views retain perspective and distance',()=>{
 const h=setup();for(const axis of ['px','nx','py','ny','pz','nz']) {
 h.events.fire('camera.align',axis);assert.equal(h.scene.camera.axis,axis);
 assert.equal(h.scene.camera.ortho,false);assert.equal(h.scene.camera.distance,8.35);
 }
});
test('Set Origin refreshes a displaced pivot even when geometry is already at zero',()=>{
 const h=setup();h.events.fire('splat.setOrigin');assert.ok(h.pivot.equals(Vec3.ZERO));
});
