---
title: FUNES CMS integration for SuperSplat 3.3
status: current
owner: FUNES
last_updated: 2026-10-19
related_docs:
  - ../../docs/plugins/model3d-field/streamed-sog-upload.md
  - ../../docs/plugins/model3d-field/streamed-sog-editing.md
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
| Preview comparison | An optional captured Editor view initializes the first level with the same camera pose and Safe Display lens; older requests without a view fit the bounds. Later levels preserve the current comparison viewpoint |
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

`funes-upstream.json` pins the repository, release, commit, protocol and adapter. It verifies exact declared, locked and installed PlayCanvas, splat-transform, PCUI and JSZip versions, records hashes for upstream source/assets/build configuration and explicitly permits three source seams:

1. `src/main.ts`: initialize integration, read-only registration gates, defaults/localization, startup error reporting, and delegated query loading.
2. `src/file-handler.ts`: ZIP chooser extension and one optional FUNES import dispatcher before upstream format detection.

The build remains the upstream Rollup configuration, wrapped by `rollup.funes.mjs`. The wrapper resolves JSZip to its **official browser distribution** and adds CommonJS conversion. It does not replace Node builtins with fake implementations. `npm run build` first checks upstream hashes and afterwards parses the output for unresolved eager imports. splat-transform's three audited Node-only dynamic imports (`module`, `node:worker_threads`, `node:os`) remain behind its Node environment checks; upstream disables its worker pool for browser exports.

No custom renderer, shaders, `Splat`, `EditorSplatResource`, standard serializer or core UI component is forked. The prior SOG GPU decompression workaround is removed. The custom layer uses native CPU `ChunkSource` data and native resource uploads. The native streamed-SOG reader assumes uniform SH bands and omits environment data, so FUNES validates its manifest independently and composes native SOG sources using `concatSource`. A small adapter normalizes mixed SH layouts with correct per-channel offsets and bounds the cache to two decoded chunks.

CMS passes `safeFrameAspect` from the full editor-layout dimensions, including the right save column. The overlay fits that ratio inside 80% of the actual narrower viewport. Standalone loads without a valid ratio retain the viewport ratio. The opted-in Editor camera compensates its lens so that the frame interior represents the saved vertical 45-degree composition, without changing the model or physical camera distance.

