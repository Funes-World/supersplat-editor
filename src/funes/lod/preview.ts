import type { Events } from '../../events';
import type { Scene } from '../../scene';
import type { Splat } from '../../splat';
import { attachPreviewFraming, readPreviewFraming } from '../adapters/preview-framing';

type LodPreviewRequest = { data?: ArrayBuffer; level: number; manifestPath?: string; framing?: unknown };
const cancelled = () => new DOMException('LOD preview loading was cancelled.', 'AbortError');

// An isolated viewer scene. The archive stays local; only the requested real LOD is decoded.
const registerLodPreview = (events: Events, scene: Scene, load: (request: import('../types').ImportTarget) => Promise<Splat>) => {
    let archive: File | undefined;
    let manifestPath: string | undefined;
    let controller: AbortController | undefined;
    let loading: Promise<unknown> = Promise.resolve();
    let displayed = false;
    let framing: ReturnType<typeof readPreviewFraming> | undefined;
    let detachFraming: (() => void) | undefined;
    let disposed = false;

    events.function('lod.preview.load', (request: LodPreviewRequest) => {
        if (disposed) return Promise.reject(cancelled());
        if (!Number.isInteger(request.level) || request.level < 0 || request.level > 31) {
            return Promise.reject(new Error('Choose an available LOD preview level.'));
        }
        if (request.data !== undefined) {
            if (!(request.data instanceof ArrayBuffer) || !request.data.byteLength || request.data.byteLength > 2 * 1024 ** 3) {
                return Promise.reject(new Error('The preview ZIP is empty or exceeds 2 GiB.'));
            }
            try { framing = request.framing === undefined ? undefined : readPreviewFraming(request.framing); }
            catch (error) { return Promise.reject(error); }
            archive = new File([request.data], 'preview.zip', { type: 'application/zip' });
            manifestPath = request.manifestPath;
            displayed = false;
        }
        if (!archive) return Promise.reject(new Error('Load the preview ZIP before choosing a level.'));
        controller?.abort(cancelled());
        const active = new AbortController();
        controller = active;
        const contents = archive;
        const entry = manifestPath;
        const initialFraming = framing;
        // Serialize cancelled GPU decoding cleanup before starting another level.
        const previous = loading.catch(() => {});
        const operation = async () => {
            await previous;
            active.signal.throwIfAborted();
            let model: Splat | undefined;
            events.fire('startSpinner');
            try {
                model = await load({ filename: 'preview.zip',
                    contents,
                    lodManifestPath: entry,
                    lodPreviewLevel: request.level,
                    signal: active.signal,
                    animationFrame: true });
                active.signal.throwIfAborted();
                const previousModels = scene.getElementsByType(model.type).slice();
                await scene.add(model);
                active.signal.throwIfAborted();
                previousModels.forEach(previous => previous.destroy());
                // A level change must preserve the user's comparison viewpoint.
                if (!displayed) {
                    detachFraming?.();
                    detachFraming = initialFraming ? attachPreviewFraming(scene, initialFraming) : undefined;
                    if (!initialFraming) scene.camera.focus({ focalPoint: model.worldBound.center, radius: model.worldBound.halfExtents.length(), speed: 0 });
                }
                displayed = true;
                return { level: request.level,
                    pointCount: model.numSplats,
                    lodLevels: (model.asset.data as { lodLevels: number }).lodLevels };
            } catch (error) {
                if (model) {
                    scene.remove(model);
                    model.destroy();
                }
                throw error;
            } finally {
                events.fire('stopSpinner');
            }
        };
        loading = operation();
        return loading;
    });

    const dispose = () => {
        disposed = true;
        controller?.abort(cancelled());
        archive = undefined;
        detachFraming?.();
        scene.clear();
    };
    events.on('lod.preview.cancel', () => controller?.abort(cancelled()));
    window.addEventListener('pagehide', dispose, { once: true });
    return dispose;
};

export { registerLodPreview };
