import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkUpstream, sha256 } from '../scripts/check-funes-upstream.mjs';

test('the checked-in release has only the declared upstream source seams', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const manifest = JSON.parse(readFileSync(path.join(root, 'funes-upstream.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.seams).sort(), ['src/file-handler.ts', 'src/main.ts', 'src/splat-serialize.ts']);
    assert.equal(manifest.dependencies.playcanvas, '2.22.1');
    assert.equal(manifest.dependencies['@playcanvas/splat-transform'], '3.4.2');
    assert.ok(checkUpstream(root, manifest) > 200);
});

test('compatibility guard checks declared, locked and actually installed engine versions', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'funes-dependency-test-'));
    try {
        mkdirSync(path.join(root, 'src'));
        mkdirSync(path.join(root, 'node_modules/playcanvas'), { recursive: true });
        const manifest = { version: '3.3.0', protocolVersion: 1, commit: 'a'.repeat(40),
            dependencies: { playcanvas: '2.22.1' }, upstreamFiles: {}, seams: {} };
        const pkg = { version: '3.3.0', devDependencies: { playcanvas: '2.22.1' } };
        writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
        writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/playcanvas': { version: '2.22.1' } } }));
        writeFileSync(path.join(root, 'node_modules/playcanvas/package.json'), '{"version":"2.22.1"}');
        assert.equal(checkUpstream(root, manifest), 0);
        pkg.devDependencies.playcanvas = '^2.22.1';
        writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
        assert.throws(() => checkUpstream(root, manifest), /Dependency drift/);
        pkg.devDependencies.playcanvas = '2.22.1';
        writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
        writeFileSync(path.join(root, 'node_modules/playcanvas/package.json'), '{"version":"2.23.0"}');
        assert.throws(() => checkUpstream(root, manifest), /Installed dependency drift/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('compatibility guard detects upstream drift, missing files and custom code outside the extension', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'funes-seam-test-'));
    try {
        mkdirSync(path.join(root, 'src'));
        writeFileSync(path.join(root, 'package.json'), '{"version":"3.3.0"}');
        writeFileSync(path.join(root, 'src/main.ts'), 'hook');
        const manifest = { version: '3.3.0', protocolVersion: 1, commit: 'a'.repeat(40),
            upstreamFiles: { 'src/main.ts': sha256('upstream') },
            seams: { 'src/main.ts': { upstreamSha256: sha256('upstream'), patchedSha256: sha256('hook') } } };
        assert.equal(checkUpstream(root, manifest), 1);
        writeFileSync(path.join(root, 'src/main.ts'), 'unexpected');
        assert.throws(() => checkUpstream(root, manifest), /Upstream drift/);
        writeFileSync(path.join(root, 'src/main.ts'), 'hook');
        writeFileSync(path.join(root, 'src/custom.ts'), 'unregistered');
        assert.throws(() => checkUpstream(root, manifest), /outside src\/funes/);
        rmSync(path.join(root, 'src/main.ts'));
        assert.throws(() => checkUpstream(root, manifest), /Missing upstream file/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
