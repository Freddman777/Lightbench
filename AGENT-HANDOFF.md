# Agent Hand-off — The Light Bench

**You are continuing work on "The Light Bench," a single-file HTML miniature-painting teaching tool.** Read this whole sheet before editing anything. The rules below exist because breaking them has already caused real problems. If you only read one section, read **Build pipeline** and **Collaboration protocol**.

---

## Hard rules (do not violate)
- **Source of truth is the React file `light-bench.jsx`. The `.html` is a BUILD ARTIFACT.** Never hand-edit the minified `.html`. Edit the `.jsx`, then rebuild.
- **Deliverable is the `.html` only.** Build it from the source; don't ship the `.jsx` to the user.
- **One change at a time. Verify before shipping** (see Verify). Don't batch unrelated changes.
- **No paint brand names** anywhere in the app — generic colors plus a color picker only.
- **Figures stay blocky and generic.** This is a teaching tool about light on planes, not a portrait of a specific model.
- **Don't add libraries** beyond what's already bundled (React, react-dom, lucide-react). No CDN runtime deps — the output must run offline by double-click.

---

## What it is (mental model)
Everything runs off ONE engine: a 3D light vector is dotted against a per-plane **surface normal** to get a brightness `b`, which buckets into a **value tier**, which maps to a **color**. Every feature is a lens on that one model:
- **Light** sets the vector (orbit + height). **Recipe** sets the colors of the tiers. **Wheel** visualizes/suggests colors. **Sequencer** isolates tiers as paint steps. **Glaze** re-composites the tiers as transparent layers. **Method** (brush/airbrush) reshapes the step text. **Spray cone** reframes the same light vector as a nozzle and renders paint *coverage* instead of value. **Glow source** adds a second, colored object light (OSL) on top of everything.
- Four **sheet models** (`bust`, `standing`, `gun`, `dual`), each with five views: `front`, `left`, `right`, `back`, `top`. Each view is an array of `{ p: "x,y x,y …", n: [x,y,z], ao? }` polygons (optional per-plane `ao` 0..1 darkens recesses). Plus a fifth **`male` "3D view"** model: a real scan decimated to ~2.8k faces (see `decimate.mjs` → `male-mesh.js`), rendered as a rotatable `<canvas>` by `Model3D` (no orthographic sheet; `only3d: true`). All the same engine/lenses apply to it.

---

