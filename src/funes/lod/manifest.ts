// Pure validation and merge helpers: the editor expands only the finest LOD into
// one editable model. The coarser copies must never become duplicate gaussians.
const LOD_MAX_SPLATS = 10_000_000;
type LodChunk = { filename: string; url: string; count?: number };
type LodPlan = { chunks: LodChunk[]; count: number; level: number; lodLevels: number; environment?: string };

const requireLod = (valid: unknown, message: string): void => {
    if (!valid) throw new Error(message);
};

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

const isLodFilename = (filename: string) => filename?.split(/[?#]/)[0].split('/').pop()?.toLowerCase() === 'lod-meta.json';

const resolveLodUrl = (filename: string, parentUrl: string): string => {
    requireLod(typeof filename === 'string' && filename.length > 0 && filename.length <= 180 &&
        filename.split('/').every(part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..'),
    `Invalid LOD relative path: ${filename}`);
    const parent = new URL(parentUrl);
    const resolved = new URL(filename, parent);
    requireLod(['https:', 'http:'].includes(parent.protocol) && !parent.username && !parent.password &&
        resolved.origin === parent.origin, 'LOD files must use relative HTTP(S) URLs on the same origin.');
    return resolved.href;
};

const createLodPlan = (manifest: any, entryUrl: string, level = 0): LodPlan => {
    requireLod(object(manifest) && manifest.version === 1 && integer(manifest.lodLevels) &&
        manifest.lodLevels > 0 && manifest.lodLevels <= 32 &&
        Array.isArray(manifest.counts) && manifest.counts.length === manifest.lodLevels &&
        manifest.counts.every(integer) && integer(manifest.count) &&
        manifest.count === manifest.counts.reduce((sum: number, count: number) => sum + count, 0),
    'Invalid Streamed SOG index or point counts.');
    requireLod(integer(level) && level < manifest.lodLevels && manifest.counts[level] > 0,
        'The requested LOD preview level is unavailable.');
    requireLod(manifest.counts[0] > 0 && manifest.counts[0] <= LOD_MAX_SPLATS,
        `LOD editing supports at most ${LOD_MAX_SPLATS.toLocaleString()} full-detail gaussians.`);
    requireLod(Array.isArray(manifest.filenames) && manifest.filenames.length > 0 && manifest.filenames.length <= 4096,
        'Missing LOD chunk filenames.');
    const urls = manifest.filenames.map((filename: string) => {
        requireLod(typeof filename === 'string' && filename.endsWith('/meta.json'), 'Expected an unbundled SOG chunk meta.json.');
        return resolveLodUrl(filename, entryUrl);
    });
    requireLod(new Set(urls).size === urls.length, 'Duplicate LOD chunk filenames.');
    const ranges = new Map<number, { start: number; end: number }[]>();
    const fileLevels = new Map<number, number>();
    const counts = Array(manifest.lodLevels).fill(0);
    const pending = [{ node: manifest.tree, depth: 0 }];
    let visited = 0;
    while (pending.length) {
        const { node, depth } = pending.pop();
        requireLod(++visited <= 1_000_000 && depth <= 128 && object(node), 'Invalid LOD spatial tree.');
        const hasChildren = node.children !== undefined;
        requireLod(hasChildren !== (node.lods !== undefined), 'LOD nodes must contain children or level references.');
        if (hasChildren) {
            requireLod(Array.isArray(node.children) && node.children.length === 2, 'Invalid LOD spatial children.');
            for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
        } else {
            requireLod(object(node.lods) && Object.hasOwn(node.lods, '0'), 'LOD spatial region is missing its full-detail level.');
            for (const [key, raw] of Object.entries(node.lods)) {
                const ref = raw as any;
                requireLod(/^(?:0|[1-9]\d*)$/.test(key) && Number(key) < manifest.lodLevels && object(ref) &&
                    integer(ref.file) && ref.file < urls.length && integer(ref.offset) && integer(ref.count) &&
                    Number.isSafeInteger(ref.offset + ref.count), 'Invalid LOD chunk reference or point range.');
                const previous = fileLevels.get(ref.file);
                requireLod(previous === undefined || previous === Number(key), 'A LOD chunk cannot mix detail levels.');
                fileLevels.set(ref.file, Number(key));
                counts[Number(key)] += ref.count;
                if (Number(key) === level && ref.count > 0) {
                    if (!ranges.has(ref.file)) ranges.set(ref.file, []);
                    ranges.get(ref.file).push({ start: ref.offset, end: ref.offset + ref.count });
                }
            }
        }
    }
    requireLod(counts.every((count, level) => count === manifest.counts[level]), 'LOD tree counts do not match the index.');
    const chunks = [...ranges.entries()].sort(([a], [b]) => a - b).map(([file, entries]) => {
        let count = 0;
        for (const range of entries.sort((a, b) => a.start - b.start)) {
            requireLod(range.start === count, 'LOD point ranges overlap or contain gaps.');
            count = range.end;
        }
        return { filename: manifest.filenames[file], url: urls[file], count };
    });
    if (manifest.environment !== undefined) {
        requireLod(typeof manifest.environment === 'string' && manifest.environment.endsWith('/meta.json'), 'Invalid LOD environment.');
        const url = resolveLodUrl(manifest.environment, entryUrl);
        requireLod(!urls.includes(url), 'LOD environment must not duplicate a scene chunk.');
        chunks.push({ filename: manifest.environment, url, count: undefined });
    }
    return { chunks, count: manifest.counts[level], level, lodLevels: manifest.lodLevels, environment: manifest.environment };
};

const validateLodChunk = (metadata: any, chunk: LodChunk) => {
    requireLod(object(metadata) && metadata.version === 2 && integer(metadata.count) && metadata.count > 0 &&
        metadata.count <= LOD_MAX_SPLATS, `Invalid SOG metadata: ${chunk.filename}`);
    requireLod(chunk.count === undefined || metadata.count === chunk.count,
        `LOD metadata count does not match its full-detail ranges: ${chunk.filename}`);
    const vector = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    requireLod(vector(metadata.means?.mins) && vector(metadata.means?.maxs), `Invalid SOG position bounds: ${chunk.filename}`);
    for (const name of ['scales', 'sh0', ...(metadata.shN ? ['shN'] : [])]) {
        const codebook = metadata[name]?.codebook;
        requireLod(Array.isArray(codebook) && codebook.length === 256 && codebook.every(Number.isFinite),
            `Invalid SOG ${name} codebook: ${chunk.filename}`);
    }
    const urls = new Map<string, string>();
    for (const [section, count] of Object.entries({ means: 2, scales: 1, quats: 1, sh0: 1, shN: 2 })) {
        const data = metadata[section];
        if (section === 'shN' && data === undefined) continue;
        requireLod(object(data) && Array.isArray(data.files) && data.files.length === count, `Invalid ${section} textures: ${chunk.filename}`);
        for (const filename of data.files) {
            const url = resolveLodUrl(filename, chunk.url);
            requireLod(filename.endsWith('.webp'), 'LOD data textures must be WebP files.');
            urls.set(filename, url);
        }
    }
    const bands = metadata.shN?.bands ?? 0;
    requireLod(integer(bands) && bands <= 3 && (!metadata.shN || bands > 0), `Invalid SOG SH bands: ${chunk.filename}`);
    requireLod(!metadata.shN || (integer(metadata.shN.count) && metadata.shN.count > 0 && metadata.shN.count <= 65_536),
        `Invalid SOG SH palette size: ${chunk.filename}`);
    return { count: metadata.count as number, bands: bands as number, urls };
};

export { LOD_MAX_SPLATS, createLodPlan, isLodFilename, resolveLodUrl, validateLodChunk };
export type { LodChunk };
