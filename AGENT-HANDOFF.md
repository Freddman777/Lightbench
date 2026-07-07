# Agent Hand-off — The Light Bench

**You are continuing work on "The Light Bench," a single-page miniature-painting teaching tool (React → one self-contained HTML file, installable as a PWA).** Read this whole sheet before editing anything. The rules below exist because breaking them has already caused real problems. If you only read one section, read **Build pipeline** and **Collaboration protocol**.

> History note: the app was rehauled from a 2D orthographic "sheet view" (four blocky models × five SVG views) to a true 3D renderer. If you find references to `FigureView`, `<polygon>` counts, `mirrorPoly`, or bust/standing/gun/dual sheet models anywhere, they describe the pre-rehaul app and are stale.

---

## Hard rules (do not violate)
- **Source of truth is the React file `light-bench.jsx`. The `.html` is a BUILD ARTIFACT.** Never hand-edit the minified `.html`. Edit the `.jsx`, run `npm run build`.
- **One change at a time. Verify before shipping** (see Verify). Don't batch unrelated changes.
- **Don't add libraries** beyond what's already bundled (React, react-dom, lucide-react). No CDN runtime deps — the output must run offline by double-click.
- **The teaching focus is light on planes.** Features must serve reading value/color under a light, not turn the app into a generic model viewer.

---

## What it is (mental model)
Everything runs off ONE engine: a 3D light vector is dotted against a per-face **surface normal** to get a brightness `b`, which buckets into a **value tier**, which maps to a **color**. Every feature is a lens on that one model:
- **Light** sets the vector (orbit + height + intensity, with a Light-direction on/off toggle — off renders a "flat scheme" of base colors under a neutral viewing light). **Recipe** sets the colors of the tiers. **Wheel** visualizes/suggests colors. **Sequencer (Steps)** isolates tiers as paint steps. **Glaze** re-composites a wash over the paint. **Method** (brush/airbrush) reshapes the step text. **Spray cone** reframes the light vector as a nozzle and renders paint *coverage* instead of value. **Glow (OSL)** and **Rim light** add second, colored lights on top.
- **Two models:** `male` — a real scan decimated to ~2.8k faces (`decimate.mjs` → `male-mesh.js`, bundled via import; never hand-edit `male-mesh.js`) — and `custom`, the user's imported STL/OBJ. There is no landing chooser; the app opens straight onto the study figure.
- **Two renderers, one engine:** `ModelGL` (WebGL2, the default — handles up to ~500k-face "Full" imports) and `Model3DCanvas` (dependency-free canvas software renderer: project → backface-cull → painter's-sort → flat-shade). `Model3D` picks GL and falls back to canvas on init failure or `webglcontextlost`. Typed "Full" meshes are decimated via `typedMeshForCanvas` before the canvas fallback renders them (zone assignments don't survive that decimation, by design).
- **Zones/materials:** every face can be assigned to a material zone (Main + up to 3 extras), painted directly on the model (patch-click or brush, with mirror + stroke undo). Each zone has its own ramp; the matte/steel/gold toggle swaps a zone to NMM metal shading. Zone data lives in flat per-face `Uint8Array`s (`zoneArrs` ref) with a sparse-object form for persistence.

---

## Coordinate + math conventions (get these exactly right)
- **World axes:** `+z` = front, `+x` = the figure's left side, `+y` = up. Imports are auto-stood-up (z-up → y-up) and scaled to croquis height by `normalizeVerts`/`normalizeTypedPos`.
- **Light vector:** `L = [cos(el)·sin(az), sin(el), cos(el)·cos(az)]` (az 0=front, 90=+x, 180=back, 270=right; el 90=zenithal).
- **Brightness:** `b = 0.05·ao + 0.95·intensity·smoothstep(-0.3, 1, dot(n, L))·(0.5 + 0.5·ao)` — Lambert + ambient floor, scaled by the Intensity slider, with per-face AO darkening recesses. Tier = `clamp(round(b · (numSteps-1)), 0, numSteps-1)` (round-to-nearest, NOT floor — floor biased every facet down a band).
- **Spray coverage** (airbrush): `cov = smoothstep(edge, edge+soft, dot(n,L))` with `edge = -0.15 + focus·0.85`, `soft = 0.6 − focus·0.48`. Crucially **NO ambient floor** — planes facing away render bare primer `#33322d`.
- **Glow (OSL) & Rim:** each reuses a second light vector; `glow = int · smoothstep(0,1, dot(n, L2))`, applied **additively in sRGB** to the final fill (brightens and tints). Rim is just a second orb, tinted cool by default.
- **Glaze:** composites over the *actual paint fill* (ramp/NMM color — grey only on the zenithal step): `fill = mix(fill, layer.color, clamp(opacity·(1 − pooling·b), 0, 1))` per layer, in order — thin on highlights, pooling in shadow. The UI edits up to 5 layers (color + strength each, add/remove) plus a Recess-pooling slider; the engine and recipe format support up to 8 layers (the GL uniform array is the hard cap).
- **Color space:** ALL color blends (`mix()` in JS, `mixl()`/`s2l`/`l2s` in GLSL) happen in **linear light** with exact Rec.709 transfer functions, in BOTH renderers. This is deliberate — sRGB lerps muddy exactly the glaze regime. If you add a blend, do it in linear in both places. (Orb/rim addition is the one intentional sRGB-additive operation, identical in both.)
- **Color wheel — three things must share ONE angle convention** (this was a real bug): background `conic-gradient(from 90deg, …)`; plot `phi=(h+90)°, x=C+r·sin(phi), y=C−r·cos(phi)`; click `h = atan2(dx, −dy)·180/π − 90`. The **radial axis** must match too: dots and clicks both map saturation against `ringR` (100), not the container radius `C` (110) — this was also a real bug. Clicks also hit-test accent dots (≤11 units) before falling through to base-hue picking.
- **Ramp:** perceptually even CIE-L* spacing; highlights step lighter AND warmer (hue toward ~52°, capped); shadows darker AND cooler (toward ~250°).