## Coordinate + math conventions (get these exactly right)
- **World axes:** `+z` = front (toward front-view camera), `+x` = the figure's "left-view" side, `+y` = up. Front-view normals are +z-dominant, back −z, left +x, right −x; all top planes carry +y.
- **Right view is derived:** `GUN_RIGHT = GUN_LEFT.map(r => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], r.n[2]] }))`. Draw LEFT correctly; right mirrors automatically (a true opposite-side view).
- **A back view can be derived from its front** the same way, but mirror AND flip front/back: `DUAL_BACK = DUAL_FRONT.map(r => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], -r.n[2]] }))`. This swaps left/right (held items, bent knee) and darkens for rear lighting — use it so front and back can't drift apart. (`mirrorPoly` assumes width 200; top views are 220-wide and are NOT mirrored this way.)
- **Light vector:** `L = [cos(el)·sin(az), sin(el), cos(el)·cos(az)]` (az,el in radians; az 0=front, 90=+x/left, 180=back, 270=right; el 90=straight up/zenithal).
- **Brightness:** `b = 0.05·ao + 0.95·smoothstep(-0.3, 1, dot(normal, L))·(0.5 + 0.5·ao)` — Lambert + ambient floor, with an optional per-region `ao` (0..1, default 1) that darkens recesses regardless of light angle. Tier = `clamp(round(b · (numSteps-1)), 0, numSteps-1)` — round-to-nearest gives centered, evenly-spaced value buckets (was `floor(b·numSteps)`, which biased every facet down a band).
- **Spray coverage** (airbrush mode reuses the light vector as the nozzle aim): `cov = smoothstep(edge, edge+soft, dot(n,L))` with `edge = -0.15 + focus·0.85`, `soft = 0.6 − focus·0.48` (focus 0 = wide/feathered, 1 = tight). Crucially there is **NO ambient floor** — planes facing away get `cov=0` and render as bare primer. FigureView paints `mix("#33322d", sprayColor, cov)` when `sprayOn`; `sprayColor` is the active step's tier color.
- **Object-source glow** (the light orb) reuses a *second* light vector `Lorb = lightVector(orbAz, orbEl)`: `glow = orbInt · smoothstep(0,1, dot(n, Lorb))`; if `glow<=0` the plane is untouched, else each channel = `clamp(fillCh + orbColorCh·glow, 0, 255)` (additive — it brightens AND tints). Applied to the final fill when `orbOn && !sprayOn`, in both `FigureView` and the 3D `Model3D`.
- **Color wheel — three things must share ONE angle convention** (this was a real bug): background is `conic-gradient(from 90deg, …)`. Plot: `phi=(h+90)°; x=C+r·sin(phi); y=C−r·cos(phi)`. Click: `h = atan2(dx, −dy)·180/π − 90`. A dot must sit on its own background color and a click must return that hue.
- **Glaze compositing:** each plane starts from a grey value underpainting `valueGrey(b)`, then each layer composites over it; layer's effective opacity = `opacity · (1 − pooling·b)` (thin on highlights `b`→1, full in shadow `b`→0). Color-agnostic; same math for any color.
- **Ramp:** highlights step lighter AND warmer (hue toward ~52°); shadow steps darker AND cooler (hue toward ~250°).

---

## Build pipeline (run after every source edit)
1. Edit `light-bench.jsx`.
2. Make `browser.jsx`: copy the source, then (a) replace `window.storage` → `store` and inject a `localStorage`-backed `store` shim with the same async `get/set/list/delete` API, (b) prepend `import { createRoot } from "react-dom/client";`, (c) append `createRoot(document.getElementById("root")).render(React.createElement(App));`.
3. Bundle: `npx esbuild browser.jsx --bundle --loader:.jsx=jsx --format=iife --minify --define:process.env.NODE_ENV='"production"' --outfile=app.js`
4. CSS: `npx tailwindcss -i input.css -o styles.css --minify` (tailwind v3; config `content: ["./browser.jsx"]`; `input.css` has the three `@tailwind` directives).
5. Assemble `index.html`: one file with `<style>{styles.css + extras}</style>`, `<div id="root">`, `<script>{app.js}</script>`. Extras include body bg `#141611`, range height, and the `.controls-scroll` thin-scrollbar rules.
- Result ≈ 250 KB, fully self-contained, no network.
- **Why the storage swap:** `localStorage` is blocked inside the Claude artifact renderer but works in a standalone browser file (what we ship), so the browser build uses it.
6. **PWA (installable app):** the build also injects a `<link rel="manifest">`, theme-color/apple meta tags, and a service-worker registration into `index.html`, and generates `sw.js` (precache + stale-while-revalidate; cache name carries a hash of the built HTML so every rebuild ships as a new version). Static PWA files live in the repo: `manifest.json` and `icons/` (PNGs rendered from `icons/icon.svg` / `icons/maskable.svg` via `rsvg-convert`). The SW registration is guarded by a `location.protocol` check, so **double-clicking `index.html` still works exactly as before** — install/offline only activates when the folder is hosted over HTTPS (or localhost). To ship the PWA, host `index.html` + `manifest.json` + `sw.js` + `icons/` together; the single-file `.html` deliverable is unchanged for everyone else.

---

