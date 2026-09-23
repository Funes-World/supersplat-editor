import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import JSZip from 'jszip';

const source = await readFile(new URL('../src/funes/lod/archive.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
let fetches = [];
let response;
vm.runInNewContext(compiled, {
    exports, JSZip, require: (name) => { assert.equal(name, 'jszip'); return JSZip; },
    URL, Blob, Uint8Array, ArrayBuffer, AbortController, Error, setTimeout, clearTimeout,
    window: { location: { href: 'https://editor.example/' } },
    fetch: async (url, options) => { fetches.push({ url: url.href, options }); return response; }
});
const { isLodArchiveFilename, openLodArchive } = exports;
const packageBytes = async (prefix = '') => new JSZip()
    .file(`${prefix}lod-meta.json`, JSON.stringify({ version: 1, lodLevels: 3 }))
    .file(`${prefix}0_0/meta.json`, JSON.stringify({ version: 2 }))
    .file(`${prefix}0_0/means_l.webp`, new Uint8Array([1, 2, 3]))
    .file('__MACOSX/._lod-meta.json', 'ignored')
    .generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
const local = bytes => ({ filename: 'archive.zip', contents: new Blob([bytes]) });
const signal = () => new AbortController().signal;

test('opens nested ZIP paths, resolves data locally and revokes temporary URLs', async () => {
    fetches = [];
    const archive = await openLodArchive({ ...local(await packageBytes('Scene with spaces/')), lodManifestPath: 'Scene with spaces/lod-meta.json' }, signal());
    const entry = archive.entryUrl;
    assert.equal((await archive.readJson(entry)).lodLevels, 3);
    const url = await archive.objectUrl(new URL('0_0/means_l.webp', entry).href);
    assert.deepEqual([...new Uint8Array(await (await fetch(url)).arrayBuffer())], [1, 2, 3]);
    archive.release([url]);
    await assert.rejects(fetch(url));
    const metadataUrl = await archive.objectUrl(entry);
    archive.dispose();
    await assert.rejects(fetch(metadataUrl));
    assert.equal(fetches.length, 0, 'archive resources must not trigger network requests');
});

test('downloads one ZIP instead of fetching JSON and WebP dependencies', async () => {
    fetches = [];
    response = new Response(await packageBytes(), { headers: { 'content-type': 'application/zip' } });
    const archive = await openLodArchive({ filename: 'archive.zip', url: 'https://cdn.example/archive.zip', lodManifestPath: 'lod-meta.json' }, signal());
    assert.equal((await archive.readJson(archive.entryUrl)).version, 1);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, 'https://cdn.example/archive.zip');
    assert.equal(fetches[0].options.redirect, 'error');
    archive.dispose();
});

test('rejects missing, ambiguous, mismatched or incomplete archive entries', async () => {
    const archive = await openLodArchive(local(await packageBytes()), signal());
    await assert.rejects(async () => archive.objectUrl(new URL('0_0/missing.webp', archive.entryUrl).href), /Missing LOD ZIP file/);
    archive.dispose();
    await assert.rejects(openLodArchive({ ...local(await packageBytes()), lodManifestPath: 'wrong/lod-meta.json' }, signal()), /does not match/);
    for (const names of [['file.txt'], ['a/lod-meta.json', 'b/lod-meta.json'], ['a/lod-meta.json', 'outside.txt']]) {
        const zip = new JSZip();
        for (const name of names) zip.file(name, '{}');
        await assert.rejects(openLodArchive(local(await zip.generateAsync({ type: 'uint8array' })), signal()), /exactly one|outside/);
    }
});

test('rejects sanitized traversal and symlink entries before extraction', async () => {
    for (const setup of [
        zip => zip.file('../lod-meta.json', '{}'),
        zip => zip.file('lod-meta.json', '{}').file('symlink', '/outside', { unixPermissions: 0o120777 })
    ]) {
        const zip = setup(new JSZip());
        const bytes = await zip.generateAsync({ type: 'uint8array', platform: 'UNIX' });
        await assert.rejects(openLodArchive(local(bytes), signal()), /unsafe/);
    }
});

test('bounds decompression and respects cancellation', async () => {
    const zip = new JSZip().file('lod-meta.json', ' '.repeat(16 * 1024 ** 2 + 1));
    const archive = await openLodArchive(local(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })), signal());
    await assert.rejects(archive.readJson(archive.entryUrl), /size limit/);
    archive.dispose();
    const controller = new AbortController();
    controller.abort(new Error('Editor closed'));
    await assert.rejects(openLodArchive(local(await packageBytes()), controller.signal), /Editor closed/);
});

test('recognizes ZIP paths without confusing SOG or loose manifest paths', () => {
    assert.equal(isLodArchiveFilename('https://cdn.example/archive.ZIP?download=1'), true);
    assert.equal(isLodArchiveFilename('model.sog'), false);
    assert.equal(isLodArchiveFilename('lod-meta.json'), false);
});

test('embedded ZIP load forwards its actual URL and internal manifest path', async () => {
    const bridgeSource = await readFile(new URL('../src/funes/query.ts', import.meta.url), 'utf8');
    const bridgeCode = ts.transpileModule(bridgeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const bridge = {};
    vm.runInNewContext(bridgeCode, { exports: bridge });
    const target = new URL('https://editor.example/');
    target.searchParams.set('load', 'https://cdn.example/archive.zip');
    target.searchParams.set('lodManifestPath', '模型 包/lod-meta.json');
    let imported;
    await bridge.loadFromQueryParams(target, { invoke: async (event, files) => { assert.equal(event, 'import'); imported = files[0]; } });
    assert.equal(imported.filename, 'archive.zip');
    assert.equal(imported.url, 'https://cdn.example/archive.zip');
    assert.equal(imported.lodManifestPath, '模型 包/lod-meta.json');
});
