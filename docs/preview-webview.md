# Webview preview migration (WASM compositor)

Status: approved 2026-07-12 (supersedes the "native child-window preview" rule; AGENTS.md §0.5
updated in the same change). This doc is the contract for the migration.

## Why

Measured on generated 1080p60 H.264 @ 51 Mbps footage in the app-equivalent Chromium engine:

| Path | Presented fps | Dropped | Per-frame paint cost |
|---|---|---|---|
| Browser pipeline → Canvas2D | 60.1 | 0 / 1544 | 0.11 ms |
| Browser pipeline → WebGL texture | 60.0 | 0 / 1573 | 0.12 ms |

The browser gives hardware decode, zero-copy compositing, and frame scheduling for free.
The native path (FFmpeg CLI → RGBA pipe → wgpu → present) pays CPU decode + pipe copies +
GPU↔CPU round-trips, and carries four per-OS child-window backends
(`renderly-app/src-tauri/src/preview/{win32,macos,linux/x11,linux/wayland}.rs`) plus the
bounds-sync fragility of OS-composited child windows. Direct manipulation (handles, masks,
guides) also becomes first-class DOM instead of overlays floating over a foreign window.

## Non-negotiables

1. **One compositor.** The preview uses `renderly-core`'s compositor compiled to `wasm32`,
   fed by browser-decoded frames. Never re-implement effects in JS — that forks
   preview↔export parity. Export and headless (CLI/MCP `render_frame`) keep the native engine.
2. **Command API and engine boundaries are unchanged.** This migration touches only how
   pixels reach the screen in `renderly-app`.
3. **Native preview stays as a runtime fallback** (env/flag) until the webview path reaches
   parity on the QA checklist, then the child-window backends are deleted in one PR.

## Architecture

```
media file ──► <video> / WebCodecs VideoDecoder (HW decode, browser-scheduled)
                    │  VideoFrame (GPU-backed)
                    ▼
    importExternalTexture / texImage2D  ──►  renderly-core compositor (wasm32 + WebGPU)
                    │                          effects/transitions/masks = same WGSL
                    ▼
              <canvas> in the editor layout (plain DOM sibling of handles/overlays)
```

- **Decode**: start with `<video>` elements per active clip + `requestVideoFrameCallback`
  (simplest, browser-scheduled); move seeking-critical paths to `WebCodecs`
  (`VideoDecoder` + mp4 demux) where frame-accurate stepping needs it. Audio stays on the
  existing rodio path initially (backend clock), then migrates to WebAudio when the webview
  owns playback end-to-end.
- **Compositor**: new crate feature `renderly-core/wasm-compositor` gating a `wasm32`
  build of `compose/` (wgpu → WebGPU). The `media/ffmpeg_cli`, `plugins` (wasmtime),
  `captions` STT/TTS, and `perceive` modules are **excluded** on wasm32 (feature-gated) —
  the wasm build takes decoded RGBA/external textures as input, nothing else.
