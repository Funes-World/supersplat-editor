import './ui/styles.scss';
import i18next from 'i18next';
import type { Events } from '../events';
import type { Scene } from '../scene';
import type { EditorUI } from '../ui/editor';
import { exportModel, loadModel, splatsInScene } from './adapters/editor-v3';
import { registerBridge } from './bridge';
import { isLodArchiveFilename } from './lod/archive';
import { isLodFilename } from './lod/manifest';
import { registerLodPreview } from './lod/preview';
import { collectImportTargets } from './query';
import type { ImportTarget } from './types';
import { attachEditorUi } from './ui/editor-ui';

let startupFailure: (error: unknown) => void;

const createFunesIntegration = (events: Events, url: URL) => {
    const preview = url.searchParams.get('lodPreview') === '1';
    const readOnly = preview || url.searchParams.get('mode') === 'viewer';
    let scene: Scene;
    const bridge = registerBridge(events, url, {
        hasModel: () => !!scene && splatsInScene(scene).length > 0,
        export: (format, filename, bands) => exportModel(scene, format, filename, bands)
    });
    startupFailure = error => bridge.setStatus({ state: 'error', preview,
        error: !navigator.gpu ? 'SuperSplat 3.3 requires WebGPU. Use a supported browser and enable hardware acceleration.' :
            (error instanceof Error ? error.message : 'The editor could not start.') });
    const importTarget = async (target: ImportTarget) => {
        const model = await loadModel(scene, target);
        try { await scene.add(model); return model; } catch (error) { model.destroy(); throw error; }
    };
    return {
        preview,
        readOnly,
        localize: () => i18next.changeLanguage(url.searchParams.get('lng') || 'en'),
        defaults: { controls: { initialAzim: 0, initialElev: 0 } },
        attach: (value: Scene, ui: EditorUI) => {
            scene = value;
            attachEditorUi(events, scene, ui, readOnly, Number(url.searchParams.get('safeFrameAspect')));
            if (preview) registerLodPreview(events, scene, target => loadModel(scene, target));
            if (!readOnly) events.function('funes.import', async (files: ImportTarget[]) => {
                if (!files.some(file => isLodArchiveFilename(file.filename) || isLodFilename(file.filename))) return null;
                if (files.length !== 1) throw new Error('Open one LOD ZIP or uploaded LOD index at a time.');
                return [await importTarget(files[0])];
            });
        },
        load: async () => {
            try {
                if (!preview) for (const target of collectImportTargets(url)) await importTarget(target);
                const models = splatsInScene(scene);
                if (!preview && collectImportTargets(url).length && !models.length) throw new Error('The model is empty.');
                if (models.length) {
                    const bounds = scene.bound;
                    scene.camera.focus({ focalPoint: bounds.center, radius: bounds.halfExtents.length(), speed: 0 });
                }
                bridge.setStatus({ state: 'ready', preview,
                    lodEnvironment: models.some(model => !!(model.asset.data as { lodEnvironment?: boolean }).lodEnvironment) });
            } catch (error) {
                bridge.setStatus({ state: 'error', preview, error: error?.message || String(error) });
                throw error;
            }
        }
    };
};

const reportStartupError = (error: unknown) => startupFailure?.(error);
export { createFunesIntegration, reportStartupError };
