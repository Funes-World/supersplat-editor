import {
    type ChunkSource, type ReadRequest, type SHBands, type LayerLayout,
    createChunkDataPool, concatSource
} from '@playcanvas/splat-transform';

const coefficients = [0, 3, 8, 15];

// SOG chunks can carry different SH bands. Keep the original coefficients in
// each colour channel and fill only absent coefficients with zero.
const promoteColor = (input: Float32Array, output: Float32Array, count: number, from: number, to: number) => {
    const a = coefficients[from];
    const b = coefficients[to];
    output.fill(0);
    for (let row = 0; row < count; row++) {
        const src = row * (3 + 3 * a);
        const dst = row * (3 + 3 * b);
        output.set(input.subarray(src, src + 3), dst);
        for (let channel = 0; channel < 3; channel++) {
            output.set(input.subarray(src + 3 + channel * a, src + 3 + (channel + 1) * a), dst + 3 + channel * b);
        }
    }
};

const colorLayout = (bands: number): LayerLayout => ({
    stride: (3 + 3 * coefficients[bands]) * 4,
    fields: {
        dc: { byteOffset: 0, components: 3, type: 'float32' },
        ...(bands ? { shRest: { byteOffset: 12, components: 3 * coefficients[bands], type: 'float32' as const } } : {})
    }
});

type Segment = { count: number; open: () => Promise<ChunkSource> };

// The native concatSource owns addressing and gather reads. This adapter only
// normalizes mixed SH layouts and bounds its cache to two decoded SOG chunks.
const concatenateLod = async (segments: Segment[], bands: SHBands, signal: AbortSignal): Promise<ChunkSource> => {
    const cache = new Map<number, ChunkSource>();
    let closed = false;
    let pool: ReturnType<typeof createChunkDataPool>;
    const get = async (index: number) => {
        signal.throwIfAborted();
        if (closed) throw new Error('The LOD source has been closed.');
        let source = cache.get(index);
        if (!source) {
            source = await segments[index].open();
            if (closed || signal.aborted) {
                await source.close();
                signal.throwIfAborted();
                throw new Error('The LOD source has been closed.');
            }
            if (source.meta.numGaussians !== segments[index].count || source.meta.shBands > bands) {
                await source.close();
                throw new Error('Decoded LOD data does not match its metadata.');
            }
            cache.set(index, source);
            if (cache.size > 2) {
                const oldest = cache.keys().next().value;
                const expired = cache.get(oldest);
                cache.delete(oldest);
                await expired.close();
            }
        }
        return source;
    };
    const close = async () => {
        if (closed) return;
        closed = true;
        await Promise.all([...cache.values()].map(source => source.close()));
        cache.clear();
        pool?.destroy();
    };
    try {
        const first = await get(0);
        const base = first.meta;
        pool = createChunkDataPool({ chunkSize: base.chunkSize });
        const proxies = segments.map((segment, index): ChunkSource => ({
            meta: { ...base, shBands: bands, numGaussians: segment.count, numLods: 1,
                lodCounts: [segment.count], numChunks: [Math.ceil(segment.count / base.chunkSize)],
                layouts: { ...base.layouts, color: colorLayout(bands) } },
            read: async (request: ReadRequest) => {
                const source = await get(index);
                if (!request.color || source.meta.shBands === bands) {
                    await source.read(request);
                } else {
                    const color = pool.acquire('color', source.meta.layouts.color, request.color.count);
                    try {
                        await source.read({ ...request, color });
                        promoteColor(new Float32Array(color.data), new Float32Array(request.color.data),
                            request.color.count, source.meta.shBands, bands);
                    } finally {
                        color.release();
                    }
                }
                signal.throwIfAborted();
            },
            close: async () => {}
        }));
        const combined = concatSource(proxies, pool);
        return { meta: combined.meta, read: request => combined.read(request), close };
    } catch (error) {
        await close();
        throw error;
    }
};

export { concatenateLod, promoteColor };
