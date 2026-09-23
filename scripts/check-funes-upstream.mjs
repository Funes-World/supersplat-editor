import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function checkUpstream(root, manifest = JSON.parse(readFileSync(path.join(root, 'funes-upstream.json'), 'utf8'))) {
    const errors = [];
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version !== manifest.version) errors.push('Editor package version does not match the pinned upstream release.');
    if (manifest.protocolVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.commit)) errors.push('Invalid upstream/protocol manifest.');
    const lock = Object.keys(manifest.dependencies ?? {}).length ? JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) : null;
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
        const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
        const locked = lock.packages?.[`node_modules/${name}`]?.version;
        if (declared !== version || locked !== version) errors.push(`Dependency drift: ${name} must be pinned to ${version} in package.json and package-lock.json.`);
        try {
            const installed = JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
            if (installed.version !== version) errors.push(`Installed dependency drift: ${name} is ${installed.version}, expected ${version}. Run npm ci.`);
        } catch { errors.push(`Missing installed dependency: ${name}. Run npm ci.`); }
    }
    for (const [name, hash] of Object.entries(manifest.upstreamFiles)) {
        try {
            const expected = manifest.seams[name]?.patchedSha256 ?? hash;
            if (sha256(readFileSync(path.join(root, name))) !== expected) errors.push(`Upstream drift: ${name}`);
        } catch { errors.push(`Missing upstream file: ${name}`); }
    }
    const visit = directory => {
        for (const item of readdirSync(path.join(root, directory), { withFileTypes: true })) {
            const name = `${directory}/${item.name}`;
            if (name === 'src/funes') continue;
            if (item.isDirectory()) visit(name);
            else if (!(name in manifest.upstreamFiles)) errors.push(`Custom code outside src/funes: ${name}`);
        }
    };
    visit('src');
    for (const [name, seam] of Object.entries(manifest.seams)) {
        if (manifest.upstreamFiles[name] !== seam.upstreamSha256) errors.push(`Invalid seam baseline: ${name}`);
    }
    if (errors.length) throw new Error(`${errors.join('\n')}\nReview the new upstream adapter and explicitly update the manifest; do not suppress this check.`);
    return Object.keys(manifest.upstreamFiles).length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    try { console.log(`FUNES upstream compatibility: ${checkUpstream(root)} files match SuperSplat 3.3.0 and its reviewed seams.`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
