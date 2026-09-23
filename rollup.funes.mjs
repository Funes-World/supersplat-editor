import commonjs from '@rollup/plugin-commonjs';
import alias from '@rollup/plugin-alias';
import path from 'node:path';
import upstream from './rollup.config.mjs';

// Keep the upstream build untouched; JSZip is the host's bounded ZIP reader.
upstream.plugins.unshift(
    alias({ entries: { jszip: path.resolve('node_modules/jszip/dist/jszip.min.js') } }),
    commonjs()
);
export default upstream;
