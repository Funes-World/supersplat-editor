import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoader } from './load-ts.mjs';

test('browser scratch supports write/read/remove and aborts writers before deleting its private directory', async () => {
    const files = new Map();
    const calls = [];
    const directory = {
        async getFileHandle(name, options) {
            if (!files.has(name) && !options?.create) throw new Error('missing');
            return {
                async createWritable() {
                    const parts = [];
                    return {
                        async write(bytes) { parts.push(bytes.slice()); },
                        async close() { files.set(name, new Blob(parts)); },
                        async abort() { calls.push('abort'); }
                    };
                },
                async getFile() { return files.get(name); }
            };
        },
        async removeEntry(name) { files.delete(name); }
    };
    const root = {
        async getDirectoryHandle(name, options) { calls.push([name, options.create]); return directory; },
        async removeEntry(name, options) { calls.push(['remove', name, options.recursive]); files.clear(); }
    };
    const load = createLoader({ '../../io/read/file-systems': { BlobReadSource: class { constructor(blob) { this.blob = blob; } } } }, {
        navigator: { storage: { getDirectory: async () => root } }, crypto: { randomUUID: () => 'fixture' }
    });
    const scratch = await load('funes/lod/scratch.ts').createBrowserLodScratch();
    const writer = await scratch.writeFs.createWriter('scratch/plan.bin');
    await writer.write(Uint8Array.of(1, 2, 3));
    assert.equal(writer.bytesWritten, 3);
    await writer.close();
    const source = await scratch.readFs.createSource('scratch/plan.bin');
    assert.deepEqual(new Uint8Array(await source.blob.arrayBuffer()), Uint8Array.of(1, 2, 3));
    await scratch.remove('scratch/plan.bin');
    assert.equal(files.size, 0);
    await scratch.writeFs.createWriter('unfinished');
    await scratch.dispose();
    assert.equal(calls.at(-2), 'abort');
    assert.deepEqual(Array.from(calls.at(-1)), ['remove', 'funes-lod-fixture', true]);
});

test('unavailable private storage fails before generation with an actionable message', async () => {
    const load = createLoader({ '../../io/read/file-systems': {} }, { navigator: { storage: {} } });
    await assert.rejects(load('funes/lod/scratch.ts').createBrowserLodScratch(), /local temporary storage/);
});
