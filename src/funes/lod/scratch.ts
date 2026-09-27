import { BlobReadSource } from '../../io/read/file-systems';
import type { DecimateAdaptiveSpill } from '@playcanvas/splat-transform';

/** Private browser storage: no directory picker, uploads, or installed software. */
export async function createBrowserLodScratch(): Promise<DecimateAdaptiveSpill & { dispose: () => Promise<void> }> {
    if (!navigator.storage?.getDirectory) throw new Error('This browser does not support local temporary storage. Use a current desktop Chrome or Edge browser.');
    const root = await navigator.storage.getDirectory();
    const name = `funes-lod-${crypto.randomUUID()}`;
    const directory = await root.getDirectoryHandle(name, { create: true });
    const writers = new Set<FileSystemWritableFileStream>();
    const key = (filename: string) => encodeURIComponent(filename);
    return {
        scratchDir: 'scratch',
        writeFs: {
            mkdir: async () => {},
            createWriter: async (filename) => {
                const handle = await directory.getFileHandle(key(filename), { create: true });
                const stream = await handle.createWritable();
                writers.add(stream);
                let bytesWritten = 0;
                return {
                    get bytesWritten() { return bytesWritten; },
                    write: async (data) => { await stream.write(data as Uint8Array<ArrayBuffer>); bytesWritten += data.byteLength; },
                    close: async () => { await stream.close(); writers.delete(stream); },
                    abort: async () => { await stream.abort(); writers.delete(stream); }
                };
            }
        },
        readFs: {
            createSource: async (filename) => {
                const handle = await directory.getFileHandle(key(filename));
                return new BlobReadSource(await handle.getFile());
            }
        },
        remove: async (filename) => { await directory.removeEntry(key(filename)); },
        dispose: async () => {
            await Promise.allSettled([...writers].map(writer => writer.abort()));
            writers.clear();
            await root.removeEntry(name, { recursive: true });
        }
    };
}