---

## Build pipeline
Fully automated: **`npm install && npm run build`** (runs `build.mjs`). What it does:
1. Copies `light-bench.jsx` → `browser.jsx`: swaps `window.storage` for a `localStorage`-backed shim (same async get/set/list/delete API), prepends the react-dom import, appends the `createRoot(...).render(...)` mount. (Why: `window.storage` is the Claude-artifact API the file originally targeted; the browser build uses localStorage.)
2. esbuild-bundles it (`--minify --format=iife`, jsx loader) → `app.js`.
3. Tailwind v3 (`content: ["./light-bench.jsx", "./browser.jsx"]`) → `styles.css`. **Arbitrary classes (`max-h-[42vh]`, `top-[env(safe-area-inset-top,0px)]`) only work if they appear literally in the scanned files — check the generated CSS after adding one.**
4. Assembles `index.html`: one file with inlined CSS + JS, plus PWA head tags (manifest link, theme-color, icons, iOS meta) and a **guarded** service-worker registration (`location.protocol` check), so double-clicking `index.html` still works fully offline with no server.
5. Generates `sw.js`: precache + stale-while-revalidate; the cache name embeds a hash of the built HTML, so every rebuild ships as a new version and old caches are dropped on activate.
- Result ≈ 370 KB `index.html`, self-contained. **PWA deploy set:** `index.html` + `manifest.json` + `sw.js` + `icons/` hosted together over HTTPS (GitHub Pages works). Static PWA files (`manifest.json`, `icons/` incl. SVG sources) live in the repo; `app.js`/`styles.css`/`browser.jsx`/`node_modules` are git-ignored; `index.html` and `sw.js` are committed build artifacts.
- `decimate.mjs` (dense OBJ → `male-mesh.js`) is an offline one-shot tool with a **hardcoded source path** (`~/Downloads/Male.OBJ`, not in the repo). It is not part of the build; treat `male-mesh.js` as a checked-in asset.

---

## Verify (before handing back)
- Parse-check: `npx esbuild light-bench.jsx --loader:.jsx=jsx --bundle --external:react --external:react-dom --external:lucide-react --outfile=/dev/null` must exit 0, then `npm run build` must succeed.
- **Commit the rebuilt `index.html` + `sw.js` with every source change** — CI (`.github/workflows/build.yml`) rebuilds and fails the push if the committed artifacts don't match the source.
- Rendering is `<canvas>`/WebGL2 — **there are no `<polygon>` elements and jsdom can't run WebGL2**, so headless DOM checks only get you: app mounts, sections/buttons exist, Tailwind classes you added appear in the generated CSS. Don't substring-check `body.textContent` (it includes the bundled script source); query real elements.
- Real verification needs a browser: load the built file, check the console is clean, exercise the changed feature, and check both renderers if you touched shading (toggle GL off by blocking webgl2, or trust the shared-constant discipline). You cannot verify visual shading headlessly — say so plainly and ask the user to eyeball it.

---

