---
title: FUNES CMS integration for SuperSplat 3.3
status: current
owner: FUNES
last_updated: 2026-09-21
related_docs:
  - ../../docs/plugins/model3d-field/streamed-sog-upload.md
---

# FUNES CMS integration for SuperSplat 3.3

## Overview

This editor embeds the official SuperSplat **3.3.0** source at commit `f345ae5d667f4134e21be7dec01b09b78893203a`. FUNES behavior lives under `src/funes/`; upstream rendering, selection, resource storage and serialization remain upstream code. The previous integration used SuperSplat 2.16.1 and PlayCanvas 2.14.3. Version 3.3 uses PlayCanvas 2.22.1 and splat-transform 3.4.2.

The CMS upload and persistence contract is documented in [Streamed SOG upload](../../docs/plugins/model3d-field/streamed-sog-upload.md). This document covers only the embedded editing runtime and its upgrade boundary. The CMS owns authorization, durable generation jobs, draft updates and storage; the iframe never writes to CMS or S3.

## Scope

The integration retains normal Gaussian imports, LOD ZIP and loose manifest editing, per-level LOD preview, full SH3 PLY export, legacy binary SPLAT export, scale and selection transforms, initial-view reset, a world-origin marker and the initial safe-frame overlay. Editor mode keeps the compact CMS toolbar and scale-only transform sidebar. Read-only preview runs in a separate iframe and retains its own camera and resources.

SuperSplat 3.3 is **WebGPU only**. There is no WebGL fallback in this editor. The website's public streaming viewer is a separate runtime with separate capabilities.

## User-visible behavior

| Existing behavior | 3.3 implementation |
| --- | --- |
| `.ply`, `.sog`, `.splat` editing | Native `loadSplatSource` and `EditorSplatResource`; status becomes ready only after the model is added |
| LOD editing | Manifest references select LOD0 across all leaves; environment is included once; all chunks become one editable native source |
| LOD preview | The requested real level is decoded; a successful replacement removes the old scene, a failed replacement keeps it visible |
| Preview comparison | The first level fits the camera; later levels preserve the viewpoint |
| Uniform scale | Native transform panel, pivot and entity transform; exported coordinates and Gaussian dimensions include the scale |
| Selected-point editing | Native instance/palette operations; an adapter preserves the previous selection-centre pivot unless an explicit local frame is set |
| Set origin | Native undoable local-frame operation places the pivot at world zero while preserving the world geometry; no private GPU arrays are rewritten |
| Reset view | FUNES toolbar and the camera reset event restore the captured initial camera pose, accounting for later bounds changes |
| Safe frame and origin marker | Extension overlays retain the initial frame and world-origin marker. Each reference edge is clipped independently before projection; camera rotation cannot reconnect discarded corners into a triangle. The Safe to display caption stays inside the viewport. |
| Moving-camera quality | CMS editing and level preview use native sorted alpha blending throughout motion. The embedding reapplies `view.setStochastic: disabled` after preference restoration. This avoids upstream auto-mode sampling grain, at the cost of sorting heavy scenes while moving. |
| Full SH save | Export defaults to all three SH bands independently of display settings and runs after pending edits in the native command queue |
| Read-only preview | No editing shortcuts, geometry tools, file drop/picker handler, publishing, document saving or export protocol is installed/enabled |
| Language | English remains the embedding default; an explicit `lng` query can select an upstream locale |

The historical `exportType: 'sog'` iframe message continues to produce binary `.splat`, as before. CMS saves use `exportType: 'ply', maxSHBands: 3`; the backend performs actual SOG compression or LOD generation. The runtime never labels SPLAT bytes as SOG bytes.

## Technical approach

### Upstream boundary

`funes-upstream.json` pins the repository, release, commit, protocol and adapter. It verifies exact declared, locked and installed PlayCanvas, splat-transform, PCUI and JSZip versions, records hashes for upstream source/assets/build configuration and explicitly permits only two source seams:

1. `src/main.ts`: initialize integration, read-only registration gates, defaults/localization, startup error reporting, and delegated query loading.
2. `src/file-handler.ts`: ZIP chooser extension and one optional FUNES import dispatcher before upstream format detection.

