import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/funes/lod/manifest.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const {
    createLodPlan,
    isLodFilename, resolveLodUrl, validateLodChunk
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const entry = 'https://assets.example.test/package/lod-meta.json';
const leaf = (offset, count, coarseOffset = offset) => ({
    lods: { 0: { file: 1, offset, count }, 1: { file: 0, offset: coarseOffset, count: 1 } }
});
const manifest = () => ({
    version: 1, count: 6, counts: [4, 2], lodLevels: 2,
    filenames: ['arbitrary-coarse/meta.json', 'highest-detail/meta.json'],
    tree: { children: [leaf(0, 2, 0), leaf(2, 2, 1)] }
});
const metadata = (count = 4) => ({
    version: 2, count,
    means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: ['means_l.webp', 'means_u.webp'] },
    scales: { files: ['scales.webp'], codebook: Array(256).fill(0) },
    quats: { files: ['quats.webp'] },
    sh0: { files: ['sh0.webp'], codebook: Array(256).fill(0) }
});
test('detects the exact LOD entry independently of query strings', () => {
    assert.equal(isLodFilename(`${entry}?token=x`), true);
    assert.equal(isLodFilename('some-meta.json'), false);
});

test('selects full-detail files by tree references and deduplicates shared chunks', () => {
    const plan = createLodPlan(manifest(), entry);
    assert.equal(plan.count, 4);
    assert.deepEqual(plan.chunks, [{ filename: 'highest-detail/meta.json', url: 'https://assets.example.test/package/highest-detail/meta.json', count: 4 }]);
});

test('preview selects the actual requested LOD chunks across all leaves instead of thinning LOD0', () => {
    const plan = createLodPlan(manifest(), entry, 1);
    assert.equal(plan.level, 1);
    assert.equal(plan.lodLevels, 2);
    assert.equal(plan.count, 2);
    assert.deepEqual(plan.chunks, [{ filename: 'arbitrary-coarse/meta.json', url: 'https://assets.example.test/package/arbitrary-coarse/meta.json', count: 2 }]);
    assert.equal(validateLodChunk(metadata(2), plan.chunks[0]).count, 2);
    for (const level of [-1, 0.5, 2, NaN]) assert.throws(() => createLodPlan(manifest(), entry, level), /unavailable/);
    const invalid = manifest();
    invalid.tree.children[1].lods[1].offset = 0;
    assert.throws(() => createLodPlan(invalid, entry, 1), /overlap|gaps/);
    // The editor's normal import still selects the untouched complete LOD0.
    assert.equal(createLodPlan(manifest(), entry).count, 4);
});

test('adds an environment only once without mixing in coarser copies', () => {
    const data = { ...manifest(), environment: 'environment/meta.json' };
    const plan = createLodPlan(data, entry);
    assert.equal(plan.chunks.length, 2);
    assert.equal(plan.environment, 'environment/meta.json');
    assert.equal(plan.chunks[1].count, undefined);
    data.environment = data.filenames[1];
    assert.throws(() => createLodPlan(data, entry), /duplicate/);
});

test('rejects missing finest levels, malformed refs, mixed levels and count mismatches', () => {
    const cases = [
        data => delete data.tree.children[0].lods[0],
        data => { data.tree.children[0].lods[0].file = 42; },
        data => { data.tree.children[0].lods[0].offset = Infinity; },
        data => { data.tree.children[0].lods[0].count = -1; },
        data => { data.tree.children[0].lods[1].file = 1; },
        data => { data.counts[0] = 5; data.count = 7; },
        data => { data.counts = [20_000_001, 2]; data.count = 20_000_003; }
    ];
    for (const mutate of cases) {
        const data = manifest();
        mutate(data);
        assert.throws(() => createLodPlan(data, entry));
    }
});

test('rejects overlapping or incomplete full-detail ranges', () => {
    for (const offset of [1, 3]) {
        const data = manifest();
        data.tree.children[1].lods[0].offset = offset;
        assert.throws(() => createLodPlan(data, entry), /overlap|gaps/);
    }
});

test('references cannot escape the package directory or change origins', () => {
    for (const name of ['../other/meta.json', '/other/meta.json', 'https://evil.test/meta.json', '//evil.test/meta.json', 'a/%2e%2e/meta.json', 'a\\meta.json']) {
        assert.throws(() => resolveLodUrl(name, entry), /Invalid/);
    }
    assert.equal(resolveLodUrl('a/means_l.webp', entry), 'https://assets.example.test/package/a/means_l.webp');
});

test('metadata counts must equal indexed ranges before any textures load', () => {
    const chunk = createLodPlan(manifest(), entry).chunks[0];
    const result = validateLodChunk(metadata(), chunk);
    assert.equal(result.count, 4);
    assert.equal(result.urls.size, 5);
    assert.throws(() => validateLodChunk(metadata(3), chunk), /metadata count/);
    const malformed = metadata();
    malformed.means.files[0] = '../means_l.webp';
    assert.throws(() => validateLodChunk(malformed, chunk), /Invalid/);
});

test('rejects malformed SOG metadata that would fail in GPU decoding', () => {
    const chunk = createLodPlan(manifest(), entry).chunks[0];
    const data = metadata();
    data.scales.codebook[5] = NaN;
    assert.throws(() => validateLodChunk(data, chunk), /codebook/);
});