## Persistence map
- **Recipes** (`recipe:<name>` in storage): the full color/light/glaze/method/spray/orb/rim/zenithal/primer/flat-mode scheme + `extraZones` + `mainMetal`. Deliberately model-independent — NO `model`, NO face assignments. `applyRecipe` sanitizes every field (it is the shared crash-proofing for recipe-load AND session-restore — keep it that way) and unassigns faces pointing at zones the recipe doesn't have.
- **Session** (`session:last`, debounced): everything recipes save plus `model`, `activeStage`, `smoothShade`, `paintBrand`, `zoneMap3d` (sparse per-model face→zone maps), `openSec`, `brushSize`, `mirrorOn`. Restored on load; restoring `zoneMap3d` must invalidate `zoneArrs` caches (a zeroed array gets cached on first render before restore runs — this was a real bug).
- **IndexedDB** (`lightbench/kv`): imported meshes (`custommesh`) and big custom-model zone arrays (`customzones`) — too large for localStorage.
- **Recipe export/import**: Recipes section has JSON file export/import (merge semantics) for moving recipes between devices/browsers.

---

## Gotchas
- **Two renderers must not drift.** Any shading change lands in three places: JS engine functions, `Model3DCanvas`, and the `GL_FRAG` shader (+ uniforms). The GLSL mirrors the JS constants exactly (brightness, tiering, spray, NMM palettes, glaze, linear-light mixing) — grep for the constant you're changing and update every copy.
- **Export PNG** draws a 740-wide reference card on an offscreen canvas — `cv.width` AND `cv.height` must both be set (width was once forgotten; every export shipped clipped for a while). On touch devices it goes through the Web Share sheet (`COARSE` flag); desktop keeps the `<a download>`.
- **Pointer handling** on the model canvases: one finger rotates (rAF-coalesced), two fingers pinch-zoom (`touches` Map), shift/middle-drag pans (GL only), wheel zooms (non-passive listener — **rebind on mesh remount or scroll-zoom dies after an import**), zone-paint mode turns pointer input into patch-click/brush strokes. Both canvases and the color wheel are also keyboard-operable (focusable; arrows rotate/steer, +/- zoom). Canvas has `touch-none`; the global Ctrl+Z zone-undo must skip text inputs.
- **Light-direction marker** (amber ping on the brightest visible facet): the canvas renderer draws it into the 2D context; `ModelGL` computes it on the CPU (stride-sampled argmax over face normals, projected with the same math as `GL_VERT`) and positions a DOM overlay. If you change the projection or brightness, update both.
- **`meshKey` remounts the GL canvas per mesh** (a lost/reused context can't be revived on the same element). Mid-session context loss is also handled (`webglcontextlost` → canvas fallback).
- **STL/OBJ import:** binary STL detection is `84 + n·50 <= bytes.length` (some exporters append trailing bytes); OBJ supports negative (relative) indices. Detail picker: Standard/High/Ultra decimate to 3.4k/8k/14k faces (indexed, canvas-friendly); **Full** keeps up to ~500k as typed arrays, GPU-only. Bad files must fail with a readable `importMsg`, never a crash, and must not clobber the previous model.
- **Steps sequencer:** `buildStages(numSteps, method, zenithal, lit)` — steps are conditional (Zenithal is opt-in; Shade/Highlights only exist when the light is on; 5-step ramps add Edge). If `activeStage` no longer exists after a config change, the app lands on the first *paint* stage and syncs state (don't silently fall to Prime). Prime uses a user-pickable `primerColor`, not fixed black.
- **Spray** is force-disabled when method ≠ airbrush (recipe load sanitizes this too) so it can never be stranded on with its section hidden.
- **Real paints:** `paint-data.js` (~1000 paints, Citadel/Vallejo/Army Painter) with ΔE nearest-match. Brand names in data/UI are an accepted product decision (the old "no brand names" rule is dead). Note `nearestPaint` breaks exact-ΔE ties by array order.
- **Value study** button = greyscale by exact Rec.709 relative luminance (both renderers), not HSL lightness.
- The model pane is sticky with a `42vh` cap on mobile (`lg:` restores the two-column desktop layout); mobile-only styling goes through `sm:`/`lg:` variants, `@media (pointer:coarse)`, or `env(safe-area-inset-*)` so desktop is never affected.

---

## Collaboration protocol (prevents diverging copies)
- **Start from the latest file.** Ask which file is current before editing.
- **Make changes in the source, rebuild, ship the rebuilt artifacts.** Keep the updated `.jsx` as the new source of truth.
- **Never edit the built HTML in parallel** with another person. If the only thing you were given is an edited `.html`, do NOT blindly rebuild over it — diff it against the prior build to recover hand-made changes, then port them into the source. (This has happened; recovering minified edits is painful.)
- **Keep this file honest.** The pre-rehaul version of this handoff described an app that no longer existed and cost real time. If your change invalidates a rule, formula, or file listed here, update this sheet in the same commit.
- When done, tell the user exactly what changed and what you could NOT verify (e.g. visual shading, real-device touch).