The build remains the upstream Rollup configuration, wrapped by `rollup.funes.mjs`. The wrapper resolves JSZip to its **official browser distribution** and adds CommonJS conversion. It does not replace Node builtins with fake implementations. `npm run build` first checks upstream hashes and afterwards parses the output for unresolved eager imports. splat-transform's three audited Node-only dynamic imports (`module`, `node:worker_threads`, `node:os`) remain behind its Node environment checks; upstream disables its worker pool for browser exports.

No custom renderer, shaders, `Splat`, `EditorSplatResource`, standard serializer or core UI component is forked. The prior SOG GPU decompression workaround is removed. The custom layer uses native CPU `ChunkSource` data and native resource uploads. The native streamed-SOG reader assumes uniform SH bands and omits environment data, so FUNES validates its manifest independently and composes native SOG sources using `concatSource`. A small adapter normalizes mixed SH layouts with correct per-channel offsets and bounds the cache to two decoded chunks.

CMS passes `safeFrameAspect` from the full editor-layout dimensions, including the right save column. The overlay fits that ratio inside the actual narrower viewport before capturing its corners. Standalone loads without a valid ratio retain the viewport ratio. This query only controls the guide, not the camera or exported model.

The reference frame remains the initial world-space plane; resizing or moving the camera projects the same frame, and model scaling does not redefine it. It is a framing guide, not a save action or crop. Upstream render code and the website Viewer LOD budget policy are unchanged.

Axis buttons switch the native camera to orthographic projection. In that mode the guide clips only at the viewport edges, independently of the near/far depth range fitted to the model. Otherwise the long sides of an edge-on guide can lie outside that range and disappear, leaving just two endpoints. With the embedded editor's initial front-facing frame, ±X views show a vertical line, ±Y views show a horizontal line, and ±Z views show the full rectangle at the intended aspect ratio. Perspective views retain near/far clipping and independent edge segments; no synthetic closing edges are added.

### Host protocol

Messages are accepted only from the current `window.parent` and an exact HTTP(S) `embedOrigin`, or a valid referrer origin when no origin was configured. Missing or invalid trust information fails closed. The integration retains `supersplat:status`, `supersplat:load:result`, `supersplat:export`, `supersplat:export:result`, `supersplat:is-scene-dirty`, and LOD preview messages.

The optional handshake is:

```ts
// Parent request
{ type: 'funes:hello', protocolVersion: 1, requestId: 'request-id' }

// Editor response
{
  type: 'funes:hello:result', protocolVersion: 1, requestId: 'request-id',
  runtimeKind: 'editor', runtimeVersion: '3.3.0', integrationVersion: 1,
  graphicsBackend: 'webgpu',
  capabilities: {
    gaussianEdit: true, streamedSogEdit: true, fullShPlyExport: true,
    lodPreview: false, graphicsDiagnostics: false, webglFallback: false
  }
}
```

Preview mode reports the editing/export capabilities as false and `lodPreview` as true. The actual requested level and loaded point count accompany successful preview status. Query aliases `load`, `model`, `splat`, `splatUrl`, plus `lodManifestPath`, remain supported. Startup failures report an error to the parent, including an explicit WebGPU requirement when unsupported.

### Resource ownership

The source owns its archive and temporary decoded chunks until the native resource closes. ZIP loading remains bounded at 2 GiB, JSON at 16 MiB, the editor at 10 million points including environment, and referenced files at 4096. Path traversal, absolute references, malformed tree ranges, missing LOD0, inconsistent counts, special ZIP entries and unexpected resource requests are rejected. Only the selected level's metadata/textures are decoded. Repeated exports may reread chunks without double-counting the archive's expanded byte budget.

Preview requests serialize cleanup, cancel stale work, ignore stale completions, and retain the cached original ZIP between level changes. First-load, GPU-upload and resource-creation failures clean their owned sources. Page unload disposes message listeners and preview resources.

## Edge cases / failure modes

