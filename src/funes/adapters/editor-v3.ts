// All version-specific editor imports and resource ownership live in this adapter.
import { MemoryFileSystem } from '@playcanvas/splat-transform';

import { EditorSplatResource } from '../../editor-splat-resource';
import { ElementType } from '../../element';
import { MappedReadFileSystem, loadSplatSource } from '../../io';
import type { Scene } from '../../scene';
import { Splat } from '../../splat';
import { createExportSource, createGpuDevice, writeSplatFile } from '../../splat-serialize';
import { createBrowserLodScratch } from '../lod/scratch';
import { generateBrowserLod } from '../lod/generate';
import { isLodArchiveFilename } from '../lod/archive';
import { isLodFilename } from '../lod/manifest';
import { openLodSource } from '../lod/source';
import type { ImportTarget } from '../types';

const splatsInScene = (scene: Scene) => scene.getElementsByType(ElementType.splat) as Splat[];

const loadModel = async (scene: Scene, target: ImportTarget): Promise<Splat> => {
    const controller = new AbortController();
    const abort = () => controller.abort(target.signal?.reason ?? new DOMException('Model loading was cancelled.', 'AbortError'));
    target.signal?.addEventListener('abort', abort, { once: true });
    window.addEventListener('pagehide', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Model loading timed out. Please try again.')), 600_000);
    let source;
    let resource: EditorSplatResource;
    let model: Splat;
    try {
        if (target.signal?.aborted) abort();
        controller.signal.throwIfAborted();
        const lod = isLodArchiveFilename(target.filename) || isLodFilename(target.filename);
        let lodMetadata = {};
        if (lod) {
            const loaded = await openLodSource(target, controller.signal);
            source = loaded.source;
            lodMetadata = { format: 'streamed-sog', lodEnvironment: !!loaded.plan.environment,
                lodLevel: loaded.plan.level, lodLevels: loaded.plan.lodLevels, pointCount: loaded.pointCount };
        } else {
            const fs = new MappedReadFileSystem(target.url ? new URL('.', target.url).href : undefined);
            if (target.contents) fs.addFile(target.filename, target.contents, target.handle);
            const filename = target.contents || target.filename === 'meta.json' ? target.filename : target.url;
            const loaded = await loadSplatSource(filename, fs, false, async () => 0);
            if (!loaded) throw new Error('The model was not loaded.');
            source = loaded.source;
        }
        controller.signal.throwIfAborted();
        resource = await EditorSplatResource.create(scene.app.graphicsDevice, source);
        controller.signal.throwIfAborted();
        const asset = scene.assetLoader.createGSplatAsset(resource, target.filename);
        asset.data = lodMetadata;
        model = new Splat(asset, source.meta.transform.rotation);
        return model;
    } catch (error) {
        if (model) model.destroy();
        else if (resource) resource.destroy();
        else await source?.close();
        throw error;
    } finally {
        clearTimeout(timer);
        target.signal?.removeEventListener('abort', abort);
        window.removeEventListener('pagehide', abort);
    }
};

const exportModel = async (scene: Scene, format: 'ply' | 'splat', filename: string, maxSHBands = 3): Promise<Uint8Array[]> => {
    // The same queue orders GPU edits, undo/redo and export. Never race an edit
    // that has updated the UI but has not completed its GPU readback yet.
    return scene.commandQueue.enqueue(async () => {
        const splats = splatsInScene(scene);
        if (!splats.length) throw new Error('The model has not finished loading.');
        const fs = new MemoryFileSystem();
        await writeSplatFile(splats, { maxSHBands }, format, filename, {}, fs);
        const bytes = fs.results.get(filename);
        if (!bytes?.byteLength) throw new Error('The editor returned an empty model.');
        return [bytes];
    });
};

export { exportModel, loadModel, splatsInScene };

export const generateLodModel = (scene: Scene, settings: any, onProgress: (message: string) => void) =>
    scene.commandQueue.enqueue(() => generateBrowserLod({ settings, onProgress, createDevice: createGpuDevice, createScratch: createBrowserLodScratch,
        createSource: async () => {
            const built = await createExportSource(splatsInScene(scene), { maxSHBands: 3 });
            if (!built) throw new Error('The edited model is empty.');
            built.pool.destroy();
            return built.source;
        }
    }));
