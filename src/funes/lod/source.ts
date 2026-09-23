import type { ChunkSource, ReadFileSystem, SHBands } from '@playcanvas/splat-transform';

import { BlobReadSource, loadSplatSource } from '../../io';
import { concatenateLod } from '../adapters/chunk-source';
import type { ImportTarget } from '../types';
import { isLodArchiveFilename, openLodArchive } from './archive';
import { createLodPlan, LOD_MAX_SPLATS, validateLodChunk } from './manifest';

const boundedBlob = async (url: string, signal: AbortSignal, limit: number): Promise<Blob> => {
    const response = await fetch(url, { signal, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`Unable to load LOD data (${response.status}).`);
    const reader = response.body.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    try {
        if (Number(response.headers.get('content-length')) > limit) throw new Error('LOD data exceeds its size limit.');
        while (true) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) throw new Error('LOD data exceeds its size limit.');
            parts.push(value);
        }
        return new Blob(parts);
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
};

const openLodSource = async (target: ImportTarget, signal: AbortSignal) => {
    let archive: Awaited<ReturnType<typeof openLodArchive>>;
    let source: ChunkSource;
    try {
        if (isLodArchiveFilename(target.filename || target.url)) archive = await openLodArchive(target, signal);
        if (!archive && (!target.url || target.contents)) throw new Error('Open the uploaded LOD URL or a LOD ZIP.');
        const entryUrl = archive?.entryUrl ?? new URL(target.url, window.location.href).href;
        const json = async (url: string) => archive ? archive.readJson(url) :
            JSON.parse(await (await boundedBlob(url, signal, 16 * 1024 ** 2)).text());
        const plan = createLodPlan(await json(entryUrl), entryUrl, target.lodPreviewLevel ?? 0);
        const allowed = new Set<string>();
        const metadata = new Map<string, Blob>();
        const segments = [];
        let total = 0;
        let bands = 0;
        const fileSystem: ReadFileSystem = {
            createSource: async (filename) => {
                signal.throwIfAborted();
                const url = new URL(filename, entryUrl).href;
                if (!allowed.has(url)) throw new Error('The LOD reader requested an unlisted file.');
                const blob = metadata.get(url) ?? (archive ? await archive.readBlob(url) : await boundedBlob(url, signal, 512 * 1024 ** 2));
                signal.throwIfAborted();
                return new BlobReadSource(blob);
            }
        };
        for (const chunk of plan.chunks) {
            signal.throwIfAborted();
            const data = await json(chunk.url);
            const info = validateLodChunk(data, chunk);
            total += info.count;
            bands = Math.max(bands, info.bands);
            if (total > LOD_MAX_SPLATS) throw new Error('The LOD scene including its environment exceeds the editing limit.');
            metadata.set(chunk.url, new Blob([JSON.stringify(data)]));
            allowed.add(chunk.url);
            info.urls.forEach(url => allowed.add(url));
            segments.push({ count: info.count, open: async () => {
                const loaded = await loadSplatSource(chunk.filename, fileSystem, true);
                return loaded.source;
            } });
        }
        source = await concatenateLod(segments, bands as SHBands, signal);
        let closed = false;
        const owned: ChunkSource = {
            meta: source.meta,
            read: request => source.read(request),
            close: async () => {
                if (closed) return;
                closed = true;
                try { await source.close(); } finally { archive?.dispose(); metadata.clear(); }
            }
        };
        return { source: owned, plan, pointCount: total };
    } catch (error) {
        await source?.close();
        archive?.dispose();
        throw error;
    }
};

export { boundedBlob, openLodSource };
