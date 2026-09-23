import JSZip, { type JSZipObject, type JSZipStreamHelper } from 'jszip';

import type { ImportTarget as AssetSource } from '../types';

// JSZip implements internalStream publicly but omits it from JSZipObject's typings.
type StreamingZipFile = JSZipObject & {
    internalStream(type: 'uint8array'): JSZipStreamHelper<Uint8Array<ArrayBuffer>>;
};

const MAX_BYTES = 2 * 1024 ** 3;
const MAX_JSON_BYTES = 16 * 1024 ** 2;
// Logical URLs are keys only. No network request may use this origin.
const ARCHIVE_BASE = 'https://lod-archive.invalid/';
const isLodArchiveFilename = (name: string) => /\.zip(?:[?#]|$)/i.test(name ?? '');
const safePath = (name: string) => typeof name === 'string' && name.length > 0 && name.length <= 4096 &&
    !/[\\\x00-\x1f\x7f:%?#]/.test(name) && !name.startsWith('/') &&
    name.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
const ignored = (name: string) => name.split('/').some(part => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'));

const readArchiveBytes = async (source: AssetSource, signal: AbortSignal): Promise<ArrayBuffer> => {
    signal.throwIfAborted();
    if (source.contents) {
        if (!source.contents.size || source.contents.size > MAX_BYTES) throw new Error('LOD ZIP exceeds the 2 GiB limit.');
        return source.contents.arrayBuffer();
    }
    const url = new URL(source.url, window.location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid LOD ZIP URL.');
    const response = await fetch(url, { signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Unable to download LOD ZIP (${response.status}).`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The LOD ZIP response is empty.');
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('LOD ZIP exceeds the 2 GiB limit.');
        while (true) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw new Error('LOD ZIP exceeds the 2 GiB limit.');
            parts.push(value);
        }
        if (!size) throw new Error('The LOD ZIP response is empty.');
        return await new Blob(parts).arrayBuffer();
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
};

/** Resolve archive resources locally; keep blobs alive only while the engine needs them. */
const openLodArchive = async (source: AssetSource, signal: AbortSignal) => {
    const zip = await JSZip.loadAsync(await readArchiveBytes(source, signal));
    signal.throwIfAborted();
    const entries = Object.values(zip.files);
    if (entries.length > 16384 || entries.filter(file => !file.dir).length > 4096) throw new Error('LOD ZIP contains too many files.');
    const files = new Map<string, JSZipObject>();
    for (const file of entries) {
        const name = file.dir ? file.name.replace(/\/$/, '') : file.name;
        const original = (file as JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName;
        const mode = typeof file.unixPermissions === 'string' ? parseInt(file.unixPermissions, 8) : file.unixPermissions ?? 0;
        if (!safePath(name) || (original && original !== file.name) ||
            ![0, 0x4000, 0x8000].includes(mode & 0xf000)) throw new Error('LOD ZIP contains unsafe paths or special files.');
        if (!file.dir && !ignored(name)) files.set(new URL(name, ARCHIVE_BASE).href, file);
    }
    const manifests = [...files.keys()].filter(name => name.endsWith('/lod-meta.json'));
    if (manifests.length !== 1) throw new Error('LOD ZIP must contain exactly one lod-meta.json.');
    const entryUrl = manifests[0];
    if (source.lodManifestPath && (!safePath(source.lodManifestPath) ||
        new URL(source.lodManifestPath, ARCHIVE_BASE).href !== entryUrl)) throw new Error('LOD ZIP entry does not match the saved model.');
    const root = entryUrl.slice(0, -'lod-meta.json'.length);
    if ([...files.keys()].some(name => !name.startsWith(root))) throw new Error('LOD ZIP contains files outside its scene.');
    const objectUrls = new Set<string>();
    const extractedBytes = new Map<string, number>();
    let expandedBytes = 0;
    let jsonBytes = 0;
    const jsonBlobs = new Map<string, Promise<Blob>>();
    const extractBlob = (url: string): Promise<Blob> => {
        signal.throwIfAborted();
        const file = files.get(url);
        if (!file) throw new Error(`Missing LOD ZIP file: ${new URL(url).pathname}`);
        const isJson = file.name.endsWith('.json');
        const parts: Uint8Array<ArrayBuffer>[] = [];
        let fileBytes = 0;
        return new Promise((resolve, reject) => {
            const stream = (file as StreamingZipFile).internalStream('uint8array');
            let settled = false;
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                stream.pause();
                signal.removeEventListener('abort', abort);
                parts.length = 0;
                reject(error);
            };
            const abort = () => fail(signal.reason ?? new Error('LOD ZIP loading was cancelled.'));
            signal.addEventListener('abort', abort, { once: true });
            stream.on('data', (data: Uint8Array<ArrayBuffer>) => {
                if (settled) return;
                fileBytes += data.byteLength;
                const additionalBytes = Math.max(0, fileBytes - (extractedBytes.get(url) ?? 0));
                extractedBytes.set(url, Math.max(fileBytes, extractedBytes.get(url) ?? 0));
                expandedBytes += additionalBytes;
                if (isJson) jsonBytes += additionalBytes;
                if (expandedBytes > MAX_BYTES || jsonBytes > MAX_JSON_BYTES) {
                    fail(new Error('Expanded LOD ZIP exceeds the size limit.'));
                } else parts.push(data);
            }).on('error', fail).on('end', () => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                resolve(new Blob(parts, { type: isJson ? 'application/json' : 'image/webp' }));
            }).resume();
            if (signal.aborted) abort();
        });
    };
    const readBlob = (url: string) => {
        if (!url.endsWith('.json')) return extractBlob(url);
        if (!jsonBlobs.has(url)) jsonBlobs.set(url, extractBlob(url));
        return jsonBlobs.get(url);
    };
    return {
        entryUrl,
        readBlob,
        readJson: async (url: string) => JSON.parse(await (await readBlob(url)).text()),
        objectUrl: async (url: string) => {
            const blob = await readBlob(url);
            signal.throwIfAborted();
            const value = URL.createObjectURL(blob);
            objectUrls.add(value);
            return value;
        },
        release: (urls: Iterable<string>) => {
            for (const url of urls) if (objectUrls.delete(url)) URL.revokeObjectURL(url);
        },
        dispose: () => {
            for (const url of objectUrls) URL.revokeObjectURL(url);
            objectUrls.clear();
            files.clear();
            jsonBlobs.clear();
            extractedBytes.clear();
        }
    };
};

export { isLodArchiveFilename, openLodArchive };
