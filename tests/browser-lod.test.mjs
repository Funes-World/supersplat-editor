import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { createLoader, st } from './load-ts.mjs';

const { generateBrowserLod, validateBrowserLodSettings } = createLoader()('funes/lod/generate.ts');
const settings = { percentages: [100, 50, 25], chunkCount: 384, chunkExtent: 16, chunkMin: 8 };
test('browser LOD validates settings before reading the source', async () => {
    for (const percentages of [[], [50], [100, 101], [100, 0]]) {
        assert.throws(() => validateBrowserLodSettings({ ...settings, percentages }), /Invalid/);
    }
    await assert.rejects(generateBrowserLod({ settings: { ...settings, chunkMin: 999 }, createSource: () => {
        assert.fail('invalid settings cannot read model data');
    } }), /Invalid/);
});

test('real local pipeline creates three SH3 levels from independent edited sources', async () => {
    const n = 64;
    let opens = 0;
    const createSource = async () => {
        opens++;
        const columns = { x: Array.from({ length: n }, (_, i) => i % 4 * 0.1),
            y: Array.from({ length: n }, (_, i) => (i >> 2) % 4 * 0.1),
            z: Array.from({ length: n }, (_, i) => (i >> 4) * 0.1) };
        for (const [name, value] of Object.entries({ rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
            scale_0: -3, scale_1: -3, scale_2: -3, opacity: 3, f_dc_0: .2, f_dc_1: .1, f_dc_2: .3 })) columns[name] = Array(n).fill(value);
        for (let j = 0; j < 45; j++) columns[`f_rest_${j}`] = Array.from({ length: n }, (_, i) => .01 * Math.sin(i + j));
        return st.dataTableToChunkSource(new st.DataTable(Object.entries(columns).map(([name, values]) =>
            new st.Column(name, Float32Array.from(values))), st.Transform.PLY), 16);
    };
    const result = await generateBrowserLod({ createSource, settings });
    assert.equal(opens, 3);
    assert.deepEqual(Array.from(result.counts), [64, 32, 16]);
    const zip = await JSZip.loadAsync(result.parts[0]);
    for (const [name, file] of Object.entries(zip.files)) {
        assert.ok(!name.startsWith('/'), `absolute ZIP path: ${name}`);
        assert.equal(file.unsafeOriginalName, name);
        assert.ok(name.split('/').every(part => part && part !== '.' && part !== '..'));
    }
    const meta = JSON.parse(await zip.file('lod-meta.json').async('string'));
    assert.equal(meta.lodLevels, 3);
    const chunks = Object.keys(zip.files).filter(name => name.endsWith('/meta.json'));
    assert.ok(chunks.length >= 3);
    for (const name of chunks) {
        const chunk = JSON.parse(await zip.file(name).async('string'));
        assert.equal(chunk.shN.bands, 3);
    }
});