For opted-in CMS framing, the reference rectangle stays fixed in screen space during orbit, pan and zoom; resizing changes its fitted dimensions. Legacy sessions retain their initial world-space reference plane. It is a framing guide, not a save action or crop. Upstream render code and the website Viewer LOD budget policy are unchanged.

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
    lodPreview: false, lodPreviewFraming: false,
    graphicsDiagnostics: false, webglFallback: false
  }
}
```

Preview mode reports the editing/export capabilities as false and `lodPreview` and `lodPreviewFraming` as true. The actual requested level and loaded point count accompany successful preview status. Query aliases `load`, `model`, `splat`, `splatUrl`, plus `lodManifestPath`, remain supported. Startup failures report an error to the parent, including an explicit WebGPU requirement when unsupported.

The archive-load message accepts an optional `framing` object with version 1, finite three-component `position` and `target`, vertical `fov: 45`, and optional positive `safeFrameAspect`. A malformed supplied view fails explicitly before decoding; omitting it preserves bounds-based initialization. The host checks `lodPreviewFraming` before sending a captured view. Only the archive-load message forwards this object; level changes cannot replace the user's comparison view. A new archive applies its own snapshot. Cancellation prevents an obsolete archive from installing its camera.

The snapshot is in native Editor world coordinates. Native export removes the PLY import rotation, and native preview import applies it again, so the preview camera must not flip coordinates. `src/funes/adapters/preview-framing.ts` restores the pose once and shares `compositionFov` with editing. Before restoring it, the adapter reads the native lazy scene bound so that camera distance is normalized against the loaded model radius, avoiding an initial max-zoom clamp on large models. It preserves physical camera distance while adapting to viewport size, horizontal/vertical FOV and pixel ratio changes. It does not install framing inputs, origin locks, geometry edits or persistence behavior. Cleanup removes its render listener along with the preview resources. Model draft saving, Scene initial-camera overrides, publish behavior, locale and authorization remain the CMS's responsibility.

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

The tests exercise actual message handlers, trust boundaries, full-SH export settings, malformed and nested ZIPs, manifest selection across leaves, cancellation and replacement lifecycle, native `concatSource` reads across mixed-band files, and the real upstream scale-control → pivot → transform → serialized PLY/SPLAT path. Preview-camera regressions cover archive-only bridge forwarding, malformed-view rejection, unchanged native pose and nonzero target, resize/FOV composition, physical-distance preservation, later comparison camera changes, cancellation and archive replacement. The upstream guard has negative tests for missing files, unreviewed edits and custom code outside `src/funes/`.

For the preview-camera correction on 2026-10-19, the new regressions first failed five cases against the old runtime. A further lazy-bound regression reproduced a 150-unit camera distance being clamped to 14.7657 units before bound synchronization. After the fix, all 68 Editor tests, TypeScript and the production build (including upstream and browser-bundle checks) passed. CMS integration and real-browser acceptance are recorded in [Streamed SOG editing](../../docs/plugins/model3d-field/streamed-sog-editing.md).

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

Future upgrades begin with an isolated checkout of the desired upstream release. Review the declared seams and adapter APIs, run the full suite and browser checklist, then update hashes deliberately. The guard should fail on an unreviewed upstream change. Do not copy old renderer internals or normalize the whole upstream source tree to hide merge differences. If upstream exposes a plugin import/bootstrap interface, remove the corresponding seam after proving equivalent behavior.

## Browser LOD generation

`src/funes/lod/generate.ts` generates the final spatial LOD package on the user's WebGPU device. `src/funes/adapters/editor-v3.ts` holds the editor command queue while reading the edited native chunk source with all available SH bands. The additional reviewed seam in `src/splat-serialize.ts` only exports `createExportSource` and `createGpuDevice`; serialization algorithms remain upstream. Decimation starts independently from full detail at each level. Reduced intermediate float PLY stays in browser memory for random-access spatial packing, avoiding an extra lossy intermediate SOG encode.

The bridge advertises `browserLodGeneration`, emits request-scoped progress, and transfers the final archive plus level counts. The CMS retains these bytes for preview and upload; the iframe never writes CMS/S3. The full model must fit available memory, and generation requires WebGPU. The upstream boundary test includes the serializer export seam. The CMS workflow is documented in [Gaussian editing](../../docs/plugins/model3d-field/streamed-sog-editing.md).

### Browser generation scratch storage

Multi-block adaptive simplification writes merge plans and spill data to a per-generation private browser directory (OPFS), supplied through `DecimateAdaptiveSpill`. The directory is removed after normal completion or failure, and unfinished writers are aborted first. No directory picker or installation is required. Unsupported storage or a browser quota failure stops generation before upload. Abrupt browser/process termination can leave temporary storage behind; normal cleanup cannot be guaranteed after a crash. The implementation is `supersplat-editor/src/funes/lod/scratch.ts` (relative to CMS), wired by the Editor version adapter. No additional server configuration is introduced.

### Generated archive paths

The browser spatial writer resolves output names against an explicit virtual `/funes-lod/` root. The package filesystem strips only that root before writing ZIP entries and rejects paths outside it. Every stored path is relative, including `lod-meta.json` and chunk resources. This keeps generated packages compatible with the unchanged preview and server path validation; neither validator permits absolute paths. The real generator regression checks stored names and JSZip original names as well as level counts and SH bands.

### Loading feedback

FUNES model import and local LOD preview decoding fire the native reference-counted spinner events around loading and scene insertion. A finally block releases the spinner after success or failure; cancelled preview operations also release it.

## Gaussian composition (opt-in)

CMS enables `gaussianFraming=1` and optionally provides `initialFraming` JSON plus the existing `safeFrameAspect`. `src/funes/adapters/framing.ts` provides camera-only **Framing size (%)**, a camera-relative Safe Display rectangle, and a 45-degree vertical lens within that rectangle. The physical Scale panel/tool is hidden in this mode. Explicit geometry operations otherwise retain native behavior. Unflagged integrations are unchanged.

Export responses include `framing` captured before asynchronous generation: version 1, position, target, fov, and derived orbit values. CMS requires this capability for flagged saves, persists it transactionally in Scene `metadata.editorState` (including optional `safeFrameAspect`), and passes it back on reopen. Scene camera overrides remain separate and are never overwritten by a Model Editor save. No geometry normalization runs on restoration. Tests in `tests/framing.test.mjs` cover repeated capture/restore without touching model transforms. See [CMS editing contract](../../docs/plugins/model3d-field/streamed-sog-editing.md) for persistence and compatibility rules.

### Screen-space Safe Display correction (2026-09-26)

In opt-in framing mode, `InitialFrameOverlay.update` draws the fitted rectangle directly in viewport pixels. It does not capture or project world-space corners. This corrects the prior one-time capture guard, which kept the old reference plane and made it shrink or move with the model during camera changes. Legacy unflagged overlays keep their original behavior. `tests/initial-frame-overlay.test.mjs` verifies that repeated updates never read the camera and that resizing preserves the requested aspect ratio.

### Responsive composition frame (2026-09-27)

The opt-in Safe Display rectangle now fits within 80% of the Editor viewport, leaving at least 10% on each side so its full outline remains visible on narrow and wide windows. It retains the host display aspect ratio. The overlay and camera share `fitCompositionFrame` and `compositionFov` in `supersplat-editor/src/funes/adapters/overlay-projection.ts` (Editor-relative path: `src/funes/adapters/overlay-projection.ts`). The preview lens compensates for the inset rectangle while preserving physical camera distance: the frame interior still represents the saved vertical 45-degree composition. Resizing never changes model scale or persisted camera pose. CSS viewport dimensions are used consistently for the overlay and lens, independently of device pixel ratio.

`tests/initial-frame-overlay.test.mjs` in the Editor verifies narrow, wide and high-resolution viewport containment, target aspect ratio, and equal frame-relative projection for horizontal and vertical FOV cameras. Legacy unflagged reference planes are unchanged.

### Framing readout synchronization (2026-09-27)

The Framing size percentage now follows camera distance changes from wheel zoom as well as numeric input, relative to the initial restored distance. Focused input is left untouched to allow typing. Before the restoration described below, Set Origin used the v3 local-frame operation: it relocates the editing pivot to world zero, unlike the legacy implementation which baked translation into point positions and zeroed the entity translation. The readout fix itself did not change origin behavior.

### Restored model-origin operation (2026-09-27)

Set Origin now restores the legacy rebase semantics: bake entity translation into every Gaussian's point transform, then zero entity translation and reset the local editing frame. It preserves world-space geometry, rotation, scale, point attributes, and the presentation camera. It includes all instances regardless of selection/visibility and composes with existing per-point transforms. The native export path consumes the point transform palette, so PLY/SOG and browser-generated LOD retain the rebased coordinates; reopening needs no editor-only pivot metadata.

`src/funes/adapters/set-origin.ts` in the Editor implements the operation through the existing edit queue and supports undo/redo; `src/funes/ui/editor-ui.ts` wires the button. Zero/invalid scale is rejected. Clicking again at zero with an identity local frame is a no-op. `tests/set-origin.test.mjs` verifies world geometry and export-transform equivalence under rotated, nonuniformly scaled objects with existing point transforms, repeat operations, and undo/redo. No scene schema, Mesh behavior, or model scale is changed. Real-model save/reopen visual acceptance remains a separate check.

### Fixed world-origin reference (2026-09-27)

Gaussian composition editing now constrains the actual orbit target to world `(0,0,0)`, matching the OBJ editor's origin reference. Native model Move operations translate the model relative to that point; camera pan/fly input cannot move the composition target. Orbit and camera distance remain adjustable. `lockFramingOrigin` in the Editor's `src/funes/adapters/framing.ts` enforces the target after native controller input, before camera matrix calculation. It does not alter model transforms. Previously saved off-center framing is re-aimed toward zero when reopening the Editor; already published viewer data is not migrated. Newly saved framing targets world zero.

The 10-pixel solid orange world-origin dot (without crosshairs or an outer ring) is projected from the actual world-zero position and remains at the center of the responsive Safe Display rectangle. Its guide visibility ignores model near/far clipping in framing mode so off-center geometry cannot hide it. `src/funes/ui/origin-marker.ts` and `src/funes/ui/styles.scss` implement the marker. Set Origin keeps the rebasing operation above and does not move the camera or world reference. Mesh and unflagged standalone editors retain their existing camera behavior. Tests verify that simulated pan/fly input is constrained before projection without accessing model geometry.

### CMS panel visibility and output names (2026-09-27)

CMS Gaussian editing hides the Framing size control and the entire Colors section. Wheel/orbit framing and saved camera state remain active; standalone Editor controls and Mesh editing are unchanged. The embedding stylesheet owns the visibility rules.

Single-file PLY/SOG saves retain the authorized source entry's display-name stem, including Unicode, spaces, and embedded dots, and replace only the known format suffix. Storage keys remain immutable UUID paths. LOD saving continues to derive its archive display name from authorized source media; repeated LOD saves preserve that name. No schema or environment change is required. Storage regressions verify persisted names for both single-file formats; existing LOD job tests cover archive names. Code pointers: CMS `server/src/services/gaussian.ts` and `server/src/utils/lod-filename.ts` in the Model3D plugin, and Editor `src/funes/ui/styles.scss`.

### Origin pivot and axis views (2026-09-27)

CMS Gaussian Editor refreshes the transform pivot even when Set Origin requires no geometry rebase. A picked gizmo position must not survive an explicit return to the model origin. Normal rebasing and undo remain unchanged. Axis-cube clicks retain perspective projection and camera distance; only the native axis orientation changes. The embedded scene panel is hidden completely, including its otherwise empty Transform header. These embedding rules do not affect Mesh or standalone SuperSplat. Implementation: `src/funes/ui/editor-ui.ts` and `src/funes/ui/styles.scss` in SuperSplat Editor.

The CMS transform adapter centers only a strict partial selection. Selecting all non-deleted points keeps the model-origin pivot, including after Set Origin; it no longer silently substitutes the selection bounding-box center. `tests/native-export.test.mjs` covers both whole-model and partial-selection pivots.
