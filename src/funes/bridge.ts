import type { Events } from '../events';
import type { LoadState } from './types';

const runtime = { runtimeKind: 'editor', runtimeVersion: '3.3.0', integrationVersion: 1, protocolVersion: 1, graphicsBackend: 'webgpu' };

const trustedParentOrigin = (url: URL, referrer: string): string | null => {
    const configured = url.searchParams.get('embedOrigin');
    try {
        const parsed = new URL(configured || referrer);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
        if (configured && parsed.origin !== configured) return null;
        return parsed.origin;
    } catch { return null; }
};

type BridgeAdapter = {
    framing?: () => any;
    generateLod?: (settings: any, onProgress: (message: string) => void) => Promise<{ parts: Uint8Array[]; counts: number[]; manifestPath: string }>;
    hasModel: () => boolean;
    export: (format: 'ply' | 'splat', filename: string, bands: number) => Promise<Uint8Array[]>;
};

const registerBridge = (events: Events, url: URL, adapter: BridgeAdapter) => {
    const preview = url.searchParams.get('lodPreview') === '1';
    const readOnly = preview || url.searchParams.get('mode') === 'viewer';
    const capabilities = { gaussianFraming: !readOnly && !!adapter.framing, gaussianEdit: !readOnly, fullShPlyExport: !readOnly, browserLodGeneration: !readOnly && !!adapter.generateLod,
        streamedSogEdit: !readOnly, lodPreview: preview, graphicsDiagnostics: false, webglFallback: false };
    const parentOrigin = trustedParentOrigin(url, document.referrer);
    let status: LoadState = { state: 'loading', preview };
    let subscriber: Window;
    let previewRequest = '';
    let exporting = false;
    let disposed = false;
    const send = (target: Window, payload: object, transfers: Transferable[] = []) => {
        if (!disposed && parentOrigin) target.postMessage(payload, parentOrigin, transfers);
    };
    const sendStatus = () => subscriber && send(subscriber, { type: 'supersplat:load:result', ...status, ...runtime, capabilities });
    const setStatus = (value: LoadState) => { status = value; sendStatus(); };
    const statusHandle = events.on('embed.load.status', setStatus);
    const listener = (event: MessageEvent) => {
        if (disposed || !parentOrigin || event.source !== window.parent || event.origin !== parentOrigin) return;
        const source = event.source as Window;
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'funes:hello') {
            if (data.protocolVersion !== 1 || typeof data.requestId !== 'string' || data.requestId.length > 128) return;
            send(source, { type: 'funes:hello:result', requestId: data.requestId, ...runtime, capabilities });
        } else if (data.type === 'supersplat:status') {
            subscriber = source;
            sendStatus();
        } else if (data.type === 'supersplat:is-scene-dirty') {
            send(source, { type: data.type, result: !readOnly && !!events.invoke('scene.dirty') });
        } else if (preview && ['supersplat:lod-preview:load', 'supersplat:lod-preview:level'].includes(data.type)) {
            if (typeof data.requestId !== 'string' || !data.requestId || data.requestId.length > 128) return;
            subscriber = source;
            const requestId = previewRequest = data.requestId;
            setStatus({ state: 'loading', preview: true, requestId, level: data.level });
            Promise.resolve().then(() => {
                if (data.type.endsWith(':load') && !(data.data instanceof ArrayBuffer)) throw new Error('The preview ZIP is invalid.');
                return events.invoke('lod.preview.load', { level: data.level, manifestPath: data.manifestPath,
                    ...(data.type.endsWith(':load') ? { data: data.data } : {}) });
            }).then(result => {
                if (requestId !== previewRequest || disposed) return;
                if (!result) throw new Error('The LOD preview is not ready.');
                setStatus({ state: 'ready', preview: true, requestId, ...result });
            }).catch(error => {
                if (requestId === previewRequest && !disposed) setStatus({ state: 'error', preview: true, requestId,
                    level: data.level, error: error?.message || String(error) });
            });
        } else if (preview && data.type === 'supersplat:lod-preview:cancel') {
            previewRequest = '';
            events.fire('lod.preview.cancel');
        } else if (data.type === 'supersplat:export') {
            const format = data.exportType === 'lod' ? 'lod' : data.exportType === 'splat' || data.exportType === 'sog' ? 'splat' : 'ply';
            const name = typeof data.filename === 'string' ? data.filename : 'model';
            const extension = format === 'lod' ? 'zip' : format;
            const filename = name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
            const bands = Number.isInteger(data.maxSHBands) && data.maxSHBands >= 0 && data.maxSHBands <= 3 ? data.maxSHBands : 3;
            const reply = { type: 'supersplat:export:result', requestId: data.requestId, filename, exportType: format };
            (async () => {
                let claimed = false;
                try {
                    if (readOnly) throw new Error('This preview is read-only and cannot be exported.');
                    if (status.state !== 'ready' || !adapter.hasModel()) throw new Error('The model has not finished loading.');
                    if (exporting) throw new Error('A model export is already in progress.');
                    exporting = claimed = true;
                    const framing = adapter.framing?.();
                    const generated = format === 'lod' ? await adapter.generateLod?.(data.settings, message =>
                        send(source, { type: 'supersplat:export:progress', requestId: data.requestId, message })) : null;
                    const parts = format === 'lod' ? generated?.parts : await adapter.export(format, filename, bands);
                    if (!Array.isArray(parts) || !parts.length || parts.some(p => !(p instanceof Uint8Array)) || !parts.some(p => p.byteLength)) {
                        throw new Error('The editor returned an empty or invalid model.');
                    }
                    const buffers = parts.map(p => p.byteOffset === 0 && p.byteLength === p.buffer.byteLength && p.buffer instanceof ArrayBuffer ?
                        p.buffer : p.slice().buffer);
                    send(source, { ...reply, ok: true, buffers, ...(framing ? { framing } : {}), ...(generated ? { counts: generated.counts, manifestPath: generated.manifestPath } : {}) }, buffers);
                } catch (error) {
                    send(source, { ...reply, ok: false, error: error?.message || String(error) });
                } finally { if (claimed) exporting = false; }
            })();
        }
    };
    window.addEventListener('message', listener);
    const dispose = () => { disposed = true; previewRequest = ''; statusHandle.off(); window.removeEventListener('message', listener); };
    window.addEventListener('pagehide', dispose, { once: true });
    return { setStatus, dispose, capabilities };
};

export { registerBridge, trustedParentOrigin };
