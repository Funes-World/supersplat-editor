import { createChunkDataPool, decimateSourceAdaptive, MemoryFileSystem, MemoryReadFileSystem,
    readFile, stackLods, writeLodSource, writeSource, ZipFileSystem } from '@playcanvas/splat-transform';
import type { ChunkSource, DecimateAdaptiveSpill } from '@playcanvas/splat-transform';

type Settings = { percentages: number[]; chunkCount: number; chunkExtent: number; chunkMin: number };

export function validateBrowserLodSettings(settings: Settings): Settings {
    const { percentages, chunkCount, chunkExtent, chunkMin } = settings ?? {};
    if (!Array.isArray(percentages) || percentages.length < 1 || percentages.length > 32 || percentages[0] !== 100 ||
        percentages.some((p, i) => !Number.isFinite(p) || p <= 0 || p > 100 || (i > 0 && p > percentages[i - 1])) ||
        !Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 16384 ||
        !Number.isFinite(chunkExtent) || chunkExtent <= 0 || chunkExtent > 100000 ||
        !Number.isSafeInteger(chunkMin) || chunkMin < 1 || chunkMin > chunkCount) {
        throw new Error('Invalid LOD generation settings.');
    }
    return { percentages: [...percentages], chunkCount, chunkExtent, chunkMin };
}

/** Sources come directly from the locked editor scene. Only final SOG payloads are quantized. */
export async function generateBrowserLod({ createSource, createDevice, settings, createScratch, onProgress = () => {} }: {
    createSource: () => Promise<ChunkSource>;
    createDevice: Parameters<typeof writeLodSource>[0]['createDevice'];
    settings: Settings;
    createScratch?: () => Promise<DecimateAdaptiveSpill & { dispose: () => Promise<void> }>;
    onProgress?: (message: string) => void;
}) {
    const config = validateBrowserLodSettings(settings);
    const sources: ChunkSource[] = [];
    let scratch: (DecimateAdaptiveSpill & { dispose: () => Promise<void> }) | undefined;
    try {
        scratch = await createScratch?.();
        onProgress('Reading the edited model…');
        sources.push(await createSource());
        const count = sources[0].meta.numGaussians;
        if (!count || count > 10000000) throw new Error('LOD generation supports 1–10,000,000 points.');
        const counts = config.percentages.map(p => Math.max(1, Math.round(count * p / 100)));
        for (let level = 1; level < counts.length; level++) {
            onProgress(`Generating LOD${level} of ${counts.length - 1} on this computer…`);
            // Each level starts from the full edited source, not the previous reduced level.
            let source = await createSource();
            const pool = createChunkDataPool({ chunkSize: source.meta.chunkSize, maxPooledBytes: 128 * 1024 * 1024 });
            try {
                source = await decimateSourceAdaptive(source, pool, {
                    targetCount: counts[level], createDevice, spill: scratch, memoryBudgetBytes: 1024 * 1024 * 1024
                });
                // Decimation is stream-once; materialize lossless float PLY locally for the spatial writer's gathers.
                const fs = new MemoryFileSystem();
                await writeSource({ filename: 'level.ply', outputFormat: 'ply', source, pool, options: {} }, fs);
                const readFs = new MemoryReadFileSystem();
                readFs.set('level.ply', fs.results.get('level.ply')!);
                const [materialized] = await readFile({ filename: 'level.ply', inputFormat: 'ply', fileSystem: readFs });
                const chunkSize = sources[0].meta.chunkSize;
                sources.push({
                    meta: { ...materialized.meta, chunkSize,
                        numChunks: materialized.meta.lodCounts.map(n => Math.ceil(n / chunkSize)) },
                    read: request => {
                        if ('indices' in request) return materialized.read(request);
                        const { chunkIndex, ...target } = request;
                        const start = chunkIndex * chunkSize;
                        const count = Math.min(chunkSize, materialized.meta.numGaussians - start);
                        return materialized.read({ ...target, indices: Uint32Array.from({ length: count }, (_, i) => start + i), indexOffset: 0, count });
                    },
                    close: () => materialized.close()
                });
            } finally {
                await source.close();
                pool.destroy();
            }
        }
        onProgress('Encoding the final LOD files on this computer…');
        const fs = new MemoryFileSystem();
        const zip = new ZipFileSystem(await fs.createWriter('lod.zip'));
        // The upstream spatial writer resolves chunk filenames to absolute paths.
        // Give it a virtual root and serialize only paths inside that root.
        const root = '/funes-lod/';
        const packageFs = {
            mkdir: async () => {},
            createWriter: (filename: string) => {
                if (!filename.startsWith(root)) throw new Error('Generated LOD resource escaped its package root.');
                const relative = filename.slice(root.length);
                if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f:%?#]/.test(relative))
                    throw new Error('Generated LOD resource has an invalid path.');
                return zip.createWriter(relative);
            }
        };
        await writeLodSource({ filename: `${root}lod-meta.json`, mainSource: stackLods(sources), envSource: null,
            iterations: 10, createDevice, chunkCount: config.chunkCount, chunkExtent: config.chunkExtent,
            chunkMin: config.chunkMin }, packageFs);
        await zip.close();
        const bytes = fs.results.get('lod.zip');
        if (!bytes?.byteLength || bytes.byteLength > 2 * 1024 * 1024 * 1024) throw new Error('The generated LOD package is empty or exceeds 2 GiB.');
        return { parts: [bytes], counts, manifestPath: 'lod-meta.json' };
    } finally {
        try { await Promise.all(sources.map(source => source.close())); }
        finally { await scratch?.dispose(); }
    }
}
