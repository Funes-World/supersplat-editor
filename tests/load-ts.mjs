import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as pc from 'playcanvas';
import * as st from '@playcanvas/splat-transform';
import * as viewerSettings from '@playcanvas/splat-transform/viewer-settings';
import JSZip from 'jszip';
import ts from 'typescript';

export { pc, st };
export const createLoader = (overrides = {}, globals = {}) => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const modules = new Map();
    const load = (file) => {
        const filename = path.resolve(root, file);
        if (modules.has(filename)) return modules.get(filename).exports;
        const module = { exports: {} };
        modules.set(filename, module);
        const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        vm.runInNewContext(output, { module, exports: module.exports, console, URL, Blob, File,
            TextEncoder, TextDecoder, Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array,
            Int32Array, ArrayBuffer, DataView, AbortController, DOMException, setTimeout, clearTimeout,
            ...globals,
            require(name) {
                if (Object.hasOwn(overrides, name)) return overrides[name];
                if (name === 'playcanvas') return pc;
                if (name === '@playcanvas/splat-transform') return st;
                if (name === '@playcanvas/splat-transform/viewer-settings') return viewerSettings;
                if (name === 'jszip') return JSZip;
                if (name.endsWith('/localization')) return { i18n: { t: key => key, bindText() {} } };
                const resolved = path.resolve(path.dirname(filename), name);
                if (name.endsWith('.json')) return JSON.parse(readFileSync(resolved, 'utf8'));
                if (resolved === path.join(root, 'io')) return load('io/read/loader.ts');
                return load(`${resolved}.ts`);
            }
        }, { filename });
        return module.exports;
    };
    return load;
};
