import { Events } from './events';
import { ExportType, SceneExportOptions } from './file-handler';
import { BufferWriter } from './serialize/writer';

const IS_SCENE_DIRTY = 'supersplat:is-scene-dirty';
const EXPORT_SCENE = 'supersplat:export';
const EXPORT_RESULT = 'supersplat:export:result';

interface IsSceneDirtyQuery {
    type: typeof IS_SCENE_DIRTY;
}

interface IsSceneDirtyResponse {
    type: typeof IS_SCENE_DIRTY;
    result: boolean;
}

type ExportSceneRequest = {
    type: typeof EXPORT_SCENE;
    requestId?: string;
    exportType?: ExportType | 'sog';
    filename?: string;
};

type ExportSceneResponse = {
    type: typeof EXPORT_RESULT;
    requestId?: string;
    ok: boolean;
    filename?: string;
    exportType?: ExportType | 'sog';
    error?: string;
    buffers?: ArrayBufferLike[];
};

const isSceneDirtyQuery = (data: any): data is IsSceneDirtyQuery => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === IS_SCENE_DIRTY
    );
};

const isExportSceneRequest = (data: any): data is ExportSceneRequest => {
    return data && typeof data === 'object' && data.type === EXPORT_SCENE;
};

const normalizeFilename = (filename: string, exportType: ExportType | 'sog') => {
    const targetExt = exportType === 'splat' || exportType === 'sog' ? '.sog' : '.ply';
    if (!filename) return `model${targetExt}`;
    const lower = filename.toLowerCase();
    if (lower.endsWith(targetExt)) return filename;
    return `${filename}${targetExt}`;
};

const buildDefaultExportOptions = (events: Events, request: ExportSceneRequest): SceneExportOptions => {
    const exportType = (request.exportType === 'splat' || request.exportType === 'sog') ? 'splat' : 'ply';
    const splats = (events.invoke('scene.splats') as any[]) ?? [];
    const firstName = splats[0]?.name || 'model';
    const filename = normalizeFilename(request.filename || firstName, request.exportType || exportType);
    const maxBands = events.invoke('view.bands') as number;

    return {
        filename,
        splatIdx: 'all',
        serializeSettings: {
            maxSHBands: maxBands
        },
        compressedPly: false
    };
};

const sendExportResult = (source: Window, origin: string, payload: ExportSceneResponse) => {
    const { buffers, ...rest } = payload;
    const transfer = Array.isArray(buffers)
        ? (buffers
            .map((b) => (b instanceof ArrayBuffer ? b : null))
            .filter(Boolean) as ArrayBuffer[])
        : [];
    try {
        console.log('[SupersplatIframe] postMessage to parent', { origin, transfer: transfer.length });
        source.postMessage({ ...rest, buffers }, origin, transfer as any);
    } catch (err) {
        console.error('[SupersplatIframe] postMessage failed', err);
    }
};

const registerIframeApi = (events: Events) => {
    window.addEventListener('message', (event: MessageEvent) => {
        const source = event.source as Window | null;
        if (!source) {
            return;
        }

        if (isSceneDirtyQuery(event.data)) {
            const response: IsSceneDirtyResponse = {
                type: IS_SCENE_DIRTY,
                result: events.invoke('scene.dirty') as boolean
            };
            source.postMessage(response, event.origin);
            return;
        }

        if (isExportSceneRequest(event.data)) {
            console.log('[SupersplatIframe] export request', event.data);
            const { requestId } = event.data;
            const exportType = (event.data.exportType === 'splat' || event.data.exportType === 'sog') ? 'splat' : 'ply';
            const options = buildDefaultExportOptions(events, event.data);
            const writer = new BufferWriter();

            (async () => {
                try {
                    const result = await events.invoke('scene.write', exportType, options, undefined, writer) as Uint8Array[];
                    const buffers = Array.isArray(result) ? result.map((b: Uint8Array) => b.buffer) : undefined;
                    console.log('[SupersplatIframe] export success', { requestId, exportType, filename: options.filename, buffers: buffers?.length });
                    sendExportResult(source, event.origin, {
                        type: EXPORT_RESULT,
                        requestId,
                        ok: true,
                        filename: options.filename,
                        exportType,
                        buffers
                    });
                } catch (err: any) {
                    console.error('[SupersplatIframe] export failed', err);
                    sendExportResult(source, event.origin, {
                        type: EXPORT_RESULT,
                        requestId,
                        ok: false,
                        filename: options.filename,
                        exportType,
                        error: err?.message || String(err)
                    });
                }
            })();
        }
    });
};

export { registerIframeApi };
