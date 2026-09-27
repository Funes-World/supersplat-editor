import { Vec3 } from 'playcanvas';
import { compositionFov } from './overlay-projection';
import type { Scene } from '../../scene';

// Presentation only: these operations never touch a Splat transform or source.
export const captureFraming = (scene: Scene, safeFrameAspect?: number) => {
    const camera = scene.camera;
    if (camera.ortho) throw new Error('Switch to perspective before saving the initial view.');
    const p = camera.mainCamera.getPosition();
    const t = camera.focalPointTween?.value || camera.focalPoint;
    const dx = p.x - t.x, dy = p.y - t.y, dz = p.z - t.z;
    const distance = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(distance) || distance <= 0) throw new Error('The presentation camera is not ready.');
    return { ...(Number.isFinite(safeFrameAspect) && safeFrameAspect > 0 ? { safeFrameAspect } : {}), version: 1, position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], fov: 45,
        cameraYaw: Math.atan2(dx, dz) * 180 / Math.PI,
        cameraPitch: Math.asin(dy / distance) * 180 / Math.PI, cameraDistance: distance };
};

export const restoreFraming = (scene: Scene, value: any) => {
    if (value?.version !== 1 || ![value.position, value.target].every((v: any) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) return false;
    scene.camera.ortho = false;
    scene.camera.setPose(new Vec3(...value.position), new Vec3(...value.target), 0);
    return true;
};

// Constrain the real camera target, not just the on-screen marker. Run after
// native input and before camera matrices are calculated, avoiding a one-frame
// pan/fly jump. Model translation remains the native undoable Move tool.
export const lockFramingOrigin = (scene: Scene) => {
    const camera = scene.camera;
    const controller = camera.controller;
    const previousUpdate = controller.update;
    const center = () => {
        const current = camera.focalPointTween.value;
        const target = camera.focalPoint;
        if (current.x || current.y || current.z || target.x || target.y || target.z || camera.lookCameraPos) {
            camera.setFocalPoint(Vec3.ZERO, 0);
        }
    };
    controller.update = (dt: number) => { previousUpdate.call(controller, dt); center(); };
    center();
    return () => { controller.update = previousUpdate; };
};

export const attachFraming = (scene: Scene, restored?: any, referenceAspect?: number) => {
    document.body.classList.add('funes-framing');
    const unlockOrigin = lockFramingOrigin(scene);
    const panel = document.createElement('label');
    panel.className = 'funes-framing-control';
    panel.textContent = 'Framing size (%) ';
    const input = document.createElement('input');
    input.type = 'number'; input.min = '1'; input.max = '10000'; input.step = '1'; input.value = '100';
    input.setAttribute('aria-label', 'Framing size (%)');
    panel.appendChild(input);
    document.getElementById('canvas-container')?.appendChild(panel);
    let baseDistance: number;
    input.addEventListener('change', () => {
        const size = Number(input.value);
        if (!Number.isFinite(size) || size <= 0 || !baseDistance) return;
        scene.camera.setDistance(baseDistance * 100 / size / scene.camera.sceneRadius * scene.camera.fovFactor, 0);
    });
    let applied = false;
    const update = () => {
        const camera = scene.camera;
        // Match the existing viewer's vertical 45-degree lens. SuperSplat uses
        // horizontal FOV in wide windows, so convert without changing position.
        const container = document.getElementById('canvas-container');
        const width = container?.clientWidth || scene.targetSize.width;
        const height = container?.clientHeight || scene.targetSize.height;
        const aspect = width / height;
        if (!Number.isFinite(aspect) || aspect <= 0) return;
        const distance = camera.distance * camera.sceneRadius / camera.fovFactor;
        const fov = compositionFov(width, height, referenceAspect, camera.camera.horizontalFov);
        if (Math.abs(camera.fov - fov) > 1e-7) {
            camera.fov = fov;
            camera.setDistance(distance / camera.sceneRadius * camera.fovFactor, 0);
        }
        if (!applied) {
            // Older framing metadata may have a panned target. Editing now uses
            // world zero as its reference; keep the restored camera position.
            restoreFraming(scene, restored ? { ...restored, target: [0, 0, 0] } : restored);
            applied = true;
        }
        const currentDistance = camera.distance * camera.sceneRadius / camera.fovFactor;
        if (!baseDistance) baseDistance = currentDistance;
        // Wheel zoom and numeric framing share the same distance. Do not
        // overwrite a partially typed value while the user edits the input.
        if (document.activeElement !== input && currentDistance > 0) {
            input.value = String(Math.round(baseDistance / currentDistance * 1000) / 10);
        }
    };
    scene.events.on('prerender', update);
    window.addEventListener('pagehide', () => { scene.events.off('prerender', update); unlockOrigin(); panel.remove(); }, { once: true });
};