## Verify (before handing back)
- Parse-check the source: `esbuild … --outfile=/dev/null` must exit 0.
- Headless render with **jsdom** (`runScripts: "dangerously"`, set a `url:` so localStorage works): confirm no window errors, `polygon` count is sane (≈100+ once a model is selected), the chooser shows all four models, clicking one enters the app, `.controls-scroll` exists, and arbitrary Tailwind values you added (e.g. `max-h-[27vh]`) actually appear in the generated CSS.
- **jsdom gotcha that wasted real time:** `document.body.textContent` includes the bundled `<script>` source, so substring checks for UI strings match the code, not the rendered DOM. Verify presence/visibility via real elements (query a button/section node), and verify rendering changes via `<polygon>` `fill` attributes — never via `body.textContent.includes(...)`.
- You cannot verify visual layout in jsdom. For figure-shape changes, say so plainly and ask the user to eyeball the result.

---

## Gotchas
- Adding arbitrary Tailwind classes (`lg:max-h-[27vh]`, `text-[11px]`, etc.) only works if they appear literally in `browser.jsx` so the content scan emits them. Check the CSS after building.
- The model pane uses **vh height caps** (`svgExtra="lg:max-h-[27vh]"` on side views, `lg:max-h-[15vh]` on top) so all five views fit the viewport without zoom; it also has `lg:overflow-y-auto` as a scroll fallback. Mobile (no `lg:`) keeps natural `w-full h-auto` stacking.
- Glaze only affects `paint`-mode sequencer steps; Prime stays black, Zenithal stays grey (they precede any glaze). A "· glaze" tag shows when active.
- **Method** is a header toggle (`brush`/`airbrush`). `buildStages(n, method)` swaps each step's `note`/`watch` text but keeps the same `id`/`mode`/`iso` (so isolation rendering is identical). The **Spray cone** section is gated by `method === "airbrush"` and only then can spray coverage be turned on. State `method`, `spray`, `focus` all persist in saved recipes.
- Recipes (saved via storage) are model-independent on purpose — a scheme loads onto any figure. Don't couple them to the selected model.
- **Glow source / OSL** is its own Section with state `orbOn`/`orbAz`/`orbEl`/`orbColor`/`orbInt` (all persisted in recipes + the session). It's available on every model (incl. the 3D figure). NOTE: the upstream "light orb" commit shipped this **only in the minified `index.html`** — the `.jsx` was never updated. It was reverse-engineered from the bundle back into the source (the source of truth) and `index.html` rebuilt from it. Lesson stands: edit `.jsx`, never the artifact.
- **3D view & canvas renderer:** `Model3D` is a dependency-free `<canvas>` software renderer (project → backface-cull → painter's-sort → flat-shade each face by the same engine, incl. spray coverage). The `male` model's mesh is built from `male-mesh.js` (generated offline by `decimate.mjs` from a dense OBJ — never hand-edit `male-mesh.js`). `male-mesh.js` is bundled via an `import` in the source, so esbuild inlines it. Build artifacts (`app.js`, `styles.css`, `browser.jsx`) and `node_modules/` are git-ignored.
- **Extra lenses (local):** **Value study** (greyscale-by-luminance squint test), the **light-direction marker** (amber glow on the brightest facet), and **Export PNG** (a reference card to `<canvas>.toDataURL`). The **last session** (model + recipe/light/glaze/method) auto-saves to `localStorage` (`session:last`) and restores on load — separate from named recipes.

---

## Collaboration protocol (prevents diverging copies)
- **Start from the latest file.** Ask which file is current before editing.
- **Make changes in the source, rebuild, hand the rebuilt `.html` back.** Keep the updated `.jsx` as the new source of truth.
- **Never edit the built HTML in parallel** with another person. If the only thing you were given is an edited `.html`, do NOT blindly rebuild over it — first diff it against the prior build to recover any hand-made changes, then port them into the source. (This has happened; recovering minified edits is painful.)
- When done, tell the user exactly what changed and what you could NOT verify (e.g. visual fit, figure shapes).