- Unsupported WebGPU is a visible startup error, never a silent downgrade to WebGL.
- A successful hello proves protocol compatibility, not that model loading or exporting has completed.
- A missing or empty model cannot export even if a ready status was queried before import.
- A malformed fine-level preview does not destroy the previous displayed level.
- Environment data is previewable/editable; backend save restrictions remain the CMS's responsibility.
- Node **22 or later** is required by splat-transform and the reproducible build toolchain.
- Upstream's pinned ESLint 10.10.0 currently crashes in its bundled `eslint-plugin-import` rule (`sourceCode.getTokenOrCommentAfter`). Type checking and behavior tests remain mandatory; do not suppress this incompatibility by weakening the code checks.

## Testing / verification

Axis-view regressions use all six orthographic directions with a model depth range narrower than the guide. They verify that side views collapse to complete overlapping lines, front/back views retain the rectangular aspect ratio, and offscreen guide segments still clip to the viewport. Existing perspective clipping regressions remain required. All 43 editor tests, TypeScript, upstream-boundary and browser-bundle checks passed after this fix. A local browser fixture reproduced the missing X-view edges before the fix and verified the complete vertical X line, horizontal Y line, Z rectangle and Reset view afterwards without saving CMS data. The Z rectangle measured 923.662 × 441.108 pixels, retaining the host's 2.093960 ratio; Reset view restored the original perspective rectangle.

Run with Node 22 or later:

```bash
npm ci
npm run check:funes
npx tsc --noEmit
npm test
npm run build
```

The tests exercise actual message handlers, trust boundaries, full-SH export settings, malformed and nested ZIPs, manifest selection across leaves, cancellation and replacement lifecycle, native `concatSource` reads across mixed-band files, and the real upstream scale-control → pivot → transform → serialized PLY/SPLAT path. The upstream guard has negative tests for missing files, unreviewed edits and custom code outside `src/funes/`.

Verified on 2026-09-18 in the isolated browser build: the CMS handshake and ready state, a 64-point SH3 PLY, uniform scale of 2 with every exported position range doubled and all 45 SH coefficients unchanged, and all three real Atomium ZIP levels: LOD2 with 361,197 points, LOD1 with 1,053,491 points, and LOD0 with 3,009,974 points. The full scene rendered correctly and the preview exposed no editing tools. No persisted model or S3 object was changed.

On 2026-09-21, 39 editor tests, TypeScript checking, the 262-file upstream boundary check, the development build and browser-bundle check passed. A local Atomium SOG reproduced automatic stochastic motion before the fix. After the fix, orbiting recorded camera changes with zero stochastic samples; the safe-frame path retained independently clipped original edges and its caption stayed inside the viewport. Scaling to 0.5 and using Reset view restored the initial reference frame while preserving the smaller geometry. This browser check used a temporary local fixture and made no CMS or S3 writes.

Before replacing an active deployment, verify in a real browser: handshake and startup failures, a normal SH3 source with scale/export/reload, subset selection and undo, origin/reset/overlays, editable LOD0, and separate read-only ZIP previews across all levels. Do not write S3 or replace persisted CMS assets during runtime verification.

## Code pointers

- `funes-upstream.json`, `scripts/check-funes-upstream.mjs`: pinned upstream and seam guard.
- `rollup.funes.mjs`, `scripts/check-browser-bundle.mjs`: browser build overlay and artifact check.
- `src/funes/bootstrap.ts`, `src/funes/bridge.ts`, `src/funes/query.ts`: embedding lifecycle and protocol.
- `src/funes/adapters/editor-v3.ts`, `chunk-source.ts`, `transform-handler.ts`, `overlay-projection.ts`: version-sensitive resource, serialization and transform adapters.
- `src/funes/lod/manifest.ts`, `archive.ts`, `source.ts`, `preview.ts`: validated LOD inputs and isolated preview lifecycle.
- `src/funes/ui/`: embedding skin, native local-frame controls, initial view and projection overlays.
- `tests/bridge.test.mjs`, `native-export.test.mjs`, `overlay-projection.test.mjs`, `lod-*.test.mjs`, `upstream-boundary.test.mjs`: runtime contracts.

## Follow-up work

Future upgrades begin with an isolated checkout of the desired upstream release. Review the two seams and adapter APIs, run the full suite and browser checklist, then update hashes deliberately. The guard should fail on an unreviewed upstream change. Do not copy old renderer internals or normalize the whole upstream source tree to hide merge differences. If upstream exposes a plugin import/bootstrap interface, remove the corresponding seam after proving equivalent behavior.
