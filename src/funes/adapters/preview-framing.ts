import type { Scene } from '../../scene';
import { restoreFraming } from './framing';
import { compositionFov } from './overlay-projection';

type PreviewFraming = { version: 1; position: number[]; target: number[]; fov: 45; safeFrameAspect?: number };

export const readPreviewFraming = (value: any): PreviewFraming => {
    if (value?.version !== 1 || value.fov !== 45 ||
        ![value.position, value.target].every(v => Array.isArray(v) && v.length === 3 &&
            v.every(n => Number.isFinite(n) && Math.abs(n) <= 1e9)) ||
        Math.hypot(...value.position.map((n: number, i: number) => n - value.target[i])) <= 1e-8 ||
        (value.safeFrameAspect !== undefined && (!Number.isFinite(value.safeFrameAspect) || value.safeFrameAspect <= 0))) {
        throw new Error('Invalid LOD preview initial view.');
    }
    return { version: 1, position: [...value.position], target: [...value.target], fov: 45,
        ...(value.safeFrameAspect !== undefined ? { safeFrameAspect: value.safeFrameAspect } : {}) };
};

// The preview reimports native exported geometry into the same editor world.
// Preserve that camera space and lens, without editor controls or an origin lock.
export const attachPreviewFraming = (scene: Scene, framing: PreviewFraming) => {
    let applied = false;
    const update = () => {
        const camera = scene.camera;
        const container = document.getElementById('canvas-container');
        const width = container?.clientWidth || scene.targetSize.width;
        const height = container?.clientHeight || scene.targetSize.height;
        if (!(width > 0 && height > 0 && Number.isFinite(width / height))) return;
        // Adding a Splat only dirties the lazy scene bound. Synchronize the
        // radius before setPose normalizes/clamps a large world distance.
        if (!applied) void scene.bound;
        const distance = camera.distance * camera.sceneRadius / camera.fovFactor;
        const fov = compositionFov(width, height, framing.safeFrameAspect, camera.camera.horizontalFov);
        if (Math.abs(camera.fov - fov) > 1e-7) {
            camera.fov = fov;
            camera.setDistance(distance / camera.sceneRadius * camera.fovFactor, 0);
        }
        if (!applied) {
            restoreFraming(scene, framing);
            applied = true;
        }
    };
    update();
    scene.events.on('prerender', update);
    return () => scene.events.off('prerender', update);
};
