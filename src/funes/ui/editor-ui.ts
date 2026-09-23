import { Button } from '@playcanvas/pcui';
import { Mat4, Quat, Vec3 } from 'playcanvas';

import { SetLocalFrameOp } from '../../edit-ops';
import type { Events } from '../../events';
import type { Scene } from '../../scene';
import type { Splat } from '../../splat';
import type { EditorUI } from '../../ui/editor';
import { splatsInScene } from '../adapters/editor-v3';
import { InitialFrameOverlay } from './initial-frame-overlay';
import { OriginMarker } from './origin-marker';

const attachEditorUi = (events: Events, scene: Scene, ui: EditorUI, readOnly: boolean, safeFrameAspect?: number) => {
    document.body.classList.add(readOnly ? 'funes-viewer' : 'funes-editor');
    const applyMode = () => {
        events.fire('grid.setVisible', !readOnly);
        events.fire('camera.setBound', false);
        events.fire('view.setEditView', false);
        events.fire('view.setSelectionColor', false);
        events.fire('view.setOutlineSelection', false);
        // Embedded editing keeps blended Gaussians while moving. Upstream's
        // automatic stochastic mode adds sampling noise on expensive frames.
        events.fire('view.setStochastic', 'disabled');
    };
    applyMode();
    events.on('preferences.resume', applyMode);
    if (readOnly) return;
    const marker = new OriginMarker(scene, ui.canvasContainer.dom);
    let frame: InitialFrameOverlay;
    let initial: { focal: Vec3; azim: number; elev: number; distance: number; radius: number };
    events.on('postrender', () => {
        if (initial || !splatsInScene(scene).length) return;
        initial = { focal: scene.camera.focalPoint.clone(), azim: scene.camera.azim,
            elev: scene.camera.elevation, distance: scene.camera.distance, radius: scene.camera.sceneRadius };
        frame = new InitialFrameOverlay(scene, ui.canvasContainer.dom, safeFrameAspect);
    });
    events.on('scene.clear', () => { initial = undefined; frame?.destroy(); frame = undefined; });
    const resetView = () => {
        if (!initial) return;
        scene.camera.setFocalPoint(initial.focal, 0);
        scene.camera.setAzimElev(initial.azim, initial.elev, 0);
        scene.camera.setDistance(initial.distance * initial.radius / scene.camera.sceneRadius, 0);
        scene.forceRender = true;
    };
    events.on('funes.camera.reset', resetView);
    events.on('camera.reset', resetView);
    events.on('splat.setOrigin', () => {
        const splat = events.invoke('selection') as Splat;
        if (!splat) return;
        // v3 has a native local frame. Moving its origin to world zero keeps
        // geometry unchanged, supports undo, and avoids rewriting GPU arrays.
        const origin = new Mat4().copy(splat.entity.getLocalTransform()).invert().transformPoint(Vec3.ZERO);
        events.fire('edit.add', new SetLocalFrameOp({ splat,
            oldOrigin: splat.localFrameOrigin.clone(), oldFrame: splat.localFrame.clone(),
            newOrigin: origin, newFrame: new Quat() }));
    });
    const buttons: Button[] = [];
    const toolbar = document.getElementById('bottom-toolbar');
    for (const [label, event] of [['Set origin', 'splat.setOrigin'], ['Reset view', 'funes.camera.reset']]) {
        const button = new Button({ text: label, class: 'funes-toolbar-button' });
        button.on('click', () => events.fire(event));
        toolbar?.appendChild(button.dom);
        buttons.push(button);
    }
    window.addEventListener('pagehide', () => { marker.destroy(); frame?.destroy(); buttons.forEach(button => button.destroy()); }, { once: true });
};

export { attachEditorUi };