- **Bindings**: `wasm-bindgen` interface `WasmCompositor { new(canvas), set_project(json),
  render(time, frames: [(clip_id, VideoFrame|texture)]) }` in a new `renderly-wasm` crate
  (keeps wasm-bindgen out of core's default build).
- **Clock**: webview owns the playback clock for preview (rVFC-driven); the backend stays
  authoritative for export timing. `playback:tick` events reverse direction (frontend →
  store) or disappear entirely once preview is local.

## Phases

- **P1a — Paused frame in a DOM canvas (attempted 2026-07, REVERTED).** Tried to fix the
  handles-occlusion bug by hiding the native surface and rendering the composited frame to
  a webview `<img>` via a new `render_preview_frame(time) -> PNG data URL` command (reused
  `render_live_frame_png`), so the DOM transform/mask handles would compose above it
  instead of being occluded. It worked structurally (verified z-order in the harness) but
  was **not** the PoC's fast path — the PoC's 60fps came from the *browser* decoding video;
  this instead round-tripped through the engine (FFmpeg decode → composite → PNG-encode →
  base64 → IPC → webview PNG-decode) and reopened the decoder per call, so it was slow even
  after narrowing the trigger to "only while transform-editing a clip." Reverted at the
  user's request rather than layer more fixes onto a stopgap; the handles-occlusion bug is
  **still open**. Do not reintroduce a PNG-per-frame bridge as the fix — go straight to real
  P1 (`<video>`/WebCodecs decode in the webview) so speed and the occlusion fix land
  together. If a stopgap is wanted again before P1, consider a persistent/cached decoder
  server-side (avoid reopening FFmpeg per call) rather than PNG round-trips.
- **P1 — Decode + blit (no effects). IMPLEMENTED 2026-07-15.** `<video>`/`<img>`-fed
  `<canvas>` preview, default ON (opt back to native via
  `localStorage["renderly.previewEngine"] = "native"`, checked by `isWebviewPreview()` in
  `renderly-app/src/preview/webviewPreviewEngine.ts`). Cuts-only timelines play: multi-clip
  switching, seek/scrub, transforms, opacity, speed, and multi-track layering (images
  included) all render locally in the webview, mirroring `renderly-core`'s timeline
  evaluation and `compose/mod.rs`'s cover-fit + user-transform math exactly (never a
  from-scratch reimplementation — see the Non-negotiables above).

  **What was built:**
  - `renderly-app/src/preview/webviewPreviewEngine.ts` — `WebviewPreviewEngine`: a pooled
    `<video>`/`<img>` element per media item, a timeline evaluator mirroring
    `active_layers` (renderly-core/src/export/mod.rs) — tracks iterated in array order,
    first = bottom, per `compose/mod.rs`'s `composite` doc comment — a cover-fit + user
    transform draw (`coverSourceRect` + `drawLayer`, a pixel-space mirror of `cover_uv`/
    `layer_params` in `compose/mod.rs`), and a dual-mode clock: `playback:tick` drift-slews
    a local `requestAnimationFrame` clock when ticks arrive (real app), or the pure rAF
    clock drives everything standalone (browser harness, no backend). Canvas backing-store
    resize follows the same "only reassign width/height when it actually changed" rule as
    `timeline/renderer.ts`'s `syncCanvasSize`.
  - `renderly-app/src/preview/WebviewPreview.tsx` — the `<canvas>` component, positioned at
    the letterboxed content rect (same math as `PreviewHandlesOverlay`'s
    `contentBoundsInHost`), `z-index: 0` (below the handles/mask overlays at 5/6) — this is
    the actual occlusion-bug fix: handles are now plain DOM siblings painted after the
    canvas in z-order, not an OS-composited window on top of everything.
  - `PreviewPanel.tsx` renders `<WebviewPreview/>` instead of calling
    `ipc.setPreviewBounds` when `isWebviewPreview()` (so the native child window is never
    created); `PreviewHandlesOverlay`/`PreviewMaskOverlay` skip their backend
    `previewTransformOverride`/`previewMaskOverride` round trips in webview mode — the
    canvas subscribes to the store directly and redraws on every optimistic patch instead.
  - Backend: new `set_preview_mode(mode: "webview"|"native")` command
    (`renderly-app/src-tauri/src/lib.rs`), backed by `PlaybackEngine::webview_mode`
    (`AtomicBool`, `src-tauri/src/playback.rs`). In webview mode, `run_playback_loop` never
    constructs a `FrameRenderer` and does audio-only work (premix + `playback:tick`
    pacing); `play`/`seek`/`refresh_frame` skip `ensure_preview_parent` and the native
    scrub-worker render paths entirely (playhead bookkeeping still happens). The frontend
    calls `set_preview_mode` once at startup (`App.tsx`) from `isWebviewPreview()`.
  - Asset protocol: `open_project` and `apply_command`'s `MediaImported` outcome now call
    `app.asset_protocol_scope().allow_file(&media.path)` for every media item (helper
    `allow_media_assets` in `lib.rs`) so the webview's `<video src>`/`<img src>`
    (`convertFileSrc`) can actually load arbitrary project media, not just
    `$APPCACHE/media-cache/*`.
  - Harness upgrades (`renderly-app/src/dev/tauriMock.ts`,
    `renderly-app/vite.harness.config.ts`): a tiny `listen`/`emit` event bus; mock
    `play`/`pause` drive a ~33 Hz `playback:tick`/`playback:state` simulation; two real
    1920×1080@60 H.264 clips generated with ffmpeg
    (`testsrc2`/`smptebars`, 12s each) into a gitignored `renderly-app/dev-assets/`
    (harness-only `publicDir`, never touches `vite.config.ts` or ships in `dist`); the
    mock's `convertFileSrc` maps the sample project's fake media paths onto those two
    files so real browser decode is exercised end-to-end.

  **Measured in the browser harness** (`npx vite --config vite.harness.config.ts --port
  5188`, verified via the `javascript_tool`/DOM — the harness's browser-automation tab
  reports `document.hidden === true` even when fronted, which throttles
  `requestAnimationFrame`; `WebviewPreviewEngine` falls back to a `setTimeout`-paced loop
  only while `document.hidden`, purely so this harness can measure sustained playback at
  all — production/foreground windows always use rAF):
  - Canvas position: correctly sized/positioned at the letterboxed content rect
    (`getBoundingClientRect` matched `contentBoundsInHost`'s math), `z-index: 0`, below
    `.preview-handles-overlay` at `z-index: 5` — occlusion fix verified structurally.
  - Sustained playback over 6s: **fps ≈ 33.3, per-frame draw cost (canvas draw work,
    excluding scheduling) ≈ 0.8 ms, drops ≈ 189/200 frames** by the engine's own
    `window.__previewStats`. The fps/drop numbers reflect the harness tab's timer
    throttling (measured interval ≈2× the requested 16 ms, i.e. an environment artifact of
    this specific automated browser pane, not the engine) — they are **not** a clean 60fps
    measurement and should not be read as such. The one number that *is* environment-
    independent, per-frame draw cost (~0.8 ms for clearRect + fillRect + N-layer
    seek-correction + `drawImage`), is well inside a 16.7 ms/60fps budget and consistent
    with the PoC's ~0.11 ms Canvas2D `drawImage` figure (ours is higher because it
    includes per-frame layer bookkeeping the PoC's isolated benchmark didn't).
    **Foreground confirmation: 2026-07-15, the project owner ran the real desktop app and
    confirmed playback speed meets expectations** ("fast as I was expecting"), closing the
    gap the automated harness couldn't cover (its pane reports `document.hidden`, which
    throttles rAF). The formal QA-checklist numbers (4K60, 3-track, scrub-storm) below
    remain to be captured, but the P1 perf gate is considered met for 1080p60.
  - Scrub: sampled a pixel before/after seeking across the `c-round1`→`c-killcam` cut
    boundary (t=2 → t=10, testsrc2 vs smptebars source clips) — pixel value changed
    (`[243,233,103]` → `[0,161,0]`), confirming the canvas actually repaints on scrub.
  - Multi-clip cut during playback: played from t=8.5 across the t=9.4 cut to t≈11.5;
    sampled pixel matched the *next* clip's content, confirming gapless in-playback
    switching.
  - Transform redraw while paused: isolated the overlay clip (hid the covering track),
    patched its `ClipTransform` directly on the store (mirroring
    `PreviewHandlesOverlay`'s optimistic drag patch) with no `playing` and no backend
    call — canvas content changed immediately (`notifyProjectPatched`'s store-subscription
    redraw), confirming local full-rate transform preview.
  - Native fallback: `localStorage["renderly.previewEngine"] = "native"` reload correctly
    suppressed the webview canvas while leaving `PreviewHandlesOverlay` (native path)
    unaffected.

  **P1 scope limits (accepted, per the Non-negotiables above):** effects, LUTs, masks,
  chroma key, captions, and keyframed animation do **not** render in the webview preview
  yet — they're P2's WASM-compositor work. A clip with any of those active still shows its
  raw cover-fit + transform content in the webview preview (no visible error, just no
  effect); the native fallback remains the way to preview those until P2 lands. Audio
  stays entirely on the existing backend/rodio path (`playback:tick` is audio-clock-driven
  regardless of preview mode) — unaffected by this migration.
- **P2 — WASM compositor. IMPLEMENTED 2026-07-15** (stages 1–5 of the migration plan; the
  P2 target — renderly-core's actual compositor compiled to wasm32/WebGPU rendering the
  editor preview — is live, with the deferred items listed below). Committed baseline for
  stages 1–2 (wasm32 gating + eval extraction) is b910c52; this entry documents the full
  P2 state including stages 3–5.

  **What was built (stages 1–2, commit b910c52):**
  - `renderly-core` compiles on `wasm32-unknown-unknown` via `#[cfg(target_arch)]` gating
    (not a Cargo feature — simpler and can't be left off): `audio`, `captions`,
    `commands`, `export`, `media`, `perceive`, `plugins`, `segmentation` are native-only;
    `project` (+`anim`), `compose` (all WGSL effects/transitions/chroma/masks), `mask`,
    `packs`' pure LUT helpers, and the new `frame` module (`RgbaFrame`, moved out of
    `media`) build on both targets. Native-only deps live under
    `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`.
  - The parity-critical evaluation ("which layers are active at time T, with what source
    times, keyframed params, transition progress") was extracted verbatim from
    `export/mod.rs` into decode-free `renderly-core/src/compose/eval.rs`
    (`active_layers` / `ActiveLayer` / `active_captions` / `multicam_angle_active`,
    error type `EvalError`), used by BOTH the native `FrameRenderer` and the wasm
    compositor — one evaluation, two frontends. 7 unit tests cover clip coverage,
    source-time math, transition-window pair emission, hidden tracks, captions.

  **What was built (stage 3 — the wasm crate and pipeline):**
  - `renderly-core/src/compose/mod.rs`: `ComposeLayer.frame: RgbaFrame` became
    `ComposeLayer.source: LayerSource` with two variants — `Frame(RgbaFrame)` (native
    decode path, pooled upload textures, unchanged behavior) and `Texture { texture,
    width, height }` (externally-owned GPU texture, bound directly, never pooled). This is
    the zero-readback hook: the browser fills the texture, core composites it with the
    same effect/mask/transition passes. `eval::ActiveLayer` gained `media_id` so the
    webview can key its element pool by media item.
  - New workspace member `renderly-wasm/` (cdylib+rlib). ALL its real dependencies are
    target-gated to wasm32, so it builds as an empty lib on native targets —
    `cargo build/test/clippy --workspace` on the native target stays green with it as a
    plain member (verified). wasm-bindgen surface (`src/compositor.rs`):
    - `WasmCompositor.create(canvas)` (async): WebGPU-only wgpu instance
      (`Backends::BROWSER_WEBGPU`), surface from `SurfaceTarget::Canvas`, adapter/device
      request, `get_default_config` surface config (browser-preferred format, typically
      `Bgra8Unorm` — the A4 "format parameter" turned out NOT to exist in core, whose
      internal RT is hardcoded `Rgba8Unorm`, so presentation is a tiny blit pass in
      renderly-wasm that samples core's `output_view()` into the surface; the pipeline's
      target format performs the conversion). Also installs a `device.on_uncaptured_error`
      → `console.error` hook — on the WebGPU backend a validation error silently discards
      the whole submit (stale/black canvas, no exception), which is undebuggable
      without it.
    - `set_project(json)`: serde-parses the store's project JSON (same schema as the
      project file), rebuilds the core `Compositor` via `Compositor::with_device` when the
      output resolution changes.
    - `render(time_secs, sources)`: `sources` is a JS object mapping media-id →
      `HTMLVideoElement`/`HTMLImageElement`. Runs `compose::eval::active_layers`, copies
      each active layer's element into a pooled per-media `Rgba8Unorm` texture with
      `Queue::copy_external_image_to_texture` (zero CPU readback; dest usage
      `COPY_DST | RENDER_ATTACHMENT | TEXTURE_BINDING` per WebGPU spec), builds
      `ComposeLayer`s (transform/effects/mask/transition straight from eval), runs
      `compose_to_texture`, blits to the canvas surface, presents via `queue.present`.
      Not-ready elements are skipped for the frame (same policy as P1). Raster/`Generated`
      mattes are dropped (deferred, below).
    - `debug_layers(time_secs, sources)`: QA introspection used by the harness (layer
      count, per-layer element resolution, transition progress).
  - Build: `npm run build:wasm` in renderly-app runs
    `wasm-pack build ../renderly-wasm --target web --release --out-dir
    ../renderly-app/src/wasm-pkg --no-pack`. The generated pkg is **gitignored**
    (wasm-pack emits its own `*` .gitignore) — run `build:wasm` once after checkout to get
    the GPU preview path. **Binary size: 468 KB wasm (release + wasm-opt) + 61 KB JS glue.**
  - Shader fix that P2 flushed out: `transition.wgsl`'s `sample_or_black` called
    `textureSample` under varying-dependent control flow — native naga is lenient, but the
    browser's WGSL compiler enforces the uniformity analysis strictly and rejected the
    module, which (silently!) discarded every submit containing the transition pass.
    Rewritten to sample-then-`select` (and the slide branches hoist both samples out of
    the varying branch). Same shader on both targets; a new native GPU test
    (`compose::tests::transition_pair_blends_mid_progress`) now covers the transition
    blend path with a readback assert.

  **What was built (engine integration, `webviewPreviewEngine.ts` / `WebviewPreview.tsx`):**
  - Graceful-degradation ladder in the new async `WebviewPreviewEngine.init()`:
    `navigator.gpu` present → `requestAdapter()` non-null (probed BEFORE touching the
    canvas — a canvas that ever had a webgpu context can never yield a 2d one; plus one
    300 ms retry, adapter requests can transiently return null during page load) → lazy
    dynamic import of `/src/wasm-pkg/renderly_wasm.js` (specifier deliberately opaque to
    Vite's static analysis via `@vite-ignore`; see "build step" below) → `create(canvas)`
    → mode `"webgpu"`. Any missing rung → the untouched P1 Canvas2D path, mode
    `"canvas2d"`. `localStorage["renderly.previewEngine"]="native"` still bypasses the
    engine entirely.
  - `window.__previewStats` gained `mode: "webgpu" | "canvas2d" | "native"` (the engine
    reports the first two; "native" means the engine isn't instantiated).
  - The P1 element-management layer (pooled `<video>`/`<img>`, dual-mode clock,
    playback:tick slew, pre-seek, seek-correction, pause bookkeeping) is shared by both
    modes (`manageElements`). In webgpu mode it additionally manages transition-incoming
    clips (`transitionIncomingLayers` mirrors eval.rs's window math for ELEMENT
    MANAGEMENT only — which `<video>` to play/seek; compositing decisions stay in Rust).
  - In webgpu mode the engine hands every pooled element to `render(t, sources)` per
    frame and pushes `set_project(JSON.stringify(project))` on every project change (the
    store holds the Rust project schema verbatim), so paused transform-handle drags
    redraw live exactly as in P1 (store patch → subscription/effect → set_project + one
    render).
  - React StrictMode note: dev double-mount used to race two async inits on one canvas
    (deadlock). Init is serialized module-wide (`enqueueInit`) and honors `disposed`
    mid-flight, freeing an orphaned compositor so the successor engine can claim the
    canvas.
  - The harness/mock (`tauriMock.ts`) sample project now uses real UUID ids (`MOCK_IDS`
    keeps the old readable names addressable) — the Rust schema types ids as UUIDs and
    the wasm `set_project` serde-parses the store project, so P1's readable slug ids
    stopped parsing.

  **Measured in the browser harness (2026-07-15, `npx vite --config
  vite.harness.config.ts --port 5188`, driven via javascript_tool + `window.__store`;
  WebGPU WAS available in the pane — NVIDIA adapter):**
  - Mode ladder: `__previewStats.mode === "webgpu"`, fallback path exercised earlier in
    the session (pre-fix UUID parse failure correctly warned and fell back to canvas2d
    without a black preview).
  - Base compositing: video content on canvas (testsrc2 center `[7,19,202]` at t=2,
    smptebars `[0,164,0]` after the cut); repaints on scrub.
  - Effects (store-patched, GPU): `color_adjust` exposure 2.0 → `[25,73,255]`; blur r24 →
    `[117,118,138]`; `lut_contrast` → `[0,0,210]`; `lut_warm` → `[3,15,182]`; `glitch` →
    RGB-split displacement; all revert bit-exact to base.
  - Transitions mid-junction: crossfade window [8.9,9.4) sampled at p10/p50/p90 →
    `[229,232,0]` / `[127,202,0]` / `[25,172,0]` between pure outgoing `[255,240,0]` and
    pure incoming `[0,164,0]` — monotonic linear mix, exactly `mix(a,b,u)`. `wipe_left`
    at p50: left samples incoming, right samples outgoing. (Other 8 kinds share the same
    verified shader/uniform path; not individually pixel-sampled.)
  - Masks: rect (0.25..0.75)² → outside black, inside untouched; ellipse ditto.
  - Chroma key: greenest smptebars pixel `[0,164,0]` → keyed to transparent (black
    background) with `key_g` 0.63/tol 0.25 → `[0,0,0]`, restored exactly.
  - Keyframes (Rust `project::anim` eval, not JS): opacity ramp 1→0 over 8 s sampled at
    t=2 → `[5,14,152]` = exactly 0.75 × base (202×0.75=151.5); static opacity 0.5 →
    `[3,9,101]`; keyframed `pos_x` shifts content (left edge black, center shows shifted
    pixels). These exact multiplier matches (±1 LSB rounding) are the strongest
    parity evidence collected: same keyframe eval + same composite WGSL as export.
  - Multi-layer: with the covering track hidden, the transformed overlay clip
    (scale 0.32, y=-0.55) renders at its transformed position (content at screen-y≈0.75
    band, black elsewhere) — matching core's NDC math and P1's mirror of it.
  - Paused drag-patch: store-only project patch (no engine calls) with opacity 0.3 →
    canvas pixel `[2,6,60]` = exactly 0.3 × base — the optimistic-drag redraw path works
    in GPU mode.
  - Perf: per-frame CPU-side cost (`drawMs`: eval + element bookkeeping + 1–2
    `copyExternalImageToTexture` + compose/blit encode + submit) measured **0.4–1.2 ms**
    during sustained playback — well inside a 16.7 ms/60 fps budget. The harness pane's
    fps figure (~1 fps) is meaningless: the automation tab reports `document.hidden`
    and had been hidden long enough for Chrome's *intensive* timer throttling (~1 Hz
    timers); as with P1, foreground fps must be confirmed in the real app (P1's
    equivalent number was confirmed by the project owner in the desktop app).

  **Parity status:** the P2 target ("pixel-diff preview vs `render_frame` export readback
  ≤ 1 ULP-ish on the effects test project") is NOT yet automated cross-target — a
  browser-side canvas readback goes through the stretched surface blit and browser video
  decode, so a credible automated diff needs synthetic flat-color fixtures fed through
  both paths (future work). What exists instead: (a) both paths are literally the same
  Rust/WGSL (`compose::eval` + `Compositor`) built for two targets; (b) the native GPU
  transition test added this pass; (c) the exact-multiplier opacity/keyframe pixel checks
  above.

  **Deferred on the wasm path (explicitly, per the P2 scope allowances):**
  - Pack (`.cube`) LUTs — need filesystem loads; `render` passes an empty pack slice and
    pack-LUT effect instances are skipped. (Wire-up path: JS fetches pack bytes and hands
    them over; `packs`' pure `CubeLut` upload helpers already compile on wasm32.)
  - Raster / `Generated` mattes (`image::open`) — masks of those kinds are dropped before
    composite (`Luma` in-memory mattes DO work). Background removal likewise (needs CPU
    frame access).
  - Captions burn-in (P3 per the phase plan), audio (stays on the backend/rodio path).
  - Images in the harness: the sample logo isn't mapped to a real file by the mock, so the
    `HTMLImageElement` code path in `render` is written but not pixel-verified.
  - ~~Same-media transitions~~ — FIXED (2026-07-18): both sides of a transition between two
    clips of the SAME media item used to share one `<video>` element, so `manageElements`
    drift-corrected it to two different source times every frame (seek thrash), its
    `seeking`/`readyState` gate never settled, and `compositor.rs::render` dropped the layer
    on both sides — a black transition window. Now the JS engine lazily allocates a second
    pooled `<video>` (`secondaryVideoPool`) for the incoming side whenever it detects the
    same-media collision, keyed into `render(t, sources)`'s `sources` object as
    `"<media_id>#incoming"`; `compositor.rs`'s `resolve_layer_source` tries that key first
    for the incoming side of a transition and falls back to the plain media-id key, so
    different-media transitions are unaffected. Regression covered by the harness sample
    project's `c-round1a`/`c-round1b` split-clip crossfade (same `m-round1` media).
  - Production (`vite build`) bundles do NOT include the wasm pkg (the dynamic import
    specifier is invisible to the bundler on purpose, so builds stay green with the
    gitignored pkg absent — verified both with and without the pkg on disk). Dev mode
    (Tauri dev server, harness) gets the GPU path; release builds fall back to Canvas2D
    until P3 makes the wasm path the shipped default and bundles the pkg properly.
- **P3 — Audio + full switchover.** WebAudio mixing (or keep backend audio if simpler),
  captions burn-in via the same WGSL text path, remove `set_preview_bounds`/child-window
  sync from the hot path, default the flag on.
- **P4 — Deletion.** Remove `preview/{win32,macos,linux,stub}.rs`, `present_rgba`, and the
  bounds-sync effect; simplify `playback.rs` to export/scrub-server duties.

## Risks

- **WebKitGTK (Linux)**: WebGPU/WebCodecs lag Chromium. Mitigation: WebGL2 fallback for the
  compositor's final blit is not acceptable for effects parity — instead keep the native
  fallback alive on Linux until WebKitGTK ships WebGPU, or bundle a Chromium-based webview.
- **wasm32 build of wgpu/compose**: naga/WebGPU limits (no `Rgba8UnormSrgb` storage, texture
  limits). Mitigation: the compositor already targets downlevel wgpu; CI adds a
  `cargo check --target wasm32-unknown-unknown -p renderly-core --features wasm-compositor`.
- **Memory**: VideoFrames must be `close()`d promptly; leak = decoder stall. Enforce in the
  player abstraction, not call sites.

## QA gate (flip default / delete native)

The existing `docs/qa-checklist.md` preview section, plus: 4K60 source on the dogfood
machine, 3 simultaneous video tracks + 2 effects at 60fps, scrub-storm test (drag the
playhead for 10s), export pixel-parity suite green.
