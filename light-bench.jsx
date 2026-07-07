import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Sun, Save, Trash2, RotateCcw, Plus, Check, Lightbulb, Layers, Palette, Droplets, Download, Upload } from "lucide-react";
import { MALE_VERTS, MALE_FACES } from "./male-mesh.js"; // decimated scan (built by decimate.mjs)
import { PAINTS, PAINT_BRANDS } from "./paint-data.js"; // opaque hobby paints (auto-generated; MIT source data)

/* ============================== COLOR MATH ============================== */
function hexToHsl(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let hue = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: hue = (g - b) / d + (g < b ? 6 : 0); break;
      case g: hue = (b - r) / d + 2; break;
      default: hue = (r - g) / d + 4;
    }
    hue *= 60;
  }
  return { h: hue, s: s * 100, l: l * 100 };
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}
// sRGB <-> linear-light, so blends mix actual light rather than gamma-encoded bytes.
// (A gamma-naive lerp darkens/muddies the midpoint of two distant hues — the exact
// regime glazing lives in. Rec.709 transfer functions, the standard.)
const srgbToLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const linearToSrgb = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
function mix(hexA, hexB, t) {
  const a = hexA.replace("#", ""), b = hexB.replace("#", "");
  const ai = [0, 2, 4].map((i) => parseInt(a.slice(i, i + 2), 16));
  const bi = [0, 2, 4].map((i) => parseInt(b.slice(i, i + 2), 16));
  const m = ai.map((v, i) => {
    const lin = srgbToLinear(v) + (srgbToLinear(bi[i]) - srgbToLinear(v)) * t;
    return Math.round(clamp(linearToSrgb(lin), 0, 255));
  });
  return "#" + m.map((v) => v.toString(16).padStart(2, "0")).join("");
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Touch-first device? (guarded: jsdom used by the verify step has no matchMedia)
const COARSE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const clamp01 = (v) => clamp(v, 0, 1);
function smoothstep(e0, e1, x) { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }

/* ============================== RAMP ============================== */
function tierMeta(n) {
  const m = {
    3: [["shadow", "Shadow"], ["base", "Base"], ["top", "Highlight"]],
    4: [["shadow", "Shadow"], ["base", "Base"], ["mid", "Midtone"], ["top", "Highlight"]],
    5: [["shadow", "Shadow"], ["base", "Base"], ["mid", "Midtone"], ["top", "Highlight"], ["edge", "Edge"]],
  };
  return (m[n] || m[5]).map(([key, label]) => ({ key, label })); // fall back to 5 for bad n
}
// Find the HSL lightness that lands a color at a target CIE L* — HSL lightness itself
// is not perceptually even, so we search instead of guessing.
function hslLForLab(h, s, targetL) {
  let lo = 0, hi = 100;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (hexToLab(hslToHex(h, s, mid))[0] < targetL) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
// Hue shift with an absolute cap: a constant fraction would swing a blue base 80°
// toward green while barely moving a red one — temperature shifts should be gentle for everyone.
function shiftHue(h, target, t, maxDeg) {
  let d = (((target - h) % 360) + 540) % 360 - 180;
  d = clamp(d * t, -maxDeg, maxDeg);
  return ((h + d) % 360 + 360) % 360;
}
function generateRamp(baseHex, n) {
  const { h, s } = hexToHsl(baseHex);
  const Lb = hexToLab(baseHex)[0];
  // Even perceptual (CIE L*) spacing across the whole ramp — a value ramp's entire job.
  // Hue cools toward blue in shadow and warms toward yellow in the lights (capped);
  // shadows gain a little saturation, highlights shed some.
  const step = clamp((92 - Lb) / (n - 2), 9, 17);
  // a very light base has no headroom above — give that contrast to the shadow instead
  const deficit = Math.max(0, step * (n - 2) - Math.max(0, 96 - Lb));
  const out = new Array(n);
  out[1] = baseHex;
  {
    const nh = shiftHue(h, 250, 0.22, 30), ns = clamp(s + 7, 0, 100);
    out[0] = hslToHex(nh, ns, hslLForLab(nh, ns, Math.max(8, Lb - step - deficit * 0.6)));
  }
  for (let i = 2; i < n; i++) {
    const frac = (i - 1) / (n - 2);
    const nh = shiftHue(h, 52, 0.12 + 0.34 * frac, 35);
    const ns = clamp(s - s * 0.32 * frac, 0, 100);
    const target = Math.min(96 - (n - 1 - i) * 2, Lb + step * (i - 1)); // cap near white, keep tiers separated
    out[i] = hslToHex(nh, ns, hslLForLab(nh, ns, target));
  }
  return out;
}

/* ============================== GLAZE ==============================
   Each plane starts from a greyscale value underpainting (the zenithal),
   then each glaze layer composites over it. A layer's *effective* opacity
   thins on the highlights and builds in the recesses (pooling), which is
   what lets the underlayer show through in shadow — real glaze behavior. */
function valueGrey(b) { return hslToHex(40, 4, 12 + b * 78); }
// Perceptual value of a color: Rec.709 luminance on linearized channels, shown as a neutral
// grey of matching luminance. (HSL "lightness" misranks saturated hues — a bright yellow reads
// high-value, a deep blue low — so this is the squint/value-study check painters actually use.)
function relLuminance(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function valueGreyOf(hex) {
  const v = Math.round(clamp(linearToSrgb(relLuminance(hex)), 0, 255)).toString(16).padStart(2, "0");
  return "#" + v + v + v;
}
/* ---- NMM (non-metallic metal): matte paint imitating metal. Metals compress the
        midtones, spike a near-white specular ping, and reflect their environment —
        sky tone on planes that face up, ground tone on planes that face down. ---- */
const NMM_PALETTES = {
  steel: { lo: "#14171d", mid: "#4a5666", hi: "#a8b8cc", spark: "#f4f8ff", sky: "#c2d8ea", earth: "#2e2b26" },
  gold:  { lo: "#2a1a0a", mid: "#8a5a1a", hi: "#e8b84a", spark: "#fff6d8", sky: "#ffedb0", earth: "#4a2e12" },
};
function nmmColor(kind, b, n) {
  const P = NMM_PALETTES[kind] || NMM_PALETTES.steel;
  const t = smoothstep(0.2, 0.9, b); // steeper curve than matte paint = metallic contrast
  let c = t < 0.5 ? mix(P.lo, P.mid, t * 2) : mix(P.mid, P.hi, (t - 0.5) * 2);
  if (b > 0.88) c = mix(c, P.spark, smoothstep(0.88, 0.98, b)); // specular ping
  if (n[1] > 0) c = mix(c, P.sky, n[1] * 0.35);       // up-facing planes catch the sky
  else c = mix(c, P.earth, -n[1] * 0.45);             // down-facing planes reflect the ground
  return c;
}
// A representative swatch ramp for the UI / paint matching (neutral forward normal).
const nmmRamp = (kind, n) => Array.from({ length: n }, (_, i) => nmmColor(kind, 0.05 + (n === 1 ? 0.45 : (i / (n - 1)) * 0.9), [0, 0, 1]));

/* ---- Real-paint matching: hex -> CIELAB -> nearest paint by colour distance (ΔE). ---- */
function hexToLab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { c /= 255; return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : t * 7.787 + 16 / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
let PAINT_LABS = null; // Lab for every paint, computed once on first use
function nearestPaint(hex, brand) { // brand: "C" | "V" | "A" | "" (any)
  if (!PAINT_LABS) PAINT_LABS = PAINTS.map((p) => hexToLab(p[2]));
  const t = hexToLab(hex);
  let best = null, bestD = Infinity;
  for (let i = 0; i < PAINTS.length; i++) {
    if (brand && PAINTS[i][0] !== brand) continue;
    const l = PAINT_LABS[i];
    const d = (t[0] - l[0]) * (t[0] - l[0]) + (t[1] - l[1]) * (t[1] - l[1]) + (t[2] - l[2]) * (t[2] - l[2]);
    if (d < bestD) { bestD = d; best = PAINTS[i]; }
  }
  return best && { brand: best[0], name: best[1], hex: best[2], dE: Math.sqrt(bestD) };
}
const matchQuality = (dE) => (dE < 5 ? "spot on" : dE < 12 ? "close" : "mix to match");

const MODELS = {
  male: { label: "3D figure", blurb: "A realistic figure you rotate in 3D — drag to read light across real anatomy.", only3d: true },
  custom: { label: "Imported model", blurb: "Your own STL or OBJ, simplified so the planes read clearly.", only3d: true, custom: true },
};

/* ============================== LIGHTING ============================== */
function lightVector(azDeg, elDeg) {
  const a = (azDeg * Math.PI) / 180, e = (elDeg * Math.PI) / 180;
  const ce = Math.cos(e);
  return [ce * Math.sin(a), Math.sin(e), ce * Math.cos(a)];
}
function brightness(normal, L, ao = 1, intensity = 1) {
  const d = normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2];
  // ambient floor + directional, then ambient occlusion: a recessed plane (ao→0) loses
  // its ambient/bounce light fully and part of the direct light, so valleys read dark
  // regardless of how they happen to face the light — "shadow gathers in the recesses".
  return 0.05 * ao + 0.95 * intensity * smoothstep(-0.3, 1, d) * (0.5 + 0.5 * ao);
}
// How much spray lands on a plane — airbrush mode reuses the light vector as the nozzle aim.
// No ambient floor: planes facing away get NO paint (stay bare primer), the lesson the soft
// light model hides. focus 0 = wide/feathered, 1 = tight.
function sprayCoverage(normal, L, focus) {
  const d = normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2];
  const edge = -0.15 + focus * 0.85, soft = 0.6 - focus * 0.48;
  return smoothstep(edge, edge + soft, d);
}
// Object-source lighting: a second colored light that ADDS its color onto planes facing it
// (planes facing away are untouched). glow = orbInt · smoothstep(0,1, dot(normal, orb)).
function orbGlow(fill, normal, Lorb, orbColor, orbInt) {
  const f = orbInt * smoothstep(0, 1, normal[0] * Lorb[0] + normal[1] * Lorb[1] + normal[2] * Lorb[2]);
  if (f <= 0) return fill;
  const a = fill.replace("#", ""), b = orbColor.replace("#", "");
  const ai = [0, 2, 4].map((i) => parseInt(a.slice(i, i + 2), 16));
  const bi = [0, 2, 4].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + ai.map((c, i) => clamp(Math.round(c + bi[i] * f), 0, 255).toString(16).padStart(2, "0")).join("");
}
// Round-to-nearest over [0,1] gives n centered, evenly-spaced value buckets (b=0 -> tier 0,
// b=1 -> top tier), which matches how a painter spaces N discrete values better than floor's
// downward bias (floor only enters a band once b passes its upper edge).
function tierIndex(b, n) { return clamp(Math.round(b * (n - 1)), 0, n - 1); }

/* ============================== SEQUENCER ============================== */
function buildStages(n, method = "brush", zenithal = false, lit = true) {
  const air = method === "airbrush"; // brush/airbrush swap the copy; id/mode/iso stay identical
  const has = (k) => lit && tierMeta(n).some((t) => t.key === k);
  const s = [
    { id: "prime", name: "Prime", mode: "prime", iso: null,
      note: air
        ? "Airbrush thinned primer in light passes at low pressure (~15–20 PSI). Any color works — dark primers forgive gaps and mute the scheme, light ones brighten it but show every miss."
        : "Thin, even coat of primer. Any color works — dark primers forgive gaps and mute the scheme, light ones brighten it but show every miss. Pick yours below to preview it.",
      watch: air
        ? "Too close or too wet and it pools and spiders. Back off to about a hand's width and build it in thin passes."
        : "Don't flood it. Heavy primer fills detail and hides the sculpt. Several light passes beat one wet one." },
  ];
  if (zenithal) s.push(
    { id: "zenithal", name: "Zenithal", mode: "zenithal", iso: null,
      note: air
        ? "Spray white from straight overhead in soft passes — pre-baking the light map, tops bright and undersides dark. This step was always an airbrush job."
        : "Spray white from straight above. You're pre-baking the light map — tops bright, undersides dark.",
      watch: air
        ? "Keep the nozzle strictly overhead. Drift to the side and your sprayed shading won't match where light actually falls."
        : "Keep the light strictly overhead. Angle it and your free shading no longer matches where light actually falls." });
  s.push(zenithal
    ? { id: "base", name: "Base coat", mode: "paint", iso: null,
        note: air
          ? "Thin each material's base to milk and lay angled passes from slightly above, letting the zenithal value glow through."
          : "Lay each material's midtone thin enough to let the zenithal value show through. This is the whole scheme before you isolate the lights and darks.",
        watch: air
          ? "Paint too thick or pressure too high goes chalky and buries the zenithal. Thin it more and build more passes."
          : "Opaque here buries the zenithal. If you go solid, you've signed up to rebuild all the shading by hand." }
    : { id: "base", name: "Base coats", mode: "paint", iso: null,
        note: air
          ? "Each material gets its flat base color — thin passes to solid, even coverage. Shield neighbouring materials from overspray."
          : "Each material gets its flat, solid base color — two or three thin coats, never one heavy one. Work inside-out and bottom-up: skin before the collar over it, under-layers before what overlaps them.",
        watch: "It will look flat and toy-like when every base is down. That's correct — depth comes from the next steps." });
  if (lit) s.push({ id: "shade", name: "Shade", mode: "paint", iso: "shadow",
      note: air
        ? "Drop the spray angle: thinned shadow color low and from the side, so the cone only catches the undersides and recesses."
        : "Push your shadow into the recesses — a thin all-over wash settles into them on its own, or glaze it in deliberately where you want more control.",
      watch: air
        ? "Spray straight-on and shadow lands everywhere. Lower the angle so the raised planes stay clean."
        : "Keep it in the valleys. Shadow creeping onto raised planes flattens the whole figure." });
  if (has("mid")) s.push({ id: "mid", name: "Midtone highlight", mode: "paint", iso: "mid",
    note: air
      ? "Raise the angle back toward overhead so only the broad upper faces catch the pass."
      : "First, broad highlight on the raised faces — layered and feathered, not a hard line (the edge step does the crisp lines). Pull it back off the recesses.",
    watch: air
      ? "Ease off the pressure and stay above — overspray drifting down flattens the highlight."
      : "This layer is broad. Resist going bright yet — that's the next step's job." });
  if (lit) s.push({ id: "top", name: "Highlight", mode: "paint", iso: "top",
    note: air
      ? "Steep, near-overhead passes with a thinned highlight mix — only the planes facing the light most directly."
      : "Brighter, warmer highlight on the top planes — only what faces the light most directly.",
    watch: air
      ? "Tip-dry spits speckles into a fine pass. Clear the needle, keep the mix thin, and feather from a touch farther back."
      : "Tight placement. A broad bright coat reads as 'repainted lighter', not 'lit'." });
  if (has("edge")) s.push({ id: "edge", name: "Edge highlight", mode: "paint", iso: "edge",
    note: air
      ? "Switch to a brush — an airbrush can't lay a razor edge. Hairline lines on the hardest edges catching the light."
      : "Brush only. Razor lines on the hardest edges catching the light.",
    watch: air
      ? "Airbrush down, fine brush up. Chasing edge lines with the airbrush just fogs the whole area."
      : "Hairline lines, brightest mix. If it looks chalky, thin it; if too stark, glaze the midtone back over." });
  s.push({ id: "details", name: "Details & accents", mode: "paint", iso: null,
    note: air
      ? "Brush work: eyes, teeth, scars, gems, metals, accents. The airbrush is parked for these."
      : "Eyes, teeth, scars, gems, metals. Drop your accent colors in here.",
    watch: "A complementary accent in a recess adds life — but one focal accent, not ten competing ones." });
  s.push({ id: "varnish", name: "Varnish", mode: "paint", iso: null,
    note: air
      ? "Airbrush an even, thin varnish — matte for skin and cloth, gloss for eyes, gems, and wet effects."
      : "Seal it. Matte for skin and cloth, gloss for eyes, gems, and wet effects.",
    watch: air
      ? "Varnish too close beads; on a humid day it clouds white. Thin coats, low pressure, dry room."
      : "Varnish on a humid day clouds white. Thin coats, dry room." });
  return s;
}

/* ============================== 3D MODEL (no libraries) ==============================
   A blocky figure is a list of quad faces in world space (+x right, +y up, +z front).
   The camera orbits (yaw/pitch from drag); the LIGHT stays in world space, so rotating
   walks you around a statically-lit figure. Same engine: each face's world normal is
   dotted with the light to pick a value tier — flat-shaded, so the planes stay legible. */
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v) => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; };
const faceNormal = (f) => norm3(cross3(sub3(f[1], f[0]), sub3(f[2], f[0])));
const centroid3 = (pts) => { const n = pts.length || 1; return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n, pts.reduce((s, p) => s + p[2], 0) / n]; };
const rotY = (p, c, s) => [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
const rotX = (p, c, s) => [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]];
// Cheap precomputed ambient occlusion: a face with lots of other geometry in front of it
// (a crevice — armpit, neck, between legs) gets a lower ao, so recesses read dark. One-time.
function computeAO(faces, norms) {
  const cents = faces.map(centroid3), R = 36;
  // Spatial hash (cell size R) so dense imported meshes don't pay the full O(n²):
  // only faces within R can occlude, and those all live in the 27 neighboring cells.
  const grid = new Map();
  cents.forEach((c, j) => {
    const k = Math.floor(c[0] / R) + "," + Math.floor(c[1] / R) + "," + Math.floor(c[2] / R);
    const b = grid.get(k); if (b) b.push(j); else grid.set(k, [j]);
  });
  return faces.map((f, i) => {
    let occ = 0;
    const ci = cents[i], gx = Math.floor(ci[0] / R), gy = Math.floor(ci[1] / R), gz = Math.floor(ci[2] / R);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get((gx + dx) + "," + (gy + dy) + "," + (gz + dz));
      if (!bucket) continue;
      for (const j of bucket) {
        if (j === i) continue;
        const dv = sub3(cents[j], ci), dist = Math.hypot(dv[0], dv[1], dv[2]);
        if (dist > R || dist < 0.5) continue;
        const facing = dot3(norm3(dv), norms[i]);
        if (facing > 0.15) occ += facing * (1 - dist / R);
      }
    }
    return clamp(1 - occ * 0.55, 0.42, 1);
  });
}
// Combine parts into a renderable mesh: faces + per-face AO + auto-fit center/radius.
function buildMesh(faces) {
  const all = faces.flat();
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of all) for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
  const center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2]; // bbox center frames better
  let radius = 1;
  for (const p of all) { const d = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]); if (d > radius) radius = d; }
  const normals = faces.map(faceNormal); // precomputed once — world normals never change per mesh
  return { faces, normals, ao: computeAO(faces, normals), center, radius };
}
// Expand an indexed mesh (shared verts + face index lists, e.g. from the OBJ decimator).
function buildMeshIndexed(verts, faceIdx) { return buildMesh(faceIdx.map((f) => f.map((i) => verts[i]))); }

/* ---- Zone patch fill: expand a clicked face across shared edges while the surface
        stays smooth (normal deviation < ~45°), so one click grabs a whole cloak/armor
        plate on a dense imported mesh without bleeding around hard edges. ---- */

/* ---- Import your own model (STL/OBJ) — parse, normalize, decimate in-browser. ---- */
// Binary or ASCII STL -> triangle soup (verts get welded by the decimator's clustering).
function parseSTL(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 84) throw new Error("File too small to be an STL.");
  const dv = new DataView(buf);
  // size math beats the "solid" prefix check; some exporters append trailing bytes, so allow >=
  const nBin = dv.getUint32(80, true);
  const isBinary = nBin > 0 && 84 + nBin * 50 <= bytes.length;
  const verts = [], faces = [];
  if (isBinary) {
    const n = dv.getUint32(80, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12, f = []; // +12 skips the stored normal (recomputed from winding)
      for (let k = 0; k < 3; k++) {
        f.push(verts.length);
        verts.push([dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true)]);
      }
      faces.push(f);
    }
  } else {
    const txt = new TextDecoder().decode(buf);
    if (!/^\s*solid/.test(txt)) throw new Error("Not a recognizable STL file.");
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let m, tri = [];
    while ((m = re.exec(txt))) {
      tri.push(verts.length); verts.push([+m[1], +m[2], +m[3]]);
      if (tri.length === 3) { faces.push(tri); tri = []; }
    }
  }
  return { verts, faces };
}
function parseOBJ(txt) {
  const verts = [], faces = [];
  for (const line of txt.split("\n")) {
    if (line[0] === "v" && line[1] === " ") {
      const p = line.split(/\s+/); verts.push([+p[1], +p[2], +p[3]]);
    } else if (line[0] === "f" && line[1] === " ") {
      const p = line.trim().split(/\s+/), idx = [];
      for (let i = 1; i < p.length; i++) {
        const v = parseInt(p[i].split("/")[0], 10);
        idx.push(v < 0 ? verts.length + v : v - 1); // negative = relative to the verts seen so far
      }
      if (idx.every((v) => v >= 0 && v < verts.length)) faces.push(idx);
    }
  }
  return { verts, faces };
}
// Stand the model up (most print/scan files are z-up; the app is y-up, +z front),
// then center it and scale to croquis height so lighting/AO/camera behave the same.
function normalizeVerts(verts) {
  const bbox = (vs) => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const v of vs) for (let k = 0; k < 3; k++) { if (v[k] < mn[k]) mn[k] = v[k]; if (v[k] > mx[k]) mx[k] = v[k]; }
    return { mn, mx };
  };
  let { mn, mx } = bbox(verts);
  if ((mx[2] - mn[2]) > (mx[1] - mn[1]) * 1.2) { // taller in z than y -> z-up; rotate +90° about x (keeps winding)
    verts = verts.map((v) => [v[0], v[2], -v[1]]);
    ({ mn, mx } = bbox(verts));
  }
  const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const s = 170 / Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
  return verts.map((v) => [(v[0] - c[0]) * s, (v[1] - c[1]) * s, (v[2] - c[2]) * s]);
}
// Vertex clustering (same approach as decimate.mjs): snap verts to a coarse grid, merge to
// the cell average, rebuild faces. Coarsen the grid until the face budget is met.
function decimateMesh(verts, faces, target = 3400) {
  for (const N of [192, 144, 108, 84, 64, 48, 36, 27, 20, 15]) {
    const mn = [Infinity, Infinity, Infinity];
    let ext = 0;
    for (const v of verts) for (let k = 0; k < 3; k++) if (v[k] < mn[k]) mn[k] = v[k];
    for (const v of verts) for (let k = 0; k < 3; k++) if (v[k] - mn[k] > ext) ext = v[k] - mn[k];
    const cell = ext / N, cellMap = new Map(), sum = [], cnt = [], vToCell = new Int32Array(verts.length);
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const key = Math.floor((v[0] - mn[0]) / cell) + "," + Math.floor((v[1] - mn[1]) / cell) + "," + Math.floor((v[2] - mn[2]) / cell);
      let id = cellMap.get(key);
      if (id === undefined) { id = cnt.length; cellMap.set(key, id); sum.push([0, 0, 0]); cnt.push(0); }
      sum[id][0] += v[0]; sum[id][1] += v[1]; sum[id][2] += v[2]; cnt[id]++;
      vToCell[i] = id;
    }
    const newVerts = sum.map((s, id) => [s[0] / cnt[id], s[1] / cnt[id], s[2] / cnt[id]]);
    const newFaces = [], seen = new Set();
    for (const f of faces) {
      const m = [];
      for (const vi of f) { const c = vToCell[vi]; if (m.length === 0 || m[m.length - 1] !== c) m.push(c); }
      if (m.length > 1 && m[0] === m[m.length - 1]) m.pop();
      if (m.length < 3) continue;
      const key = [...m].sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue; seen.add(key);
      newFaces.push(m);
    }
    if (newFaces.length <= target) return { verts: newVerts.map((v) => v.map((x) => +x.toFixed(2))), faces: newFaces };
  }
  throw new Error("Couldn't decimate this mesh to a renderable size.");
}
// Full import pipeline: file -> parsed -> normalized -> decimated (ready to store/build).
function importMeshFromFile(name, buf, target = 3400) {
  const parsed = /\.obj$/i.test(name) ? parseOBJ(new TextDecoder().decode(buf)) : parseSTL(buf);
  if (!parsed.faces.length) throw new Error("No geometry found in that file.");
  return decimateMesh(normalizeVerts(parsed.verts), parsed.faces, target);
}

/* ---- Full-detail path: the actual STL as typed triangle soup for the GPU. ---- */
const FULL_DETAIL = 500000; // triangle cap — beyond this, cluster down (invisible at this size anyway)
function parseToTypedPos(name, buf) {
  const bytes = new Uint8Array(buf);
  if (!/\.obj$/i.test(name) && bytes.length >= 84) {
    const dv = new DataView(buf);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length) { // binary STL straight into a Float32Array
      const pos = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return pos;
    }
  }
  // ASCII STL / OBJ: reuse the array parsers, then triangulate into typed storage
  const parsed = /\.obj$/i.test(name) ? parseOBJ(new TextDecoder().decode(buf)) : parseSTL(buf);
  if (!parsed.faces.length) throw new Error("No geometry found in that file.");
  let tris = 0; for (const f of parsed.faces) tris += f.length - 2;
  const pos = new Float32Array(tris * 9);
  let t = 0;
  for (const f of parsed.faces) for (let k = 1; k < f.length - 1; k++) {
    const tri = [parsed.verts[f[0]], parsed.verts[f[k]], parsed.verts[f[k + 1]]];
    for (let v = 0; v < 3; v++) pos.set(tri[v], t * 9 + v * 3);
    t++;
  }
  return pos;
}
// Same normalize rules as the array path (stand z-up files upright, scale to croquis height), in place.
function normalizeTypedPos(pos) {
  const bbox = () => {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
      const v = pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
    }
    return { mn, mx };
  };
  let { mn, mx } = bbox();
  if ((mx[2] - mn[2]) > (mx[1] - mn[1]) * 1.2) {
    for (let i = 0; i < pos.length; i += 3) { const y = pos[i + 1]; pos[i + 1] = pos[i + 2]; pos[i + 2] = -y; }
    ({ mn, mx } = bbox());
  }
  const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const s = 170 / Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] = (pos[i + k] - c[k]) * s;
  return pos;
}
// Vertex-clustering decimation on typed soup (only used when the file exceeds the cap).
function decimateTypedPos(pos, target) {
  const nT = pos.length / 9;
  if (nT <= target) return pos;
  for (const N of [640, 512, 400, 320, 256, 200, 160, 128, 96, 72]) {
    const cell = 172 / N, cellMap = new Map(), sum = [], cnt = [];
    const q = (v) => Math.floor((v + 86) / cell);
    const cid = new Int32Array(nT * 3);
    for (let i = 0; i < nT * 3; i++) {
      const k = (q(pos[i * 3]) * 4096 + q(pos[i * 3 + 1])) * 4096 + q(pos[i * 3 + 2]);
      let id = cellMap.get(k);
      if (id === undefined) { id = cnt.length; cellMap.set(k, id); sum.push([0, 0, 0]); cnt.push(0); }
      sum[id][0] += pos[i * 3]; sum[id][1] += pos[i * 3 + 1]; sum[id][2] += pos[i * 3 + 2]; cnt[id]++;
      cid[i] = id;
    }
    const seen = new Set(); let kept = 0;
    const keep = new Int32Array(nT);
    for (let t = 0; t < nT; t++) {
      const a = cid[t * 3], b = cid[t * 3 + 1], c = cid[t * 3 + 2];
      if (a === b || b === c || a === c) continue;
      const key = [a, b, c].sort((x, y) => x - y).join(",");
      if (seen.has(key)) continue; seen.add(key);
      keep[kept++] = t;
    }
    if (kept <= target) {
      const out = new Float32Array(kept * 9);
      for (let j = 0; j < kept; j++) {
        const t = keep[j];
        for (let v = 0; v < 3; v++) {
          const id = cid[t * 3 + v];
          out[j * 9 + v * 3] = sum[id][0] / cnt[id]; out[j * 9 + v * 3 + 1] = sum[id][1] / cnt[id]; out[j * 9 + v * 3 + 2] = sum[id][2] / cnt[id];
        }
      }
      return out;
    }
  }
  throw new Error("Couldn't reduce this mesh under the GPU cap.");
}
function buildMeshTyped(pos) {
  const nT = pos.length / 9;
  const faceNormals = new Float32Array(nT * 3);
  for (let t = 0; t < nT; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const m = Math.hypot(nx, ny, nz) || 1;
    faceNormals[t * 3] = nx / m; faceNormals[t * 3 + 1] = ny / m; faceNormals[t * 3 + 2] = nz / m;
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v;
  }
  const center = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  let radius = 1;
  for (let i = 0; i < pos.length; i += 3) {
    const d = Math.hypot(pos[i] - center[0], pos[i + 1] - center[1], pos[i + 2] - center[2]);
    if (d > radius) radius = d;
  }
  return { typed: true, pos, faceNormals, center, radius };
}
// Canvas fallback for a typed GPU soup: decimate to the Ultra cap and rebuild in the
// faces/normals/ao shape the software renderer expects.
function typedMeshForCanvas(mesh) {
  const pos = decimateTypedPos(mesh.pos, 14000);
  const faces = [];
  for (let o = 0; o + 8 < pos.length; o += 9)
    faces.push([[pos[o], pos[o + 1], pos[o + 2]], [pos[o + 3], pos[o + 4], pos[o + 5]], [pos[o + 6], pos[o + 7], pos[o + 8]]]);
  return buildMesh(faces);
}
/* ---- IndexedDB: full-detail meshes and their zone maps don't fit localStorage. ---- */
const idb = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("lightbench", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res((this._db = r.result));
      r.onerror = () => rej(r.error);
    });
  },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const rq = db.transaction("kv").objectStore("kv").get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); },
  async del(k) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").delete(k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
};

// Mesh construction (especially the AO pass on the ~2.8k-face scan) is deferred
// until a model is actually shown, so page load doesn't pay for meshes never opened.
// ("custom" is filled in directly by the STL/OBJ importer, not built here.)
const MESH_BUILDERS = {
  male: () => buildMeshIndexed(MALE_VERTS, MALE_FACES), // real anatomy, decimated from the OBJ
};
const meshCache = {};
// Lazy MESH3D lookup with the same `MESH3D[key]` shape as before (built once, then cached).
const MESH3D = new Proxy(meshCache, {
  get: (c, key) => (c[key] ??= MESH_BUILDERS[key]?.()),
  has: (c, key) => key in MESH_BUILDERS,
});

// Canvas renderer — fast enough for the decimated scan (~2-3k faces) where SVG would choke.
// Same engine: world-space normal -> light -> tier color, flat-shaded; painter's sort + cull;
// mild perspective; drag to orbit (light fixed in world). noDrag renders a static thumbnail.
const Model3DCanvas = React.memo(function Model3DCanvas({ mesh, L, ramp, mode, isoTier, tierKeys, glazeOn, glazeLayers, pooling, valueMode, sprayOn = false, focus = 0.5, sprayColor = "#cfe3ef", orbOn = false, Lorb = null, orbColor = "#3fb8ff", orbInt = 0.5, noDrag, initRot, zoneRamps = null, zoneMap = null, zoneMetals = null, zoneVer = 0, onPickFace = null, brushSize = 0, onBrushFaces = null, onStrokeEnd = null, rimOn = false, Lrim = null, rimColor = "#9fc8ff", rimInt = 0.4, primerColor = "#1b1b1b", lightOn = true, lightInt = 1 }) {
  const [rot, setRot] = useState(initRot || { yaw: -0.5, pitch: 0.12 });
  const [zoom, setZoom] = useState(1);
  const ringRef = useRef(null);
  const canvasRef = useRef(null);
  const drag = useRef(null);
  const drawn = useRef([]); // projected polys from the last render (front-to-back order), for click picking
  // Brush painting: map a pointer event to canvas coords and hand over every visible
  // face whose on-screen centroid falls inside the brush circle.
  const brushAt = (e) => {
    const cnv = canvasRef.current, r = cnv.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * cnv.width, py = ((e.clientY - r.top) / r.height) * cnv.height;
    const hit = [], R2 = brushSize * brushSize;
    for (const { i, pts } of drawn.current) {
      let cx2 = 0, cy2 = 0;
      for (const p of pts) { cx2 += p[0]; cy2 += p[1]; }
      cx2 /= pts.length; cy2 /= pts.length;
      if ((cx2 - px) * (cx2 - px) + (cy2 - py) * (cy2 - py) <= R2) hit.push(i);
    }
    if (hit.length) onBrushFaces(hit);
  };
  const touches = useRef(new Map()); // live pointers — a second finger turns the gesture into pinch-zoom
  const onDown = (e) => {
    if (noDrag) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      drag.current = { pinch: true, dist: Math.hypot(a.x - b.x, a.y - b.y), z0: zoom };
      e.currentTarget.setPointerCapture?.(e.pointerId); return;
    }
    if (onBrushFaces && brushSize > 0 && e.button === 0) { drag.current = { painting: true }; e.currentTarget.setPointerCapture?.(e.pointerId); brushAt(e); return; }
    drag.current = { x: e.clientX, y: e.clientY, moved: false, ...rot }; e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const raf = useRef(0), pendingRot = useRef(null);
  const onMove = (e) => {
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.current && drag.current.pinch) {
      if (touches.current.size >= 2 && drag.current.dist > 0) {
        const [a, b] = [...touches.current.values()];
        setZoom(clamp(drag.current.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / drag.current.dist), 0.6, 4));
      }
      return;
    }
    if (ringRef.current && onBrushFaces && brushSize > 0) { // live brush cursor ring
      const cnv = canvasRef.current, r = cnv.getBoundingClientRect();
      const d = brushSize * 2 * (r.width / cnv.width), rs = ringRef.current.style;
      rs.display = "block"; rs.width = rs.height = d + "px";
      rs.left = (e.clientX - r.left - d / 2) + "px"; rs.top = (e.clientY - r.top - d / 2) + "px";
    }
    if (!drag.current) return;
    if (drag.current.painting) { brushAt(e); return; }
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    pendingRot.current = { yaw: drag.current.yaw + dx * 0.01, pitch: clamp(drag.current.pitch + dy * 0.01, -1.2, 1.2) };
    // Pointer events can fire faster than the display refreshes; coalesce to one redraw per frame.
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; setRot(pendingRot.current); });
  };
  const onUp = (e) => {
    touches.current.delete(e.pointerId);
    if (drag.current && drag.current.pinch) {
      if (touches.current.size < 2) drag.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId); return;
    }
    const wasPainting = drag.current && drag.current.painting;
    const wasClick = drag.current && !drag.current.painting && !drag.current.moved;
    drag.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (e.type === "pointerleave" && ringRef.current) ringRef.current.style.display = "none";
    if (wasPainting) { onStrokeEnd && onStrokeEnd(); return; }
    if (!wasClick || !onPickFace) return;
    // click (not a drag): pick the frontmost face under the cursor
    const cnv = canvasRef.current, r = cnv.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * cnv.width, py = ((e.clientY - r.top) / r.height) * cnv.height;
    const polys = drawn.current;
    for (let k = polys.length - 1; k >= 0; k--) { // drawn back-to-front, so scan from the end
      const { i, pts } = polys[k];
      let inside = false;
      for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
        if (((pts[a][1] > py) !== (pts[b][1] > py)) &&
            px < ((pts[b][0] - pts[a][0]) * (py - pts[a][1])) / (pts[b][1] - pts[a][1]) + pts[a][0]) inside = !inside;
      }
      if (inside) { onPickFace(i); return; }
    }
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Scroll to zoom (attached non-passive so the page doesn't scroll underneath).
  useEffect(() => {
    const cnv = canvasRef.current; if (!cnv || noDrag) return;
    const onWheel = (e) => { e.preventDefault(); setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.6, 4)); };
    cnv.addEventListener("wheel", onWheel, { passive: false });
    return () => cnv.removeEventListener("wheel", onWheel);
  }, [noDrag]);

  // Brightness depends on light + mesh only — not rotation — so cache it across drag frames.
  const brights = useMemo(() => mesh.faces.map((f, i) => brightness(mesh.normals[i], L, mesh.ao[i], lightInt)), [mesh, L, lightInt]);

  useEffect(() => {
    const cnv = canvasRef.current; if (!cnv) return;
    const ctx = cnv.getContext("2d");
    const W = cnv.width, H = cnv.height, cx = W / 2, cy = H / 2;
    ctx.clearRect(0, 0, W, H);
    const { faces: mf, normals, center, radius } = mesh;
    const fit = (Math.min(W, H) * 0.46 * zoom) / radius, camDist = radius * 4.2;
    const cyaw = Math.cos(rot.yaw), syaw = Math.sin(rot.yaw), cpit = Math.cos(rot.pitch), spit = Math.sin(rot.pitch);
    const rotAll = (p) => rotX(rotY(p, cyaw, syaw), cpit, spit);
    const cam = (p) => rotAll(sub3(p, center));
    const project = (v) => { const k = camDist / (camDist - v[2]); return [cx + fit * k * v[0], cy - fit * k * v[1]]; };
    // light uses the world normal (orbit doesn't relight); cull/sort use the camera normal/depth.
    const vis = [];
    for (let i = 0; i < mf.length; i++) {
      const cn = rotAll(normals[i]);
      if (cn[2] <= 0.001) continue; // backface cull before doing any more work
      const cv = mf[i].map(cam);
      vis.push({ i, n: normals[i], cnz: cn[2], cv, depth: cv.reduce((a, v) => a + v[2], 0) / cv.length, b: brights[i] });
    }
    vis.sort((a, b) => a.depth - b.depth);
    const picks = onPickFace || onBrushFaces ? [] : null;
    const strokeFaces = mf.length < 300; // facet edges help the low-poly figures, not the dense scan
    let bright = null;
    for (const o of vis) {
      // each face shades from its zone's ramp (zone 0 = the main ramp)
      const zif = (zoneMap && zoneMap[o.i]) || 0;
      const zr = (zoneRamps && (zoneRamps[zif] || zoneRamps[0])) || ramp;
      const met = zoneMetals && zoneMetals[zif];
      const idx = tierIndex(o.b, zr.length);
      let fill, dim = isoTier != null && tierKeys[idx] !== isoTier;
      if (!lightOn) { // flat scheme: base color under a neutral viewing light so form still reads
        const baseC = mode === "prime" ? primerColor : met ? nmmColor(met, 0.5, [0, 0, 1]) : (zr[1] || zr[0]);
        const aoF = mesh.ao ? mesh.ao[o.i] : 1;
        fill = mix("#000000", baseC, (0.55 + 0.45 * Math.max(0, o.cnz)) * (0.7 + 0.3 * aoF));
        dim = false;
      }
      else if (sprayOn) { fill = mix("#33322d", sprayColor, sprayCoverage(o.n, L, focus)); dim = false; }
      else if (mode === "prime") fill = primerColor;
      else if (mode === "zenithal") fill = valueGrey(o.b);
      else if (met) fill = nmmColor(met, o.b, o.n); // NMM zone: metal shading, not the tier ramp
      else fill = zr[idx];
      if (glazeOn && mode !== "prime" && !sprayOn) {
        for (const gz of glazeLayers) fill = mix(fill, gz.color, clamp(gz.opacity * (1 - pooling * o.b), 0, 1));
      }
      if (valueMode && mode === "paint" && !sprayOn) fill = valueGreyOf(fill);
      if (orbOn && Lorb && !sprayOn) fill = orbGlow(fill, o.n, Lorb, orbColor, orbInt);
      if (rimOn && Lrim && !sprayOn) fill = orbGlow(fill, o.n, Lrim, rimColor, rimInt);
      ctx.globalAlpha = dim ? 0.12 : 1;
      ctx.beginPath();
      const pts = picks ? [] : null;
      const p0 = project(o.cv[0]); ctx.moveTo(p0[0], p0[1]); if (pts) pts.push(p0);
      for (let k = 1; k < o.cv.length; k++) { const p = project(o.cv[k]); ctx.lineTo(p[0], p[1]); if (pts) pts.push(p); }
      ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      if (pts) picks.push({ i: o.i, pts });
      if (strokeFaces) { ctx.lineWidth = 0.6; ctx.strokeStyle = "#00000033"; ctx.stroke(); }
      if (!dim && (!bright || o.b > bright.b)) bright = o;
    }
    if (picks) drawn.current = picks;
    ctx.globalAlpha = 1;
    if (mode !== "prime" && bright) {
      const [X, Y] = project(centroid3(bright.cv));
      const g = ctx.createRadialGradient(X, Y, 0, X, Y, 18);
      g.addColorStop(0, "rgba(255,246,218,0.95)"); g.addColorStop(0.25, "rgba(253,230,138,0.5)"); g.addColorStop(1, "rgba(253,230,138,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(X, Y, 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff6da"; ctx.beginPath(); ctx.arc(X, Y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }, [mesh, brights, L, ramp, mode, isoTier, tierKeys, glazeOn, glazeLayers, pooling, valueMode, sprayOn, focus, sprayColor, orbOn, Lorb, orbColor, orbInt, rot, zoom, zoneRamps, zoneMap, zoneMetals, zoneVer, onPickFace, rimOn, Lrim, rimColor, rimInt, primerColor, lightOn]);

  const onKey = (e) => { // keyboard access: arrows rotate, +/- zoom
    if (noDrag) return;
    const st = e.shiftKey ? 0.3 : 0.1;
    if (e.key === "ArrowLeft") setRot((r) => ({ ...r, yaw: r.yaw - st }));
    else if (e.key === "ArrowRight") setRot((r) => ({ ...r, yaw: r.yaw + st }));
    else if (e.key === "ArrowUp") setRot((r) => ({ ...r, pitch: clamp(r.pitch - st, -1.2, 1.2) }));
    else if (e.key === "ArrowDown") setRot((r) => ({ ...r, pitch: clamp(r.pitch + st, -1.2, 1.2) }));
    else if (e.key === "+" || e.key === "=") setZoom((z) => clamp(z * 1.15, 0.6, 4));
    else if (e.key === "-" || e.key === "_") setZoom((z) => clamp(z / 1.15, 0.6, 4));
    else return;
    e.preventDefault();
  };
  return (
    <div className="relative flex flex-col items-center">
      <canvas ref={canvasRef} width={460} height={600} tabIndex={0}
        aria-label="3D model. Arrow keys rotate, plus and minus zoom; hold Shift for bigger steps."
        className={"w-full h-auto select-none touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 " + (onPickFace || onBrushFaces ? "cursor-crosshair" : noDrag ? "" : "cursor-grab active:cursor-grabbing")}
        onContextMenu={(e) => e.preventDefault()} onKeyDown={onKey}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} />
      <div ref={ringRef} className="pointer-events-none absolute rounded-full border-2 border-amber-300/70" style={{ display: "none" }} />
      {!noDrag && (
        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <button onClick={() => setZoom((z) => clamp(z * 1.25, 0.6, 4))} aria-label="Zoom in"
            className="w-7 h-7 rounded-md border border-stone-600 bg-stone-900/70 text-stone-300 hover:text-white text-sm leading-none">+</button>
          <button onClick={() => setZoom((z) => clamp(z / 1.25, 0.6, 4))} aria-label="Zoom out"
            className="w-7 h-7 rounded-md border border-stone-600 bg-stone-900/70 text-stone-300 hover:text-white text-sm leading-none">−</button>
          {zoom !== 1 && (
            <button onClick={() => setZoom(1)} aria-label="Reset zoom"
              className="w-7 h-7 rounded-md border border-stone-600 bg-stone-900/70 text-stone-400 hover:text-white text-[10px] leading-none">1:1</button>
          )}
        </div>
      )}
      {!noDrag && <div className="mt-1 text-[10px] tracking-[0.25em] uppercase text-stone-400">3D · drag to rotate · scroll to zoom</div>}
    </div>
  );
});

/* ============================== WEBGL RENDERER ==============================
   GPU port of the same shading model, so full-detail STLs (hundreds of
   thousands of faces) render and paint interactively. Falls back to the
   canvas renderer automatically when WebGL2 isn't available. ---- */
const hexV3 = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
// Convert any mesh (n-gon faces or typed triangle soup) into GPU-ready buffers.
function glifyMesh(mesh) {
  if (mesh.glb) return mesh.glb;
  let pos, nrm, fid, faceNormals, ao = null, nFaces, triCount;
  if (mesh.typed) {
    pos = mesh.pos; triCount = pos.length / 9; nFaces = triCount;
    faceNormals = mesh.faceNormals;
    nrm = new Float32Array(pos.length); fid = new Float32Array(triCount * 3);
    for (let i = 0; i < triCount; i++) for (let k = 0; k < 3; k++) {
      nrm[i * 9 + k * 3] = faceNormals[i * 3]; nrm[i * 9 + k * 3 + 1] = faceNormals[i * 3 + 1]; nrm[i * 9 + k * 3 + 2] = faceNormals[i * 3 + 2];
      fid[i * 3 + k] = i;
    }
  } else {
    nFaces = mesh.faces.length;
    triCount = 0; for (const f of mesh.faces) triCount += f.length - 2;
    pos = new Float32Array(triCount * 9); nrm = new Float32Array(triCount * 9); fid = new Float32Array(triCount * 3);
    faceNormals = new Float32Array(nFaces * 3); ao = new Uint8Array(nFaces);
    let t = 0;
    mesh.faces.forEach((f, i) => {
      faceNormals.set(mesh.normals[i], i * 3);
      ao[i] = Math.round(clamp(mesh.ao[i], 0, 1) * 255);
      for (let k = 1; k < f.length - 1; k++) {
        const tri = [f[0], f[k], f[k + 1]];
        for (let v = 0; v < 3; v++) { pos.set(tri[v], t * 9 + v * 3); nrm.set(mesh.normals[i], t * 9 + v * 3); fid[t * 3 + v] = i; }
        t++;
      }
    });
  }
  let lines = null; // facet edges keep low-poly figures legible
  if (!mesh.typed && nFaces < 300) {
    const seg = [];
    for (const f of mesh.faces) for (let a = 0; a < f.length; a++) seg.push(...f[a], ...f[(a + 1) % f.length]);
    lines = new Float32Array(seg);
  }
  return (mesh.glb = { pos, nrm, fid, faceNormals, ao, nFaces, triCount, lines, center: mesh.center, radius: mesh.radius });
}
// Face adjacency over the GPU buffers (works for both mesh flavors) — for patch fill.
function glAdjacency(g) {
  if (g._adj) return g._adj;
  const q = (v) => Math.round(v * 10) + 8192;
  const vids = new Map(), vidOf = new Int32Array(g.triCount * 3);
  for (let i = 0; i < g.triCount * 3; i++) {
    const k = (q(g.pos[i * 3]) * 16384 + q(g.pos[i * 3 + 1])) * 16384 + q(g.pos[i * 3 + 2]);
    let id = vids.get(k); if (id === undefined) { id = vids.size; vids.set(k, id); }
    vidOf[i] = id;
  }
  const adj = Array.from({ length: g.nFaces }, () => []);
  const edges = new Map();
  for (let t = 0; t < g.triCount; t++) {
    const f = g.fid[t * 3];
    for (let e = 0; e < 3; e++) {
      const a = vidOf[t * 3 + e], b = vidOf[t * 3 + ((e + 1) % 3)];
      const ek = a < b ? a * 16777216 + b : b * 16777216 + a;
      const o = edges.get(ek);
      if (o === undefined) edges.set(ek, f);
      else if (o !== f) { adj[f].push(o); adj[o].push(f); }
    }
  }
  return (g._adj = adj);
}
function glZonePatch(g, start, maxFaces = 60000) {
  const adj = glAdjacency(g), fn = g.faceNormals;
  const dotF = (a, b) => fn[a * 3] * fn[b * 3] + fn[a * 3 + 1] * fn[b * 3 + 1] + fn[a * 3 + 2] * fn[b * 3 + 2];
  const out = [start], seen = new Set(out);
  for (let qi = 0; qi < out.length && out.length < maxFaces; qi++)
    for (const j of adj[out[qi]]) if (!seen.has(j) && dotF(out[qi], j) > 0.72) { seen.add(j); out.push(j); }
  return out;
}
/* ---- Mirror map: for each face, its twin across the x=0 centerline (nearest
        centroid match) — lets one brush stroke paint both pauldrons. ---- */
function glMirrorMap(g) {
  if (g._mirror) return g._mirror;
  const n = g.nFaces;
  const cent = new Float32Array(n * 3), cnt = new Uint16Array(n);
  for (let t = 0; t < g.triCount; t++) {
    const f = g.fid[t * 3];
    for (let v = 0; v < 3; v++) {
      cent[f * 3] += g.pos[t * 9 + v * 3]; cent[f * 3 + 1] += g.pos[t * 9 + v * 3 + 1]; cent[f * 3 + 2] += g.pos[t * 9 + v * 3 + 2];
      cnt[f]++;
    }
  }
  for (let i = 0; i < n; i++) { const c = cnt[i] || 1; cent[i * 3] /= c; cent[i * 3 + 1] /= c; cent[i * 3 + 2] /= c; }
  const cell = Math.max(0.75, g.radius / 80);
  const q = (v) => Math.round(v / cell) + 4096;
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const k = (q(cent[i * 3]) * 8192 + q(cent[i * 3 + 1])) * 8192 + q(cent[i * 3 + 2]);
    const b = buckets.get(k); if (b) b.push(i); else buckets.set(k, [i]);
  }
  const mir = new Int32Array(n).fill(-1);
  const tol2 = (cell * 2.5) * (cell * 2.5);
  for (let i = 0; i < n; i++) {
    const mx = -cent[i * 3], my = cent[i * 3 + 1], mz = cent[i * 3 + 2];
    let best = -1, bd = tol2;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = buckets.get(((q(mx) + dx) * 8192 + (q(my) + dy)) * 8192 + (q(mz) + dz));
      if (!b) continue;
      for (const j of b) {
        const d = (cent[j * 3] - mx) ** 2 + (cent[j * 3 + 1] - my) ** 2 + (cent[j * 3 + 2] - mz) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
    }
    mir[i] = best;
  }
  return (g._mirror = mir);
}
/* ---- Smooth shading: average normals across welded vertices so organic scans
        read as continuous surfaces instead of triangle facets. ---- */
function glSmoothNormals(g) {
  if (g.nrmSmooth) return g.nrmSmooth;
  const q = (v) => Math.round(v * 10) + 8192;
  const acc = new Map();
  const nC = g.triCount * 3;
  for (let i = 0; i < nC; i++) {
    const k = (q(g.pos[i * 3]) * 16384 + q(g.pos[i * 3 + 1])) * 16384 + q(g.pos[i * 3 + 2]);
    let a = acc.get(k); if (!a) { a = [0, 0, 0]; acc.set(k, a); }
    a[0] += g.nrm[i * 3]; a[1] += g.nrm[i * 3 + 1]; a[2] += g.nrm[i * 3 + 2];
  }
  const out = new Float32Array(nC * 3);
  for (let i = 0; i < nC; i++) {
    const k = (q(g.pos[i * 3]) * 16384 + q(g.pos[i * 3 + 1])) * 16384 + q(g.pos[i * 3 + 2]);
    const a = acc.get(k);
    const m = Math.hypot(a[0], a[1], a[2]) || 1;
    out[i * 3] = a[0] / m; out[i * 3 + 1] = a[1] / m; out[i * 3 + 2] = a[2] / m;
  }
  return (g.nrmSmooth = out);
}
const GL_VERT = `#version 300 es
precision highp float;
in vec3 aPos; in vec3 aNrm; in float aFid;
uniform vec3 uCenter; uniform vec4 uRot;
uniform float uSX, uSY, uCamDist, uZr;
uniform vec2 uPan;
out vec3 vWN; out float vCNz; flat out int vFid;
vec3 rotv(vec3 p){
  p = vec3(uRot.x*p.x + uRot.y*p.z, p.y, -uRot.y*p.x + uRot.x*p.z);
  return vec3(p.x, uRot.z*p.y - uRot.w*p.z, uRot.w*p.y + uRot.z*p.z);
}
void main(){
  vec3 v = rotv(aPos - uCenter);
  v.xy += uPan;
  vec3 cn = rotv(aNrm);
  vWN = aNrm; vCNz = cn.z; vFid = int(aFid + 0.5);
  float w = uCamDist - v.z;
  gl_Position = vec4(v.x*uSX, v.y*uSY, -v.z*uZr*w, w);
}`;
const GL_FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWN; in float vCNz; flat in int vFid;
uniform sampler2D uZTex;
uniform vec3 uL, uLorb, uOrbColor, uSprayColor, uLrim, uRimColor, uPrimer;
uniform vec3 uRamps[28];
uniform vec4 uGlaze[8];
uniform int uGlazeN, uMode, uNTiers, uIso, uMetals[4];
uniform float uPooling, uFocus, uOrbInt, uRimInt, uLightInt;
uniform bool uGlazeOn, uValueMode, uSprayOn, uOrbOn, uRimOn, uFlat;
out vec4 frag;
vec3 hsl2rgb(vec3 hsl){
  vec3 rgb = clamp(abs(mod(hsl.x*6.0+vec3(0.0,4.0,2.0),6.0)-3.0)-1.0,0.0,1.0);
  float c = (1.0-abs(2.0*hsl.z-1.0))*hsl.y;
  return (rgb-0.5)*c + hsl.z;
}
// sRGB <-> linear (exact Rec.709 transfer), so every blend below mixes actual light —
// matching the canvas renderer's mix() instead of muddying gamma-encoded bytes.
vec3 s2l(vec3 c){ return mix(c/12.92, pow((c+vec3(0.055))/1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 l2s(vec3 c){ return mix(c*12.92, 1.055*pow(max(c,vec3(0.0)), vec3(1.0/2.4))-0.055, step(vec3(0.0031308), c)); }
vec3 mixl(vec3 a, vec3 b, float t){ return l2s(mix(s2l(a), s2l(b), t)); }
vec3 vGrey(float b){ return hsl2rgb(vec3(40.0/360.0, 0.04, 0.12 + b*0.78)); }
vec3 nmm(int kind, float b, vec3 n){
  vec3 lo,mid,hi,spark,sky,earth;
  if (kind==2){ lo=vec3(.165,.102,.039); mid=vec3(.541,.353,.102); hi=vec3(.910,.722,.290); spark=vec3(1.,.965,.847); sky=vec3(1.,.929,.690); earth=vec3(.290,.180,.071); }
  else { lo=vec3(.078,.090,.114); mid=vec3(.290,.337,.400); hi=vec3(.659,.722,.800); spark=vec3(.957,.973,1.); sky=vec3(.761,.847,.918); earth=vec3(.180,.169,.149); }
  float t = smoothstep(0.2,0.9,b);
  vec3 c = t<0.5 ? mixl(lo,mid,t*2.0) : mixl(mid,hi,(t-0.5)*2.0);
  if (b>0.88) c = mixl(c, spark, smoothstep(0.88,0.98,b));
  if (n.y>0.0) c = mixl(c, sky, n.y*0.35); else c = mixl(c, earth, -n.y*0.45);
  return c;
}
void main(){
  if (vCNz <= 0.001) discard;
  ivec2 tuv = ivec2(vFid % 2048, vFid / 2048);
  vec4 zd = texelFetch(uZTex, tuv, 0);
  int zone = int(zd.r * 255.0 + 0.5);
  float ao = zd.g;
  vec3 n = normalize(vWN);
  float d = dot(n, uL);
  float b = 0.05*ao + 0.95*uLightInt*smoothstep(-0.3, 1.0, d)*(0.5 + 0.5*ao);
  int idx = clamp(int(floor(b*float(uNTiers-1) + 0.5)), 0, uNTiers-1);
  bool dim = (uIso >= 0) && (idx != uIso);
  vec3 fill;
  if (uFlat) { // flat paint scheme: base-coat color under a neutral viewing light, so the sculpt still reads
    vec3 baseC = uMode == 1 ? uPrimer : (uMetals[zone] > 0 ? nmm(uMetals[zone], 0.5, vec3(0.0, 0.0, 1.0)) : uRamps[zone*7 + 1]);
    float vb = (0.55 + 0.45 * clamp(vCNz, 0.0, 1.0)) * (0.7 + 0.3 * ao);
    fill = l2s(s2l(baseC) * vb); // linear-light mix from black, like the canvas path
    dim = false;
  }
  else if (uSprayOn) {
    float edge = -0.15 + uFocus*0.85;
    float cov = smoothstep(edge, edge + (0.6 - uFocus*0.48), d);
    fill = mixl(vec3(0.200,0.196,0.176), uSprayColor, cov); dim = false;
  }
  else if (uMode == 1) fill = uPrimer;
  else if (uMode == 2) fill = vGrey(b);
  else if (uMetals[zone] > 0) fill = nmm(uMetals[zone], b, n);
  else fill = uRamps[zone*7 + idx];
  if (uGlazeOn && uMode != 1 && !uSprayOn) { // glaze washes over whatever is underneath —
    for (int i = 0; i < 8; i++) { if (i >= uGlazeN) break; // materials normally, grey on the zenithal step
      float eff = clamp(uGlaze[i].a*(1.0 - uPooling*b), 0.0, 1.0);
      fill = mixl(fill, uGlaze[i].rgb, eff);
    }
  }
  if (uValueMode && uMode == 0 && !uSprayOn) {
    fill = l2s(vec3(dot(s2l(fill), vec3(0.2126,0.7152,0.0722)))); // exact Rec.709 luminance, matching valueGreyOf
  }
  if (uOrbOn && !uSprayOn) fill = clamp(fill + uOrbColor * (uOrbInt * smoothstep(0.0,1.0,dot(n,uLorb))), 0.0, 1.0);
  if (uRimOn && !uSprayOn) fill = clamp(fill + uRimColor * (uRimInt * smoothstep(0.0,1.0,dot(n,uLrim))), 0.0, 1.0);
  float alpha = dim ? 0.12 : 1.0;
  frag = vec4(fill*alpha, alpha);
}`;
const GL_PICK_FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWN; in float vCNz; flat in int vFid;
out vec4 frag;
void main(){
  if (vCNz <= 0.001) discard;
  frag = vec4(float(vFid % 256)/255.0, float((vFid/256) % 256)/255.0, float(vFid/65536)/255.0, 1.0);
}`;
const GL_LINE_VERT = `#version 300 es
precision highp float;
in vec3 aPos;
uniform vec3 uCenter; uniform vec4 uRot;
uniform float uSX, uSY, uCamDist, uZr;
uniform vec2 uPan;
vec3 rotv(vec3 p){
  p = vec3(uRot.x*p.x + uRot.y*p.z, p.y, -uRot.y*p.x + uRot.x*p.z);
  return vec3(p.x, uRot.z*p.y - uRot.w*p.z, uRot.w*p.y + uRot.z*p.z);
}
void main(){
  vec3 v = rotv(aPos - uCenter);
  v.xy += uPan;
  float w = uCamDist - v.z;
  gl_Position = vec4(v.x*uSX, v.y*uSY, -v.z*uZr*w*0.999, w);
}`;
const GL_LINE_FRAG = `#version 300 es
precision highp float; out vec4 frag;
void main(){ frag = vec4(0.0, 0.0, 0.0, 0.2); }`;
function glProgram(gl, vs, fs) {
  const mk = (type, srcTxt) => {
    const s = gl.createShader(type); gl.shaderSource(s, srcTxt); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
  return p;
}

const ZTEX_W = 2048;
let meshKeyN = 0;
const ModelGL = React.memo(function ModelGL({ mesh, L, ramp, mode, isoTier, tierKeys, glazeOn, glazeLayers, pooling, valueMode, sprayOn = false, focus = 0.5, sprayColor = "#cfe3ef", orbOn = false, Lorb = null, orbColor = "#3fb8ff", orbInt = 0.5, noDrag, initRot, zoneRamps = null, zoneMetals = null, zoneArr = null, zoneVer = 0, onPickFace = null, brushSize = 0, onBrushFaces = null, onStrokeEnd = null, rimOn = false, Lrim = null, rimColor = "#9fc8ff", rimInt = 0.4, smoothShade = false, onToggleSmooth = null, primerColor = "#1b1b1b", lightOn = true, lightInt = 1, onGLFail }) {
  const [rot, setRot] = useState(initRot || { yaw: -0.5, pitch: 0.12 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 }); // camera target offset in view units
  const canvasRef = useRef(null), ringRef = useRef(null), markerRef = useRef(null);
  const S = useRef(null);
  const drag = useRef(null), raf = useRef(0), pendingRot = useRef(null), pendingPan = useRef(null);
  // A lost/reused context can't be revived on the same element — remount the canvas per mesh.
  const meshKey = useMemo(() => { meshKeyN += 1; return meshKeyN; }, [mesh]);

  useEffect(() => { // one-time GL setup per mesh
    const cnv = canvasRef.current; if (!cnv) return;
    let gl;
    try {
      gl = cnv.getContext("webgl2", { alpha: true, antialias: true, preserveDrawingBuffer: true });
      if (!gl || !gl.createShader) throw new Error("no webgl2");
      const g = glifyMesh(mesh);
      const prog = glProgram(gl, GL_VERT, GL_FRAG);
      const pick = glProgram(gl, GL_VERT, GL_PICK_FRAG);
      const line = g.lines ? glProgram(gl, GL_LINE_VERT, GL_LINE_FRAG) : null;
      const buf = (data, loc, size) => {
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); return b;
      };
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      buf(g.pos, 0, 3); const nrmBuf = buf(g.nrm, 1, 3); buf(g.fid, 2, 1);
      let lineVao = null;
      if (line) { lineVao = gl.createVertexArray(); gl.bindVertexArray(lineVao); buf(g.lines, 0, 3); }
      gl.bindVertexArray(null);
      const texH = Math.max(1, Math.ceil(g.nFaces / ZTEX_W));
      const ztex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, ztex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ZTEX_W, texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fboTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cnv.width, cnv.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, cnv.width, cnv.height);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const U = (p) => { const c = {}; return (k) => (k in c ? c[k] : (c[k] = gl.getUniformLocation(p, k))); };
      S.current = { gl, g, prog, pick, line, vao, lineVao, ztex, texH, fbo, nrmBuf, nrmSmoothBuf: null, up: U(prog), upk: U(pick), ul: line ? U(line) : null, zver: -1, ztmp: new Uint8Array(ZTEX_W * texH * 4) };
    } catch (err) { S.current = null; onGLFail && onGLFail(); return; }
    // A context lost mid-session (GPU reset, backgrounded mobile tab) would otherwise
    // freeze the canvas forever — treat it like a failed init and fall back.
    const onLost = (ev) => { ev.preventDefault(); S.current = null; onGLFail && onGLFail(); };
    cnv.addEventListener("webglcontextlost", onLost);
    return () => {
      cnv.removeEventListener("webglcontextlost", onLost);
      try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch {} S.current = null;
    };
  }, [mesh]);

  useEffect(() => { // faceted <-> smooth: swap which normal buffer feeds attribute 1
    const st = S.current; if (!st) return;
    const { gl, g } = st;
    gl.bindVertexArray(st.vao);
    if (smoothShade) {
      if (!st.nrmSmoothBuf) {
        st.nrmSmoothBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, st.nrmSmoothBuf);
        gl.bufferData(gl.ARRAY_BUFFER, glSmoothNormals(g), gl.STATIC_DRAW);
      } else gl.bindBuffer(gl.ARRAY_BUFFER, st.nrmSmoothBuf);
    } else gl.bindBuffer(gl.ARRAY_BUFFER, st.nrmBuf);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }, [smoothShade, mesh]);

  const setCam = (u, st) => {
    const { gl, g } = st, cnv = canvasRef.current;
    const W = cnv.width, H = cnv.height;
    const fit = (Math.min(W, H) * 0.46 * zoom) / g.radius, camDist = g.radius * 4.2;
    gl.uniform3fv(u("uCenter"), g.center);
    gl.uniform4f(u("uRot"), Math.cos(rot.yaw), Math.sin(rot.yaw), Math.cos(rot.pitch), Math.sin(rot.pitch));
    gl.uniform1f(u("uSX"), (fit * camDist) / (W / 2));
    gl.uniform1f(u("uSY"), (fit * camDist) / (H / 2));
    gl.uniform1f(u("uCamDist"), camDist);
    gl.uniform1f(u("uZr"), 1 / (g.radius * 1.1));
    gl.uniform2f(u("uPan"), pan.x, pan.y);
  };
  useEffect(() => { // redraw after every commit that touched a visual input
    const st = S.current; if (!st) return;
    const { gl, g, up } = st, cnv = canvasRef.current;
    if (st.zver !== zoneVer) { // (re)upload the per-face zone/AO table
      const d = st.ztmp;
      for (let i = 0; i < g.nFaces; i++) {
        d[i * 4] = zoneArr ? zoneArr[i] : 0;
        d[i * 4 + 1] = g.ao ? g.ao[i] : 255;
        d[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, st.ztex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ZTEX_W, st.texH, gl.RGBA, gl.UNSIGNED_BYTE, d);
      st.zver = zoneVer;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cnv.width, cnv.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(st.prog);
    setCam(up, st);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.ztex); gl.uniform1i(up("uZTex"), 0);
    gl.uniform3fv(up("uL"), L);
    gl.uniform3fv(up("uLorb"), Lorb || [0, 0, 1]);
    gl.uniform3fv(up("uOrbColor"), hexV3(orbColor));
    gl.uniform3fv(up("uSprayColor"), hexV3(sprayColor));
    gl.uniform3fv(up("uPrimer"), hexV3(primerColor));
    const ramps = new Float32Array(84);
    const zr = zoneRamps && zoneRamps.length ? zoneRamps : [ramp];
    for (let z = 0; z < 4; z++) {
      const r = zr[Math.min(z, zr.length - 1)] || ramp;
      for (let i = 0; i < 7; i++) ramps.set(hexV3(r[Math.min(i, r.length - 1)]), (z * 7 + i) * 3);
    }
    gl.uniform3fv(up("uRamps"), ramps);
    const gz = new Float32Array(32);
    const layers = (glazeLayers || []).slice(0, 8);
    layers.forEach((l, i) => { gz.set(hexV3(l.color), i * 4); gz[i * 4 + 3] = l.opacity; });
    gl.uniform4fv(up("uGlaze"), gz);
    gl.uniform1i(up("uGlazeN"), layers.length);
    gl.uniform1i(up("uMode"), mode === "prime" ? 1 : mode === "zenithal" ? 2 : 0);
    gl.uniform1i(up("uNTiers"), (zr[0] || ramp).length);
    gl.uniform1i(up("uIso"), isoTier != null && tierKeys ? tierKeys.indexOf(isoTier) : -1);
    const mets = [0, 0, 0, 0];
    (zoneMetals || []).slice(0, 4).forEach((m, i) => { mets[i] = m === "gold" ? 2 : m === "steel" ? 1 : 0; });
    gl.uniform1iv(up("uMetals"), mets);
    gl.uniform1f(up("uPooling"), pooling ?? 0.6);
    gl.uniform1f(up("uFocus"), focus);
    gl.uniform1f(up("uOrbInt"), orbInt);
    gl.uniform1f(up("uLightInt"), lightInt);
    gl.uniform1i(up("uGlazeOn"), glazeOn ? 1 : 0);
    gl.uniform1i(up("uValueMode"), valueMode ? 1 : 0);
    gl.uniform1i(up("uSprayOn"), sprayOn ? 1 : 0);
    gl.uniform1i(up("uOrbOn"), orbOn && Lorb ? 1 : 0);
    gl.uniform3fv(up("uLrim"), Lrim || [0, 0, 1]);
    gl.uniform3fv(up("uRimColor"), hexV3(rimColor));
    gl.uniform1f(up("uRimInt"), rimInt);
    gl.uniform1i(up("uRimOn"), rimOn && Lrim ? 1 : 0);
    gl.uniform1i(up("uFlat"), lightOn ? 0 : 1);
    gl.bindVertexArray(st.vao);
    gl.drawArrays(gl.TRIANGLES, 0, g.triCount * 3);
    if (st.line) {
      gl.useProgram(st.line); setCam(st.ul, st);
      gl.bindVertexArray(st.lineVao);
      gl.drawArrays(gl.LINES, 0, g.lines.length / 3);
    }
    gl.bindVertexArray(null);
    // Amber "where light lands" ping on the brightest visible facet — same lens the
    // canvas renderer has. CPU-side argmax (stride-sampled on huge meshes) projected
    // with the exact GL_VERT transform, positioned as a DOM overlay.
    const mk = markerRef.current;
    if (mk) {
      if (mode === "prime") mk.style.display = "none";
      else {
        const W = cnv.width, H = cnv.height;
        const fit = (Math.min(W, H) * 0.46 * zoom) / g.radius, camDist = g.radius * 4.2;
        const sX = (fit * camDist) / (W / 2), sY = (fit * camDist) / (H / 2);
        const cyw = Math.cos(rot.yaw), syw = Math.sin(rot.yaw), cpt = Math.cos(rot.pitch), spt = Math.sin(rot.pitch);
        const rotv = (x, y, z) => { const x1 = cyw * x + syw * z, z1 = -syw * x + cyw * z; return [x1, cpt * y - spt * z1, spt * y + cpt * z1]; };
        const stride = Math.max(1, Math.floor(g.triCount / 30000));
        const nT = tierKeys ? tierKeys.length : ramp.length;
        let bb = -1, bt = -1;
        for (let t = 0; t < g.triCount; t += stride) {
          const f = g.fid[t * 3];
          const nx = g.faceNormals[f * 3], ny = g.faceNormals[f * 3 + 1], nz = g.faceNormals[f * 3 + 2];
          if (rotv(nx, ny, nz)[2] <= 0.001) continue; // backfacing
          const b = brightness([nx, ny, nz], L, g.ao ? g.ao[f] / 255 : 1, lightInt);
          if (isoTier != null && tierKeys && tierKeys[tierIndex(b, nT)] !== isoTier) continue;
          if (b > bb) { bb = b; bt = t; }
        }
        if (bt < 0) mk.style.display = "none";
        else {
          const o = bt * 9;
          const v = rotv(
            (g.pos[o] + g.pos[o + 3] + g.pos[o + 6]) / 3 - g.center[0],
            (g.pos[o + 1] + g.pos[o + 4] + g.pos[o + 7]) / 3 - g.center[1],
            (g.pos[o + 2] + g.pos[o + 5] + g.pos[o + 8]) / 3 - g.center[2]);
          const w = camDist - v[2];
          const ndcX = ((v[0] + pan.x) * sX) / w, ndcY = ((v[1] + pan.y) * sY) / w;
          mk.style.display = "block";
          mk.style.left = ((ndcX * 0.5 + 0.5) * cnv.clientWidth - 14) + "px";
          mk.style.top = ((0.5 - ndcY * 0.5) * cnv.clientHeight - 14) + "px";
        }
      }
    }
  });

  const renderPick = () => {
    const st = S.current; if (!st) return false;
    const { gl, g } = st, cnv = canvasRef.current;
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo);
    gl.viewport(0, 0, cnv.width, cnv.height);
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST);
    gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(st.pick); setCam(st.upk, st);
    gl.bindVertexArray(st.vao);
    gl.drawArrays(gl.TRIANGLES, 0, g.triCount * 3);
    gl.bindVertexArray(null);
    return true;
  };
  const evPx = (e) => {
    const cnv = canvasRef.current, r = cnv.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * cnv.width, ((e.clientY - r.top) / r.height) * cnv.height];
  };
  const pickAt = (e) => {
    const st = S.current; if (!st || !renderPick()) return -1;
    const { gl, g } = st, cnv = canvasRef.current;
    const [x, y] = evPx(e);
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(x), cnv.height - 1 - Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const id = px[0] + px[1] * 256 + px[2] * 65536;
    return id < g.nFaces ? id : -1;
  };
  const brushAt = (e) => {
    const st = S.current; if (!st || !renderPick()) return;
    const { gl, g } = st, cnv = canvasRef.current;
    const [x, y] = evPx(e);
    const R = brushSize, x0 = Math.max(0, Math.round(x - R)), y0 = Math.max(0, Math.round(cnv.height - 1 - y - R));
    const w = Math.min(cnv.width - x0, Math.round(R * 2)), h = Math.min(cnv.height - y0, Math.round(R * 2));
    if (w <= 0 || h <= 0) return;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const hit = new Set(), R2 = R * R, cx0 = x - x0, cy0 = (cnv.height - 1 - y) - y0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if ((i - cx0) * (i - cx0) + (j - cy0) * (j - cy0) > R2) continue;
      const o = (j * w + i) * 4;
      const id = px[o] + px[o + 1] * 256 + px[o + 2] * 65536;
      if (id < g.nFaces) hit.add(id);
    }
    if (hit.size) onBrushFaces([...hit]);
  };
  const moveRing = (e) => {
    if (!ringRef.current || !onBrushFaces || brushSize <= 0) return;
    const cnv = canvasRef.current, r = cnv.getBoundingClientRect();
    const d = brushSize * 2 * (r.width / cnv.width), rs = ringRef.current.style;
    rs.display = "block"; rs.width = rs.height = d + "px";
    rs.left = (e.clientX - r.left - d / 2) + "px"; rs.top = (e.clientY - r.top - d / 2) + "px";
  };
  const touches = useRef(new Map()); // live pointers — a second finger turns the gesture into pinch-zoom
  const onDown = (e) => {
    if (noDrag) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      drag.current = { pinch: true, dist: Math.hypot(a.x - b.x, a.y - b.y), z0: zoom };
      e.currentTarget.setPointerCapture?.(e.pointerId); return;
    }
    if (e.shiftKey || e.button === 1) { // pan: shift-drag or middle-drag
      e.preventDefault();
      drag.current = { panning: true, moved: true, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      e.currentTarget.setPointerCapture?.(e.pointerId); return;
    }
    // brush paints with the left button only; right-drag still rotates while brushing
    if (onBrushFaces && brushSize > 0 && e.button === 0) { drag.current = { painting: true }; e.currentTarget.setPointerCapture?.(e.pointerId); brushAt(e); return; }
    drag.current = { x: e.clientX, y: e.clientY, moved: false, ...rot }; e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    moveRing(e);
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.current && drag.current.pinch) {
      if (touches.current.size >= 2 && drag.current.dist > 0) {
        const [a, b] = [...touches.current.values()];
        setZoom(clamp(drag.current.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / drag.current.dist), 0.6, 4));
      }
      return;
    }
    if (!drag.current) return;
    if (drag.current.panning) {
      const st = S.current, cnv = canvasRef.current; if (!st || !cnv) return;
      const r = cnv.getBoundingClientRect();
      const fit = (Math.min(cnv.width, cnv.height) * 0.46 * zoom) / st.g.radius;
      const s = (cnv.width / r.width) / fit, lim = st.g.radius * 1.2; // clamp so the model can't leave the frame
      pendingPan.current = {
        x: clamp(drag.current.px + (e.clientX - drag.current.x) * s, -lim, lim),
        y: clamp(drag.current.py - (e.clientY - drag.current.y) * s, -lim, lim),
      };
      if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; if (pendingPan.current) setPan(pendingPan.current); });
      return;
    }
    if (drag.current.painting) { brushAt(e); return; }
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    pendingRot.current = { yaw: drag.current.yaw + dx * 0.01, pitch: clamp(drag.current.pitch + dy * 0.01, -1.2, 1.2) };
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; setRot(pendingRot.current); });
  };
  const onUp = (e) => {
    touches.current.delete(e.pointerId);
    if (drag.current && drag.current.pinch) {
      if (touches.current.size < 2) drag.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId); return;
    }
    const wasPainting = drag.current && drag.current.painting;
    const wasClick = drag.current && !drag.current.painting && !drag.current.panning && !drag.current.moved;
    drag.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (e.type === "pointerleave" && ringRef.current) ringRef.current.style.display = "none";
    if (wasPainting) { onStrokeEnd && onStrokeEnd(); return; }
    if (!wasClick || !onPickFace) return;
    const id = pickAt(e);
    if (id >= 0) onPickFace(id);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useEffect(() => {
    const cnv = canvasRef.current; if (!cnv || noDrag) return;
    const onWheel = (e) => { e.preventDefault(); setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.6, 4)); };
    cnv.addEventListener("wheel", onWheel, { passive: false });
    return () => cnv.removeEventListener("wheel", onWheel);
  }, [noDrag, meshKey]); // the canvas remounts per mesh — rebind or scroll-zoom dies after an import
  const onKey = (e) => { // keyboard access: arrows rotate, +/- zoom
    if (noDrag) return;
    const st = e.shiftKey ? 0.3 : 0.1;
    if (e.key === "ArrowLeft") setRot((r) => ({ ...r, yaw: r.yaw - st }));
    else if (e.key === "ArrowRight") setRot((r) => ({ ...r, yaw: r.yaw + st }));
    else if (e.key === "ArrowUp") setRot((r) => ({ ...r, pitch: clamp(r.pitch - st, -1.2, 1.2) }));
    else if (e.key === "ArrowDown") setRot((r) => ({ ...r, pitch: clamp(r.pitch + st, -1.2, 1.2) }));
    else if (e.key === "+" || e.key === "=") setZoom((z) => clamp(z * 1.15, 0.6, 4));
    else if (e.key === "-" || e.key === "_") setZoom((z) => clamp(z / 1.15, 0.6, 4));
    else return;
    e.preventDefault();
  };
  return (
    <div className="relative flex flex-col items-center">
      <canvas key={meshKey} ref={canvasRef} width={460} height={600} tabIndex={0}
        aria-label="3D model. Arrow keys rotate, plus and minus zoom; hold Shift for bigger steps."
        className={"w-full h-auto select-none touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 " + (onPickFace || onBrushFaces ? "cursor-crosshair" : noDrag ? "" : "cursor-grab active:cursor-grabbing")}
        onContextMenu={(e) => e.preventDefault()} onKeyDown={onKey}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} />
      <div ref={ringRef} className="pointer-events-none absolute rounded-full border-2 border-amber-300/70" style={{ display: "none" }} />
      <div ref={markerRef} className="pointer-events-none absolute w-7 h-7"
        style={{ display: "none", background: "radial-gradient(circle, rgba(255,246,218,0.95) 0%, rgba(253,230,138,0.5) 25%, rgba(253,230,138,0) 70%)" }} />
      {!noDrag && (
        <div className="mt-1.5 w-full flex items-center justify-between gap-2">
          {onToggleSmooth ? (
            <button onClick={onToggleSmooth}
              title={smoothShade ? "Smooth surfaces — switch to faceted plane reading" : "Faceted planes — switch to smooth surfaces"}
              className="px-2 h-8 sm:h-6 rounded-md border border-stone-700 hover:border-stone-500 text-[10px] text-stone-400 leading-none">
              {smoothShade ? "smooth" : "faceted"}
            </button>
          ) : <span />}
          <span className="text-[9px] tracking-[0.2em] uppercase text-stone-500 text-center">
            {COARSE
              ? (onBrushFaces && brushSize > 0 ? "drag paints · two fingers zoom" : "drag rotate · pinch zoom")
              : (onBrushFaces && brushSize > 0 ? "drag paints · right-drag rotate · shift pan · scroll zoom" : "drag rotate · shift-drag pan · scroll zoom")}
          </span>
          <span className="flex items-center gap-1 flex-none">
            <button onClick={() => setZoom((z) => clamp(z / 1.25, 0.6, 4))} aria-label="Zoom out"
              className="w-8 h-8 sm:w-6 sm:h-6 rounded-md border border-stone-700 hover:border-stone-500 text-stone-400 leading-none">−</button>
            <button onClick={() => setZoom((z) => clamp(z * 1.25, 0.6, 4))} aria-label="Zoom in"
              className="w-8 h-8 sm:w-6 sm:h-6 rounded-md border border-stone-700 hover:border-stone-500 text-stone-400 leading-none">+</button>
            {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
              <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset view"
                className="px-1.5 h-8 sm:h-6 rounded-md border border-stone-700 hover:border-stone-500 text-[9px] text-stone-400 leading-none">reset</button>
            )}
          </span>
        </div>
      )}
    </div>
  );
});
// Public 3D view: WebGL when available, the canvas renderer as automatic fallback.
function Model3D(props) {
  const [useGL, setUseGL] = useState(true);
  // Typed GPU soups lack the faces/normals/ao arrays the software renderer reads —
  // decimate a canvas-friendly copy (zone indices don't survive that, so zones drop).
  const canvasMesh = useMemo(() => {
    if (useGL || !props.mesh?.typed) return props.mesh;
    try { return typedMeshForCanvas(props.mesh); } catch { return null; }
  }, [useGL, props.mesh]);
  if (useGL) return <ModelGL {...props} onGLFail={() => setUseGL(false)} />;
  if (!canvasMesh) return (
    <div className="p-6 text-xs text-stone-400 text-center">
      3D view unavailable — WebGL failed and this import is too dense for the software renderer.
      Re-import the model at Standard, High or Ultra detail.
    </div>
  );
  return <Model3DCanvas {...props} mesh={canvasMesh}
    zoneMap={canvasMesh === props.mesh ? props.zoneArr : null}
    onPickFace={canvasMesh === props.mesh ? props.onPickFace : null}
    onBrushFaces={canvasMesh === props.mesh ? props.onBrushFaces : null} />;
}

/* ============================== HEX SWATCH ============================== */
function Hex({ color, size = 34 }) {
  return (
    <div style={{
      width: size, height: size * 1.14, background: color,
      clipPath: "polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)",
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.10)",
    }} />
  );
}

/* ============================== COLOR WHEEL ============================== */
function ColorWheel({ ramp, accents, base, onPickBase, previewAccent, onSelectAccent }) {
  const C = 110, ringR = 100;
  const ref = useRef(null);
  const pos = (h, s) => {
    const phi = (h + 90) * Math.PI / 180; const rad = (s / 100) * ringR;
    return [C + rad * Math.sin(phi), C - rad * Math.cos(phi)];
  };
  const handle = useCallback((e) => {
    const rect = ref.current.getBoundingClientRect();
    const scale = (C * 2) / rect.width; // CSS px -> wheel units, so clicks and dots share one geometry
    const dx = (e.clientX - (rect.left + rect.width / 2)) * scale;
    const dy = (e.clientY - (rect.top + rect.height / 2)) * scale;
    if (onSelectAccent) { // tapping an accent dot previews it instead of moving the base hue
      for (const c of accents) {
        const { h, s } = hexToHsl(c); const [x, y] = pos(h, s);
        if (Math.hypot(C + dx - x, C + dy - y) <= 11) { onSelectAccent(c === previewAccent ? null : c); return; }
      }
    }
    let h = Math.atan2(dx, -dy) * 180 / Math.PI - 90; h = ((h % 360) + 360) % 360;
    const s = clamp(Math.hypot(dx, dy) / ringR * 100, 6, 100); // saturation against the ring, matching pos()
    const { l } = hexToHsl(base);
    onPickBase(hslToHex(h, s, l));
  }, [base, onPickBase, accents, previewAccent, onSelectAccent]);

  const onKey = useCallback((e) => { // keyboard access: arrows steer hue/saturation
    const { h, s, l } = hexToHsl(base);
    const step = e.shiftKey ? 15 : 3;
    let nh = h, ns = s;
    if (e.key === "ArrowRight") nh += step;
    else if (e.key === "ArrowLeft") nh -= step;
    else if (e.key === "ArrowUp") ns = clamp(s + step, 6, 100);
    else if (e.key === "ArrowDown") ns = clamp(s - step, 6, 100);
    else return;
    e.preventDefault();
    onPickBase(hslToHex(((nh % 360) + 360) % 360, ns, l));
  }, [base, onPickBase]);
  const points = ramp.map((c) => { const { h, s } = hexToHsl(c); return pos(h, s); });
  return (
    <div className="flex flex-col items-center">
      <div ref={ref} onPointerDown={handle} onKeyDown={onKey} tabIndex={0} role="application"
        aria-label="Color wheel. Left and right arrows change the base hue, up and down change saturation; hold Shift for bigger steps."
        className="relative rounded-full cursor-crosshair select-none touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
        style={{
          width: C * 2, height: C * 2,
          background: "conic-gradient(from 90deg, hsl(0,75%,55%), hsl(60,75%,55%), hsl(120,75%,55%), hsl(180,75%,55%), hsl(240,75%,55%), hsl(300,75%,55%), hsl(360,75%,55%))",
        }}>
        <div className="absolute inset-0 rounded-full"
          style={{ background: "radial-gradient(circle at center, #1d201a 12%, transparent 60%)" }} />
        <svg viewBox={`0 0 ${C * 2} ${C * 2}`} className="absolute inset-0 w-full h-full pointer-events-none">
          <polyline points={points.map((p) => p.join(",")).join(" ")}
            fill="none" stroke="#ffffffcc" strokeWidth="1.4" strokeDasharray="3 3" />
          {ramp.map((c, i) => (
            <circle key={i} cx={points[i][0]} cy={points[i][1]} r={(4 + 7 * relLuminance(c)).toFixed(1)} fill={c} stroke="#fff" strokeWidth="1.5" />
          ))}
          {accents.map((c, i) => {
            const { h, s } = hexToHsl(c); const [x, y] = pos(h, s);
            const sel = c === previewAccent;
            return <circle key={"a" + i} cx={x} cy={y} r={sel ? 8 : 6.5} fill={c}
              stroke="#facc15" strokeWidth={sel ? 3 : 2} />;
          })}
        </svg>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] tracking-[0.18em] uppercase text-stone-400">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-white" /> ramp (dot size = value)
        <span className="inline-block w-2.5 h-2.5 rounded-full ml-2" style={{ background: "#facc15" }} /> accents
      </div>
      <div className="mt-1 text-[10px] tracking-[0.16em] uppercase text-stone-500">tap wheel → set base hue · tap accent → preview</div>
    </div>
  );
}

/* ============================== APP ============================== */
export default function App() {
  const [base, setBase] = useState("#5f8a4a");
  const [numSteps, setNumSteps] = useState(5);
  const [ramp, setRamp] = useState(() => generateRamp("#5f8a4a", 5));
  const [accents, setAccents] = useState([]);
  const [previewAccent, setPreviewAccent] = useState(null);
  const [az, setAz] = useState(20);
  const [el, setEl] = useState(82);
  const [activeStage, setActiveStage] = useState("base"); // open on color, not the grey zenithal
  const [done, setDone] = useState({});
  const [recipes, setRecipes] = useState([]);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [model, setModel] = useState("male"); // straight to the bench — no landing screen
  const [glazeOn, setGlazeOn] = useState(false);
  const [method, setMethod] = useState("brush"); // brush | airbrush — reshapes the Steps copy
  const [spray, setSpray] = useState(false);      // show spray coverage instead of value (airbrush only)
  const [focus, setFocus] = useState(0.5);        // spray cone tightness
  const [orbOn, setOrbOn] = useState(false);      // object-source glow (a second colored light)
  const [orbAz, setOrbAz] = useState(200);
  const [orbEl, setOrbEl] = useState(0);
  const [orbColor, setOrbColor] = useState("#3fb8ff");
  const [orbInt, setOrbInt] = useState(0.5);
  const [valueMode, setValueMode] = useState(false); // greyscale value-study view (transient, not saved)
  const [customReady, setCustomReady] = useState(false); // an imported STL/OBJ mesh is loaded
  const [importMsg, setImportMsg] = useState("");
  const [detail, setDetail] = useState(3400); // face budget for imported models
  const [paintBrand, setPaintBrand] = useState(""); // real-paint match filter; "" = any brand
  // Zones: zone 0 is the main base/ramp; up to 3 extra zones each carry their own scheme.
  const [extraZones, setExtraZones] = useState([]); // [{ name, base, ramp }]
  const [activeZone, setActiveZone] = useState(0);
  const [zonePaint, setZonePaint] = useState(false); // when on, clicking the figure assigns the active zone
  const [zoneMode, setZoneMode] = useState("patch"); // 3D assign style: "patch" auto-fill | "brush" drag-paint
  const [brushSize, setBrushSize] = useState(22);    // brush radius in canvas px
  const [mirrorOn, setMirrorOn] = useState(false);   // paint both sides of a symmetric figure
  const [smoothShade, setSmoothShade] = useState(false); // faceted (plane reading) vs smooth surfaces
  const [rimOn, setRimOn] = useState(false);         // second light: a cooler rim opposite the key
  const [rimAz, setRimAz] = useState(200);
  const [rimEl, setRimEl] = useState(15);
  const [rimColor, setRimColor] = useState("#9fc8ff");
  const [rimInt, setRimInt] = useState(0.4);
  const [zenithalOn, setZenithalOn] = useState(false); // zenithal underpainting is an opt-in technique
  const [lightOn, setLightOn] = useState(true); // directional light planning; off = flat paint scheme
  const [lightInt, setLightInt] = useState(1);  // key light strength — soft (low contrast) to harsh
  const [primerColor, setPrimerColor] = useState("#1b1b1b"); // primer can be any color
  const [zoneMap3d, setZoneMap3d] = useState({});    // { model: { faceIdx: zone } }
  // Collapsible control sections — core ones open by default, specialty tools tucked away.
  const [openSec, setOpenSec] = useState({});
  const SEC_OPEN = { colors: true, light: true }; // open by default
  const sec = (k) => ({ open: openSec[k] ?? !!SEC_OPEN[k], onToggle: () => setOpenSec((s) => ({ ...s, [k]: !(s[k] ?? !!SEC_OPEN[k]) })) });
  // Status messages surface as a toast and clear themselves.
  useEffect(() => { if (!status) return; const t = setTimeout(() => setStatus(""), 2600); return () => clearTimeout(t); }, [status]);
  const [pooling, setPooling] = useState(0.6);
  const [glazeLayers, setGlazeLayers] = useState(() => [{ color: "#7a5a3a", opacity: 0.3 }]); // warm unifying wash

  const L = useMemo(() => lightVector(az, el), [az, el]);
  const Lorb = useMemo(() => lightVector(orbAz, orbEl), [orbAz, orbEl]);
  const Lrim = useMemo(() => lightVector(rimAz, rimEl), [rimAz, rimEl]);
  const tiers = useMemo(() => tierMeta(numSteps), [numSteps]);
  const tierKeys = useMemo(() => tiers.map((t) => t.key), [tiers]);
  const stages = useMemo(() => buildStages(numSteps, method, zenithalOn && lightOn, lightOn), [numSteps, method, zenithalOn, lightOn]);
  // If the active step vanished (step-count change, light toggled off), land on the first
  // paint step — not Prime — and sync state so a chip stays highlighted.
  const stage = stages.find((s) => s.id === activeStage) || stages.find((s) => s.mode === "paint") || stages[0];
  useEffect(() => { if (stage && stage.id !== activeStage) setActiveStage(stage.id); }, [stage, activeStage]);
  const sprayActive = spray && method === "airbrush";
  const sprayColor = useMemo(() => {
    const k = stage && stage.iso;
    if (k) { const i = tierKeys.indexOf(k); if (i >= 0) return ramp[i]; }
    return ramp[ramp.length - 1];
  }, [stage, tierKeys, ramp]); // the active step's tier color is what the spray "lays down"
  const [mainMetal, setMainMetal] = useState(null); // null | "steel" | "gold" for zone 0
  const zoneRamps = useMemo(() => [ramp, ...extraZones.map((z) => z.ramp)], [ramp, extraZones]);
  const zoneNames = useMemo(() => ["Main", ...extraZones.map((z) => z.name)], [extraZones]);
  const zoneMetals = useMemo(() => [mainMetal, ...extraZones.map((z) => z.metal || null)], [mainMetal, extraZones]);
  // What each zone LOOKS like (metal zones show the NMM ramp) — drives swatches + paint matching.
  const dispRamps = useMemo(() => zoneRamps.map((zr, zi) => (zoneMetals[zi] ? nmmRamp(zoneMetals[zi], zr.length) : zr)), [zoneRamps, zoneMetals]);
  const zoneMatches = useMemo(() => dispRamps.map((zr) => zr.map((c) => nearestPaint(c, paintBrand))), [dispRamps, paintBrand]);
  // Pinned accent preview: glaze the accent into every material's shadow tier, live on the model.
  const viewRamps = useMemo(() => {
    if (!previewAccent) return zoneRamps;
    return zoneRamps.map((zr) => { const r = [...zr]; r[0] = mix(r[0], previewAccent, 0.42); return r; });
  }, [zoneRamps, previewAccent]);
  const cycleMetal = (zi) => {
    const next = { null: "steel", steel: "gold", gold: null }[String(zoneMetals[zi])];
    if (zi === 0) setMainMetal(next);
    else setExtraZones((zs) => zs.map((z, k) => (k === zi - 1 ? { ...z, metal: next } : z)));
  };
  const accentMatches = useMemo(() => accents.map((c) => nearestPaint(c, paintBrand)), [accents, paintBrand]);
  // Zone assignment handlers — clicking the figure paints the active zone onto it.
  // 3D zone data lives in flat per-face arrays (fast enough to brush a 500k-face scan);
  // the sparse object form is only for persistence of the small built-in models.
  const zoneArrs = useRef({});
  const [zoneVer, setZoneVer] = useState(0);
  const zoneArrFor = (mdl) => {
    let a = zoneArrs.current[mdl];
    if (!a) {
      const mesh = MESH3D[mdl]; if (!mesh) return null;
      const g = glifyMesh(mesh);
      a = new Uint8Array(g.nFaces);
      const sparse = zoneMap3d[mdl];
      if (sparse) for (const k in sparse) { const i = +k; if (i < a.length) a[i] = sparse[k]; }
      zoneArrs.current[mdl] = a;
    }
    return a;
  };
  const zonePersistTimer = useRef(null);
  const scheduleZonePersist = (mdl) => {
    clearTimeout(zonePersistTimer.current);
    zonePersistTimer.current = setTimeout(() => {
      const a = zoneArrs.current[mdl]; if (!a) return;
      if (mdl === "custom") idb.set("customzones", a).catch(() => {});
      if (mdl === "custom" && a.length > 20000) return; // too big for the session JSON
      const sparse = {};
      for (let i = 0; i < a.length; i++) if (a[i]) sparse[i] = a[i];
      setZoneMap3d((m) => ({ ...m, [mdl]: sparse }));
    }, 400);
  };
  const undoStack = useRef([]), undoCur = useRef(null); // stroke-level undo, last 10
  const applyFaces = useCallback((idxs, closeStroke = false) => {
    const a = zoneArrFor(model); if (!a) return;
    let all = idxs;
    if (mirrorOn) { // symmetric assignment: each face also paints its mirror twin
      const mesh = MESH3D[model];
      const mir = mesh ? glMirrorMap(glifyMesh(mesh)) : null;
      if (mir) { all = [...idxs]; for (const f of idxs) { const m = mir[f]; if (m >= 0) all.push(m); } }
    }
    let rec = undoCur.current;
    if (!rec || rec.model !== model) {
      rec = { model, prev: new Map() };
      undoCur.current = rec;
      undoStack.current.push(rec);
      if (undoStack.current.length > 10) undoStack.current.shift();
    }
    for (const f of all) { if (!rec.prev.has(f)) rec.prev.set(f, a[f]); a[f] = activeZone; }
    if (closeStroke) undoCur.current = null;
    setZoneVer((v) => v + 1);
    scheduleZonePersist(model);
  }, [model, activeZone, mirrorOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const endStroke = useCallback(() => { undoCur.current = null; }, []);
  const undoZone = useCallback(() => {
    undoCur.current = null;
    const rec = undoStack.current.pop(); if (!rec) return;
    const a = zoneArrs.current[rec.model]; if (!a) return;
    for (const [f, v] of rec.prev) a[f] = v;
    setZoneVer((v) => v + 1);
    scheduleZonePersist(rec.model);
    setStatus("Undid zone stroke.");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target; // leave text editing alone — native undo owns inputs
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault(); undoZone();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [model, undoZone]);
  const pickFace = useCallback((i) => {
    const mesh = MESH3D[model]; if (!mesh) return;
    applyFaces(glZonePatch(glifyMesh(mesh), i), true); // patch mode: a click grabs the smooth connected patch
  }, [model, applyFaces]);
  const brushFaces = applyFaces; // brush mode: paint exactly what the cursor touches
  const clearZones = () => {
    setZoneMap3d((m) => ({ ...m, [model]: {} }));
    const a = zoneArrs.current[model]; if (a) a.fill(0);
    if (model === "custom") idb.del("customzones").catch(() => {});
    setZoneVer((v) => v + 1);
  };
  const addZone = () => {
    if (extraZones.length >= 3) return;
    const presets = [["Cloak", "#7a3b3b"], ["Armor", "#4a5a6a"], ["Skin", "#c98a6a"]];
    const [nm, hx] = presets[extraZones.length];
    setExtraZones((zs) => [...zs, { name: nm, base: hx, ramp: generateRamp(hx, numSteps) }]);
    setActiveZone(extraZones.length + 1); setZonePaint(true);
  };
  const removeZone = () => { // removes the last zone and unassigns it everywhere
    const z = extraZones.length; if (!z) return;
    const stripFlat = (v) => Object.fromEntries(Object.entries(v).filter(([, zz]) => zz !== z));
    setZoneMap3d((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, stripFlat(v)])));
    for (const a of Object.values(zoneArrs.current)) if (a) { for (let i = 0; i < a.length; i++) if (a[i] === z) a[i] = 0; }
    setZoneVer((v) => v + 1);
    setExtraZones((zs) => zs.slice(0, -1));
    setActiveZone((a) => (a >= z ? 0 : a));
  };
  const setZoneBase = (zi, hex) => { // zi >= 1
    setExtraZones((zs) => zs.map((zz, k) => (k === zi - 1 ? { ...zz, base: hex, ramp: generateRamp(hex, numSteps) } : zz)));
  };
  const only3d = !!(model && MODELS[model].only3d); // 3D-only model (no orthographic sheet)

  // load saved recipe names
  const refreshList = useCallback(async () => {
    if (!window.storage) return;
    try { const res = await window.storage.list("recipe:"); setRecipes((res?.keys || []).map((k) => k.replace("recipe:", ""))); }
    catch { setRecipes([]); }
  }, []);
  useEffect(() => { refreshList(); }, [refreshList]);

  const baseHsl = hexToHsl(base);
  // Suggestions: the swatch shown IS the exact color pinned to the wheel — no hidden remap.
  const suggestions = [
    { label: "Complementary", why: "Opposite hue — a thin glaze in the deepest recesses adds life.", hex: hslToHex(baseHsl.h + 180, baseHsl.s, clamp(baseHsl.l, 26, 52)) },
    { label: "Analogous +", why: "Neighbor — safe second material that keeps the model unified.", hex: hslToHex(baseHsl.h + 32, baseHsl.s, baseHsl.l) },
    { label: "Analogous −", why: "Other neighbor — pairs with the first for cloth or leather.", hex: hslToHex(baseHsl.h - 32, baseHsl.s, baseHsl.l) },
    { label: "Triadic", why: "Bolder contrast for one focal detail — a gem, a sigil.", hex: hslToHex(baseHsl.h + 120, baseHsl.s, clamp(baseHsl.l, 32, 60)) },
  ];

  const addAccent = (hex) => { setAccents((a) => (a.includes(hex) ? a : [...a, hex])); setPreviewAccent(hex); };
  const editStep = (i, hex) => setRamp((r) => r.map((c, k) => (k === i ? hex : c)));
  // Setting a new base hue or step count rebuilds the ramp. Loading a recipe does NOT —
  // load() restores the saved ramp (including hand-matched swatches), and nothing here overwrites it.
  const pickBase = (hex) => { setBase(hex); setRamp(generateRamp(hex, numSteps)); };
  const pickSteps = (n) => {
    setNumSteps(n); setRamp(generateRamp(base, n));
    setExtraZones((zs) => zs.map((z) => ({ ...z, ramp: generateRamp(z.base, n) }))); // keep every zone at the same step count
  };
  const save = async () => {
    const nm = name.trim(); if (!nm) { setStatus("Name it first."); return; }
    const recipe = { base, numSteps, ramp, accents, az, el, done, glazeOn, pooling, glazeLayers, method, spray, focus, orbOn, orbAz, orbEl, orbColor, orbInt, rimOn, rimAz, rimEl, rimColor, rimInt, zenithalOn, primerColor, lightOn, lightInt, extraZones, mainMetal };
    if (!window.storage) { setStatus("Storage unavailable in preview."); return; }
    try { await window.storage.set("recipe:" + nm, JSON.stringify(recipe)); setStatus("Saved “" + nm + "”."); refreshList(); }
    catch { setStatus("Save failed."); }
  };
  // Apply a (possibly untrusted/legacy) recipe object to state, sanitizing every field.
  // Shared by recipe-load and session-restore so both stay crash-proof.
  const applyRecipe = useCallback((r) => {
    const validHex = (h) => typeof h === "string" && /^#[0-9a-fA-F]{6}$/.test(h);
    const num = (v, d, lo, hi) => (Number.isFinite(v) ? clamp(v, lo, hi) : d);
    const steps = [3, 4, 5].includes(Number(r.numSteps)) ? Number(r.numSteps) : 5;
    const base = validHex(r.base) ? r.base : "#5f8a4a";
    const ramp = Array.isArray(r.ramp) && r.ramp.length === steps && r.ramp.every(validHex)
      ? r.ramp : generateRamp(base, steps);
    const layers = Array.isArray(r.glazeLayers) && r.glazeLayers.length &&
      r.glazeLayers.every((l) => l && validHex(l.color) && Number.isFinite(l.opacity))
      ? r.glazeLayers : [{ color: "#7a5a3a", opacity: 0.3 }];
    setBase(base); setNumSteps(steps); setRamp(ramp);
    setAccents(Array.isArray(r.accents) ? r.accents.filter(validHex) : []);
    setAz(num(r.az, 0, 0, 360)); setEl(num(r.el, 32, -20, 90)); setPreviewAccent(null);
    setDone(r.done && typeof r.done === "object" ? r.done : {});
    setGlazeOn(!!r.glazeOn); setPooling(num(r.pooling, 0.6, 0, 0.9)); setGlazeLayers(layers);
    setMethod(r.method === "airbrush" ? "airbrush" : "brush");
    setSpray(!!r.spray && r.method === "airbrush"); setFocus(num(r.focus, 0.5, 0, 1)); // spray without airbrush would be stranded on with no off-switch

    setOrbOn(!!r.orbOn); setOrbAz(num(r.orbAz, 200, 0, 360)); setOrbEl(num(r.orbEl, 0, -20, 90));
    setOrbColor(validHex(r.orbColor) ? r.orbColor : "#3fb8ff"); setOrbInt(num(r.orbInt, 0.5, 0, 1));
    setRimOn(!!r.rimOn); setRimAz(num(r.rimAz, 200, 0, 360)); setRimEl(num(r.rimEl, 15, -20, 90));
    setRimColor(validHex(r.rimColor) ? r.rimColor : "#9fc8ff"); setRimInt(num(r.rimInt, 0.4, 0, 1));
    setZenithalOn(!!r.zenithalOn);
    setPrimerColor(validHex(r.primerColor) ? r.primerColor : "#1b1b1b");
    setLightOn(r.lightOn !== false); // older recipes predate the toggle — treat as lit
    setLightInt(num(r.lightInt, 1, 0.2, 1.5));
    const metalOk = (m) => (m === "steel" || m === "gold" ? m : null);
    setMainMetal(metalOk(r.mainMetal));
    const zones = Array.isArray(r.extraZones)
      ? r.extraZones.slice(0, 3).filter((z) => z && validHex(z.base)).map((z, k) => ({
          name: typeof z.name === "string" && z.name.trim() ? z.name.slice(0, 24) : "Zone " + (k + 2),
          base: z.base,
          metal: metalOk(z.metal),
          ramp: Array.isArray(z.ramp) && z.ramp.length === steps && z.ramp.every(validHex) ? z.ramp : generateRamp(z.base, steps),
        }))
      : [];
    setExtraZones(zones);
    // Faces assigned to zones this recipe doesn't have would render inconsistently and
    // silently resurrect if zones are re-added — unassign them, like removeZone does.
    const zMax = zones.length;
    let stale = false;
    for (const a of Object.values(zoneArrs.current)) if (a) {
      for (let i = 0; i < a.length; i++) if (a[i] > zMax) { a[i] = 0; stale = true; }
    }
    if (stale) {
      const strip = (v) => Object.fromEntries(Object.entries(v).filter(([, zz]) => zz <= zMax));
      setZoneMap3d((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, strip(v)])));
      setZoneVer((v) => v + 1);
    }
    setActiveZone(0);
  }, []);
  const load = async (nm) => {
    if (!window.storage) return;
    try {
      const res = await window.storage.get("recipe:" + nm); if (!res) return;
      applyRecipe(JSON.parse(res.value));
      setName(nm); setStatus("Loaded “" + nm + "”.");
    } catch { setStatus("Load failed."); }
  };
  const del = async (nm) => {
    if (!window.storage) return;
    try { await window.storage.delete("recipe:" + nm); refreshList(); setStatus("Deleted “" + nm + "”."); } catch {}
  };
  // Recipes live in this browser's storage only — export/import moves them between devices.
  const exportRecipes = async () => {
    if (!window.storage) return;
    try {
      const res = await window.storage.list("recipe:");
      const keys = res?.keys || [];
      if (!keys.length) { setStatus("No recipes to export."); return; }
      const out = {};
      for (const k of keys) { const r = await window.storage.get(k); if (r) { try { out[k.replace("recipe:", "")] = JSON.parse(r.value); } catch {} } }
      const blob = new Blob([JSON.stringify({ app: "lightbench", version: 1, recipes: out }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "light-bench-recipes.json"; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setStatus("Exported " + Object.keys(out).length + " recipe(s).");
    } catch { setStatus("Export failed."); }
  };
  const importRecipes = async (file) => { // merges; same-named recipes are overwritten
    if (!window.storage || !file) return;
    try {
      const data = JSON.parse(await file.text());
      const rs = data && typeof data.recipes === "object" && data.recipes ? data.recipes : null;
      if (!rs) throw new Error("wrong shape");
      let n = 0;
      for (const [nm, r] of Object.entries(rs)) {
        if (!nm.trim() || !r || typeof r !== "object") continue;
        await window.storage.set("recipe:" + nm.trim().slice(0, 60), JSON.stringify(r)); n++;
      }
      refreshList(); setStatus(n ? "Imported " + n + " recipe(s)." : "No recipes in that file.");
    } catch { setStatus("Couldn't read that file — expected a Light Bench recipe export."); }
  };

  const figRef = useRef(null);
  const ready = useRef(false);
  // Restore the last session (model + recipe/light/glaze) on first load.
  useEffect(() => {
    (async () => {
      if (window.storage) {
        try { // restore an imported mesh first, so a "custom" session can reopen onto it
          const rec = await idb.get("custommesh").catch(() => null);
          if (rec && rec.kind === "typed" && rec.pos) { meshCache.custom = buildMeshTyped(rec.pos); if (rec.target) setDetail(rec.target); setCustomReady(true); }
          else if (rec && rec.kind === "classic" && rec.dec) { meshCache.custom = buildMeshIndexed(rec.dec.verts, rec.dec.faces); if (rec.target) setDetail(rec.target); setCustomReady(true); }
          else {
            const cm = await window.storage.get("custommesh:last"); // legacy location
            if (cm) { const d = JSON.parse(cm.value); meshCache.custom = buildMeshIndexed(d.verts, d.faces); if (d.target) setDetail(d.target); setCustomReady(true); }
          }
          const zs = await idb.get("customzones").catch(() => null);
          if (zs && zs.length && meshCache.custom) { zoneArrs.current.custom = zs; setZoneVer((v) => v + 1); }
        } catch {}
        try {
          const res = await window.storage.get("session:last");
          if (res) {
            const r = JSON.parse(res.value);
            applyRecipe(r);
            if (r.model && MODELS[r.model] && (r.model !== "custom" || meshCache.custom)) setModel(r.model);
            if (typeof r.activeStage === "string") setActiveStage(r.activeStage);
            if (typeof r.paintBrand === "string") setPaintBrand(r.paintBrand);
            if (r.zoneMap3d && typeof r.zoneMap3d === "object") {
              setZoneMap3d(r.zoneMap3d);
              // the first render may have already cached zeroed zone arrays via zoneArrFor —
              // drop them so they rebuild from the restored sparse maps ("custom" came from IDB above)
              for (const k of Object.keys(zoneArrs.current)) if (k !== "custom") delete zoneArrs.current[k];
              setZoneVer((v) => v + 1);
            }
            if (r.openSec && typeof r.openSec === "object") setOpenSec(r.openSec);
            if (typeof r.smoothShade === "boolean") setSmoothShade(r.smoothShade);
            if (Number.isFinite(r.brushSize)) setBrushSize(clamp(r.brushSize, 8, 60));
            if (typeof r.mirrorOn === "boolean") setMirrorOn(r.mirrorOn);
          }
        } catch {}
      }
      ready.current = true;
    })();
  }, [applyRecipe]);
  // Save the session whenever it changes (only after the initial restore has run).
  const saveTimer = useRef(null);
  useEffect(() => {
    if (!ready.current || !window.storage || !model) return;
    // Debounced: sliders fire this every tick; one write after the user pauses is enough.
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try { window.storage.set("session:last", JSON.stringify({ model, activeStage, base, numSteps, ramp, accents, az, el, done, glazeOn, pooling, glazeLayers, method, spray, focus, orbOn, orbAz, orbEl, orbColor, orbInt, rimOn, rimAz, rimEl, rimColor, rimInt, zenithalOn, primerColor, lightOn, lightInt, smoothShade, paintBrand, extraZones, mainMetal, zoneMap3d, openSec, brushSize, mirrorOn })); } catch {}
    }, 300);
    return () => clearTimeout(saveTimer.current);
  }, [model, activeStage, base, numSteps, ramp, accents, az, el, done, glazeOn, pooling, glazeLayers, method, spray, focus, orbOn, orbAz, orbEl, orbColor, orbInt, rimOn, rimAz, rimEl, rimColor, rimInt, zenithalOn, primerColor, lightOn, lightInt, smoothShade, paintBrand, extraZones, mainMetal, zoneMap3d, openSec, brushSize, mirrorOn]);

  // Export a painting-reference PNG: the figure as shown + value ramp, accents, light & glaze.
  const exportPNG = () => {
    const pad = 28, W = 740, figW = 300, figH = 380, top = 92;
    const cv = document.createElement("canvas");
    // right column: ramp grid + per-zone paint lists + accents + light/glaze lines — size to whichever is taller
    const paintsH = zoneMatches.reduce((s, m) => s + (zoneMatches.length > 1 ? 15 : 0) + m.length * 16, 27);
    const rightH = 22 + Math.ceil(tiers.length / 4) * 72 + 14 + paintsH + (accents.length ? 54 : 0) + 60;
    cv.width = W;
    cv.height = top + Math.max(figH, rightH) + 40;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#141611"; ctx.fillRect(0, 0, W, cv.height);
    ctx.fillStyle = "#e7e5e4"; ctx.font = "bold 24px Segoe UI, system-ui, sans-serif";
    ctx.fillText("THE LIGHT BENCH", pad, 40);
    ctx.fillStyle = "#a8a29e"; ctx.font = "14px Segoe UI, system-ui, sans-serif";
    ctx.fillText((name.trim() || "Painting reference") + "  ·  " + MODELS[model].label, pad, 64);
    const fx = pad, fy = top;
    const live = only3d && figRef.current ? figRef.current.querySelector("canvas") : null;
    if (live) {
      const ar = live.width / live.height; let dw = figW, dh = figW / ar;
      if (dh > figH) { dh = figH; dw = figH * ar; }
      ctx.drawImage(live, fx + (figW - dw) / 2, fy, dw, dh);
    }
    let rx = fx + figW + 34, ry = top + 8;
    ctx.fillStyle = "#a8a29e"; ctx.font = "11px Segoe UI, system-ui, sans-serif"; ctx.fillText("VALUE RAMP", rx, ry); ry += 14;
    const sw = 42, gap = 8;
    tiers.forEach((t, i) => {
      const x = rx + (i % 4) * (sw + gap), y = ry + Math.floor(i / 4) * (sw + 30);
      ctx.fillStyle = ramp[i]; ctx.fillRect(x, y, sw, sw);
      ctx.strokeStyle = "#00000044"; ctx.strokeRect(x, y, sw, sw);
      ctx.fillStyle = "#d6d3d1"; ctx.font = "10px Segoe UI, system-ui, sans-serif"; ctx.fillText(t.label, x, y + sw + 13);
      ctx.fillStyle = "#78716c"; ctx.fillText(ramp[i], x, y + sw + 25);
    });
    ry += Math.ceil(tiers.length / 4) * (sw + 30) + 14;
    ctx.fillStyle = "#a8a29e"; ctx.font = "11px Segoe UI, system-ui, sans-serif";
    ctx.fillText("PAINTS — " + (paintBrand ? PAINT_BRANDS[paintBrand] : "closest of any brand"), rx, ry); ry += 16;
    zoneMatches.forEach((matches, zi) => {
      if (zoneMatches.length > 1) {
        ctx.fillStyle = "#a8a29e"; ctx.font = "bold 10px Segoe UI, system-ui, sans-serif";
        ctx.fillText(zoneNames[zi].toUpperCase(), rx, ry); ry += 15;
      }
      tiers.forEach((t, i) => {
        const m = matches[i]; if (!m) return;
        ctx.fillStyle = dispRamps[zi][i]; ctx.fillRect(rx, ry - 9, 11, 11);
        ctx.strokeStyle = "#00000044"; ctx.strokeRect(rx, ry - 9, 11, 11);
        ctx.fillStyle = "#d6d3d1"; ctx.font = "11px Segoe UI, system-ui, sans-serif";
        ctx.fillText(t.label + " — " + m.name + " (" + PAINT_BRANDS[m.brand] + ")", rx + 17, ry);
        ry += 16;
      });
    });
    ry += 11;
    if (accents.length) {
      ctx.fillStyle = "#a8a29e"; ctx.font = "11px Segoe UI, system-ui, sans-serif"; ctx.fillText("ACCENTS", rx, ry); ry += 14;
      accents.slice(0, 8).forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(rx + i * 26, ry, 22, 22); ctx.strokeStyle = "#facc1577"; ctx.strokeRect(rx + i * 26, ry, 22, 22); });
      ry += 40;
    }
    ctx.fillStyle = "#d6d3d1"; ctx.font = "12px Segoe UI, system-ui, sans-serif";
    ctx.fillText("Light — orbit " + Math.round(az) + "°, height " + Math.round(el) + "°, intensity " + Math.round(lightInt * 100) + "%", rx, ry); ry += 20;
    ctx.fillText("Paint — " + (glazeOn ? "Glaze · pooling " + Math.round(pooling * 100) + "% · " + glazeLayers.length + " layers" : "Opaque"), rx, ry);
    const fname = (name.trim() || "light-bench") + ".png";
    // On phones (esp. installed PWAs) the share sheet beats a silent download; fall back to the <a download>.
    // Touch-only: desktop keeps the direct download it always had.
    cv.toBlob(async (blob) => {
      if (COARSE && blob && navigator.canShare) {
        const file = new File([blob], fname, { type: "image/png" });
        if (navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: "The Light Bench" }); setStatus("Shared PNG."); return; }
          catch (e) { if (e && e.name === "AbortError") return; } // user closed the sheet — not a failure
        }
      }
      const a = document.createElement("a");
      a.download = fname;
      a.href = cv.toDataURL("image/png"); a.click();
      setStatus("Exported PNG.");
    }, "image/png");
  };

  // light compass dot
  const cx = 26 + 18 * Math.sin((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180);
  const cy = 26 - 18 * Math.cos((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180);
  const orbCx = 26 + 18 * Math.sin((orbAz * Math.PI) / 180) * Math.cos((orbEl * Math.PI) / 180);
  const orbCy = 26 - 18 * Math.cos((orbAz * Math.PI) / 180) * Math.cos((orbEl * Math.PI) / 180);

  // Import an STL/OBJ: parse -> normalize -> decimate -> cache + persist, then open it.
  const importModel = async (file, target = detail) => {
    setDetail(target);
    setImportMsg("Reading “" + file.name + "”…");
    try {
      const buf = await file.arrayBuffer();
      if (target >= 100000) { // Full: the actual STL, GPU-rendered (capped, not simplified below the cap)
        const pos = decimateTypedPos(normalizeTypedPos(parseToTypedPos(file.name, buf)), FULL_DETAIL);
        meshCache.custom = buildMeshTyped(pos);
        try { await idb.set("custommesh", { kind: "typed", pos, target }); } catch {}
      } else {
        const dec = importMeshFromFile(file.name, buf, target);
        dec.target = target; // remembered so the detail picker restores with the mesh
        meshCache.custom = buildMeshIndexed(dec.verts, dec.faces);
        try { await idb.set("custommesh", { kind: "classic", dec, target }); }
        catch { try { await window.storage?.set("custommesh:last", JSON.stringify(dec)); } catch {} }
      }
      try { await idb.del("customzones"); } catch {}
      zoneArrs.current.custom = null; // face indices don't survive a new mesh
      setZoneMap3d((m) => ({ ...m, custom: {} }));
      setZoneVer((v) => v + 1);
      setCustomReady(true); setImportMsg("");
      setModel("custom");
    } catch (e) { setImportMsg(String(e?.message || e)); }
  };



  return (
    <div className="min-h-screen w-full text-stone-200 lg:h-screen lg:overflow-hidden flex flex-col"
      style={{ background: "#141611", fontFamily: "Segoe UI, system-ui, sans-serif" }}>
      {status && (
        <div role="status" aria-live="polite"
          className="fixed top-3 right-3 z-50 text-xs text-stone-100 bg-stone-800/95 border border-stone-600 rounded-lg px-3 py-2 shadow-lg">
          {status}
        </div>
      )}
      <div className="max-w-6xl w-full mx-auto px-4 pt-6 pb-3 flex-none">
        <p className="text-[11px] tracking-[0.32em] uppercase text-stone-500 mb-1">Miniature painting · light & value</p>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <h1 className="text-2xl sm:text-3xl font-extrabold uppercase tracking-wide leading-none mb-1.5">
            The <span style={{ color: ramp[ramp.length - 1] }}>Light</span> Bench
          </h1>
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[9px] uppercase tracking-wider text-stone-600 mr-0.5">Extras</span>
              {[
                ["Light direction", lightOn, () => setLightOn(!lightOn), "Plan directional light and value tiers — switch off for a flat paint scheme"],
                ["Airbrush", method === "airbrush", () => { const next = method === "airbrush" ? "brush" : "airbrush"; setMethod(next); if (next !== "airbrush") setSpray(false); }, "Rewrite every step for airbrush workflow"],
                ["Rim light", rimOn, () => setRimOn(!rimOn), "A second, cooler light — controls appear in the Extras section below"],
                ["Glow", orbOn, () => setOrbOn(!orbOn), "Object-source glow (OSL) — controls appear in the Extras section below"],
              ].map(([lb, on, fn, tip]) => (
                <button key={lb} onClick={fn} aria-pressed={on} title={tip}
                  className={"px-2.5 py-1 rounded-full text-[11px] border transition-colors " +
                    (on ? "border-sky-500 text-sky-300 bg-sky-500/10" : "border-stone-700 text-stone-400 hover:text-stone-200")}>
                  {lb}
                </button>
              ))}
            </div>
            <button onClick={exportPNG} title="Download a reference image to take to the bench"
              className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-200 border border-stone-700 hover:border-stone-500 rounded-full px-3 py-1.5">
              <Download size={12} /> Export PNG
            </button>
            <div className="flex items-center rounded-full border border-stone-700 overflow-hidden text-[11px]" title="Which model is on the bench">
              <button onClick={() => setModel("male")}
                className={"px-3 py-1.5 transition-colors " + (model === "male" ? "bg-stone-700 text-stone-100" : "text-stone-400 hover:text-stone-200")}>
                Study figure
              </button>
              <button onClick={() => customReady && setModel("custom")}
                title={customReady ? "Your imported model" : "Import an STL first"}
                className={"px-3 py-1.5 transition-colors " + (model === "custom" ? "bg-stone-700 text-stone-100" : customReady ? "text-stone-400 hover:text-stone-200" : "text-stone-600 cursor-default")}>
                Your model
              </button>
            </div>
            <label className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-200 border border-stone-700 hover:border-stone-500 rounded-full px-3 py-1.5 cursor-pointer"
              title="Load an STL or OBJ from your bench — it becomes “Your model”">
              <input type="file" accept=".stl,.obj" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) importModel(f); e.target.value = ""; }} />
              <Upload size={12} /> Import STL
            </label>
            <select value={detail} onChange={(e) => setDetail(+e.target.value)} title="Import detail — Full renders the actual STL on the GPU"
              className="bg-stone-900 border border-stone-700 rounded-full text-[11px] text-stone-400 px-2 py-1.5">
              <option value={3400}>Standard</option>
              <option value={8000}>High</option>
              <option value={14000}>Ultra</option>
              <option value={500000}>Full</option>
            </select>
            {importMsg && <span className="text-[11px] text-amber-400">{importMsg}</span>}
          </div>
        </div>
        <p className="text-stone-400 text-[13px] max-w-2xl">
          One light, one figure, four views. Move the light and watch where each value lands. Build a recipe,
          check it on the wheel, then walk the steps.
        </p>
      </div>

      <div className="max-w-6xl w-full mx-auto px-4 pb-4 flex-1 min-h-0 flex flex-col lg:flex-row gap-5 items-start">
          {/* ===== MODEL PANE (fits to viewport height) ===== */}
          <div className="w-full sticky top-[env(safe-area-inset-top,0px)] z-10 max-h-[42vh] overflow-y-auto bg-[#141611] lg:static lg:z-auto lg:max-h-none lg:bg-transparent lg:w-[36%] lg:flex-none lg:h-full controls-scroll lg:pr-1">
            <div ref={figRef} className="relative rounded-xl border border-stone-700/60 p-3"
              style={{ background: "radial-gradient(120% 90% at 50% 0%, #20241b, #141611 75%)" }}>
              {zonePaint && (
                <div className="absolute top-2 left-2 right-2 z-20">
                  <div className="inline-flex flex-wrap items-center gap-1 max-w-full rounded-xl border border-stone-700 bg-stone-900/85 px-2 py-1.5">
                    {zoneNames.map((nm, zi) => (
                      <button key={zi} onClick={() => setActiveZone(zi)} aria-pressed={activeZone === zi}
                        className={"flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] border " +
                          (activeZone === zi ? "border-lime-400 text-stone-100" : "border-transparent text-stone-300 hover:border-stone-500")}>
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: dispRamps[zi][Math.floor(dispRamps[zi].length / 2)] }} />
                        {nm}
                      </button>
                    ))}
                    <span className="w-px h-4 bg-stone-700 mx-1" />
                    <button onClick={() => setZoneMode(zoneMode === "patch" ? "brush" : "patch")}
                      title={zoneMode === "patch" ? "Auto fill: a click grabs the whole smooth patch. Switch to brush." : "Brush: drag paints under the cursor. Switch to auto fill."}
                      className="px-2 py-1 rounded-full text-[10px] border border-transparent text-stone-300 hover:border-stone-500">
                      {zoneMode === "patch" ? "auto fill" : "brush"}
                    </button>
                    {zoneMode === "brush" && (
                      <input type="range" min={8} max={60} value={brushSize} onChange={(e) => setBrushSize(+e.target.value)}
                        title="Brush size" className="w-16 accent-lime-500" />
                    )}
                    <button onClick={() => setMirrorOn(!mirrorOn)} aria-pressed={mirrorOn}
                      title="Mirror: also paint each face's twin across the centerline"
                      className={"px-2 py-1 rounded-full text-[10px] border " +
                        (mirrorOn ? "border-lime-400 text-lime-300" : "border-transparent text-stone-300 hover:border-stone-500")}>
                      mirror
                    </button>
                    <button onClick={undoZone} title="Undo the last stroke (Ctrl+Z)"
                      className="px-2 py-1 rounded-full text-[10px] border border-transparent text-stone-300 hover:border-stone-500">
                      undo
                    </button>
                    <span className="w-px h-4 bg-stone-700 mx-1" />
                    <button onClick={() => setZonePaint(false)} title="Stop painting zones — drag orbits again"
                      className="px-2 py-1 rounded-full text-[10px] border border-lime-500/60 text-lime-300">
                      done
                    </button>
                  </div>
                </div>
              )}
              {only3d && MESH3D[model] ? (
                <Model3D mesh={MESH3D[model]} L={L} ramp={ramp}
                  mode={zonePaint ? "paint" : stage.mode} isoTier={zonePaint ? null : stage.iso}
                  tierKeys={tierKeys} glazeOn={zonePaint ? false : glazeOn} glazeLayers={glazeLayers} pooling={pooling}
                  valueMode={zonePaint ? false : valueMode}
                  sprayOn={zonePaint ? false : sprayActive} focus={focus} sprayColor={sprayColor}
                  orbOn={orbOn} Lorb={Lorb} orbColor={orbColor} orbInt={orbInt}
                  zoneRamps={viewRamps} zoneArr={zoneArrFor(model)} zoneVer={zoneVer} zoneMetals={zoneMetals}
                  onPickFace={zonePaint && zoneMode === "patch" ? pickFace : null}
                  brushSize={zonePaint && zoneMode === "brush" ? brushSize : 0}
                  onBrushFaces={zonePaint && zoneMode === "brush" ? brushFaces : null}
                  onStrokeEnd={endStroke} smoothShade={smoothShade}
                  rimOn={rimOn} Lrim={Lrim} rimColor={rimColor} rimInt={rimInt} primerColor={primerColor} lightOn={lightOn} lightInt={lightInt}
                  onToggleSmooth={() => setSmoothShade((v) => !v)} />
              ) : null}
              <div className="mt-3 pt-3 border-t border-stone-700/50 flex items-center justify-between gap-2">
                <button onClick={() => setValueMode((v) => !v)} aria-pressed={valueMode}
                  title="Squint test: show value (greyscale) instead of color"
                  className={"text-[10px] uppercase tracking-[0.15em] px-2 py-1 rounded border " +
                    (valueMode ? "border-stone-300 text-stone-100" : "border-stone-700 text-stone-500 hover:border-stone-500")}>
                  Value study
                </button>
                <span className="text-xs text-stone-300 font-medium">
                  {sprayActive
                    ? <span className="text-sky-300">Spray coverage · {stage.name}</span>
                    : <>
                        {stage.name}
                        {stage.iso ? <span className="text-stone-500"> · isolating {(tiers.find((t) => t.key === stage.iso) || {}).label} tier</span> : null}
                        {valueMode && stage.mode === "paint" ? <span className="text-stone-400"> · value</span> : null}
                        {glazeOn && stage.mode === "paint" ? <span className="text-sky-300"> · glaze</span> : null}
                      </>}
                </span>
              </div>
              <div className="mt-2 pt-2 border-t border-stone-700/40">
                <div className="flex flex-wrap gap-1">
                  {stages.map((s, i) => (
                    <button key={s.id} onClick={() => setActiveStage(s.id)} aria-pressed={s.id === activeStage}
                      className={"px-2 py-1 rounded-full text-[10px] border " +
                        (s.id === activeStage ? "border-lime-400 text-stone-100 bg-stone-800/80" : done[s.id] ? "border-stone-700/60 text-stone-600 line-through" : "border-stone-700 text-stone-300 hover:border-stone-500")}>
                      {i + 1} · {s.name}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-stone-400 mt-1.5 leading-snug">{stage.note}</p>
              </div>
              {!sprayActive && stage.mode !== "paint" && (
                <p className="mt-2 text-[10.5px] text-stone-500 leading-snug">
                  {stage.mode === "prime"
                    ? "Black on purpose — the primer, before any color goes down."
                    : "Grey on purpose — the value underpainting. Tap a paint step (Base) to see your colors."}
                </p>
              )}
            </div>
          </div>

          {/* ===== CONTROLS PANE (scrolls internally on desktop) ===== */}
          <div className="flex-1 w-full min-w-0 lg:h-full lg:overflow-y-auto lg:pr-2 controls-scroll">

        {/* ===== COLORS & MATERIALS ===== */}
        <Section icon={<Palette size={15} />} title="Colors & materials" {...sec("colors")}>
          <p className="text-[11px] text-stone-500 mb-3 leading-snug">
            Every material on the mini gets its own scheme, shaded by the same light. Pick a row and
            paint it onto the model; the <b className="text-stone-300">matte / steel / gold</b> toggle
            turns a material into NMM metal.
          </p>
          <div className="space-y-1.5 mb-3">
            {zoneNames.map((nm, zi) => (
              <div key={zi} className={"flex items-center gap-2 rounded-lg border px-2 py-1.5 " +
                (activeZone === zi ? "border-stone-400 bg-stone-800/40" : "border-stone-700/50")}>
                <button onClick={() => { setActiveZone(zi); setZonePaint(true); }} aria-pressed={activeZone === zi}
                  className={"w-3.5 h-3.5 rounded-full flex-none border " + (activeZone === zi ? "bg-lime-500 border-lime-500" : "border-stone-600")}
                  title={"Make “" + nm + "” the active zone"} />
                <input type="color" value={zi === 0 ? base : extraZones[zi - 1].base}
                  onChange={(e) => (zi === 0 ? pickBase(e.target.value) : setZoneBase(zi, e.target.value))}
                  className="w-7 h-7 flex-none bg-transparent border-0 cursor-pointer" title="Zone base color" />
                {zi === 0
                  ? <span className="text-xs text-stone-200 flex-1">Main</span>
                  : <input value={extraZones[zi - 1].name}
                      onChange={(e) => setExtraZones((zs) => zs.map((z, k) => (k === zi - 1 ? { ...z, name: e.target.value } : z)))}
                      className="flex-1 min-w-0 bg-transparent border-b border-stone-700 text-xs text-stone-200 px-1 py-0.5" />}
                <button onClick={() => cycleMetal(zi)}
                  title="Cycle the zone's material: matte paint, NMM steel, NMM gold"
                  className={"flex-none px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider border " +
                    (zoneMetals[zi] ? "border-amber-400/60 text-amber-300" : "border-stone-700 text-stone-500 hover:text-stone-300")}>
                  {zoneMetals[zi] || "matte"}
                </button>
                <div className="flex gap-0.5 flex-none">
                  {dispRamps[zi].map((c, k) => <div key={k} className="w-2.5 h-5" style={{ background: c }} />)}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {extraZones.length < 3 && (
              <button onClick={addZone} className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs border border-stone-700 hover:border-stone-500 text-stone-300">
                <Plus size={12} /> Add material
              </button>
            )}
            {extraZones.length > 0 && (
              <button onClick={removeZone} className="px-3 py-1.5 rounded-md text-xs border border-stone-700 hover:border-red-500/60 text-stone-400">
                Remove last
              </button>
            )}
            <button onClick={() => setZonePaint(!zonePaint)} aria-pressed={zonePaint}
              className={"px-3 py-1.5 rounded-md text-xs border transition-colors " +
                (zonePaint ? "border-lime-500 text-lime-300 bg-lime-500/10" : "border-stone-700 text-stone-300 hover:border-stone-500")}>
              {zonePaint ? "Painting zones — controls are on the figure" : "Paint zones on the model…"}
            </button>
            <button onClick={undoZone} title="Undo the last zone stroke (Ctrl+Z)"
              className="px-3 py-1.5 rounded-md text-xs border border-stone-700 hover:border-stone-500 text-stone-400">
              Undo
            </button>
            <button onClick={clearZones} className="px-3 py-1.5 rounded-md text-xs border border-stone-700 hover:border-stone-500 text-stone-400">
              Clear assignments
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-4 mb-4 pt-3 border-t border-stone-800">
            <div className="flex items-center gap-1 text-sm text-stone-300">
              Value steps
              {[3, 4, 5].map((n) => (
                <button key={n} onClick={() => pickSteps(n)}
                  className={"w-8 h-8 rounded-md text-sm border " + (numSteps === n ? "border-stone-300 text-white" : "border-stone-700 text-stone-400")}>
                  {n}
                </button>
              ))}
            </div>
            <button onClick={() => setRamp(generateRamp(base, numSteps))}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md text-xs border border-stone-700 hover:border-stone-500 text-stone-300">
              <RotateCcw size={13} /> Auto-generate ramp
            </button>
          </div>
          <div className="flex flex-wrap gap-3">
            {ramp.slice(0, tiers.length).map((c, i) => (
              <div key={i} className="flex flex-col items-center gap-1">
                <label className="cursor-pointer">
                  <Hex color={c} size={42} />
                  <input type="color" value={c} aria-label={"Set " + tiers[i].label + " color"}
                    onChange={(e) => editStep(i, e.target.value)} className="sr-only" />
                </label>
                <span className="text-[10px] uppercase tracking-wider text-stone-400">{tiers[i].label}</span>
                <span className="text-[9px] text-stone-600">{c}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-stone-500 mt-3 max-w-xl">
            Highlights step lighter and warm toward yellow; the shadow steps darker and cools toward blue — that
            temperature shift is what reads as real light rather than a flat tint. Tap any swatch to match a specific paint.
          </p>
          <div className="pt-3 mt-4 border-t border-stone-800">
            <label className="flex items-center gap-2 text-xs text-stone-300 cursor-pointer">
              <input type="checkbox" checked={glazeOn} onChange={(e) => setGlazeOn(e.target.checked)} />
              Glaze preview <span className="text-stone-500">— a thin wash over whatever's shown: unifying over paint, slapchop over the Zenithal step</span>
            </label>
            {glazeOn && (
              <div className="mt-2 space-y-2">
                {glazeLayers.map((ly, li) => (
                  <div key={li} className="flex items-center gap-3">
                    <input type="color" value={ly.color}
                      onChange={(e) => setGlazeLayers((ls) => ls.map((l, k) => (k === li ? { ...l, color: e.target.value } : l)))}
                      className="w-8 h-8 flex-none bg-transparent border-0 cursor-pointer" title={"Glaze layer " + (li + 1) + " color"} />
                    <div className="flex-1">
                      <Slider label={glazeLayers.length > 1 ? "Layer " + (li + 1) + " strength" : "Glaze strength"}
                        value={Math.round((ly.opacity ?? 0.3) * 100)} min={5} max={95}
                        onChange={(v) => setGlazeLayers((ls) => ls.map((l, k) => (k === li ? { ...l, opacity: v / 100 } : l)))} suffix="%" />
                    </div>
                    {glazeLayers.length > 1 && (
                      <button aria-label={"Remove glaze layer " + (li + 1)}
                        onClick={() => setGlazeLayers((ls) => ls.filter((_, k) => k !== li))}
                        className="text-stone-600 hover:text-red-400 flex-none"><Trash2 size={13} /></button>
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-4 pt-1">
                  {glazeLayers.length < 5 && (
                    <button onClick={() => setGlazeLayers((ls) => [...ls, { color: ramp[Math.min(ls.length + 1, ramp.length - 1)], opacity: 0.3 }])}
                      className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-200 border border-stone-700 hover:border-stone-500 rounded-full px-3 py-1.5">
                      <Plus size={12} /> Add layer
                    </button>
                  )}
                  <div className="flex-1">
                    <Slider label="Recess pooling" value={Math.round(pooling * 100)} min={0} max={90}
                      onChange={(v) => setPooling(v / 100)} suffix="%" />
                  </div>
                </div>
                <p className="text-[11px] text-stone-500 leading-snug">
                  Layers composite in order, each thinning on the lit tops. Pooling is how strongly a glaze
                  drains off the highlights and gathers in the recesses — 0% coats evenly.
                </p>
              </div>
            )}
          </div>
        </Section>

        {/* ===== COLOR WHEEL ===== */}
        <Section icon={<Lightbulb size={15} />} title="Wheel & cohesion" {...sec("wheel")}>
          <div className="flex flex-col sm:flex-row gap-6 items-start">
            <ColorWheel ramp={ramp} accents={accents} base={base} onPickBase={pickBase}
              previewAccent={previewAccent} onSelectAccent={setPreviewAccent} />
            <div className="flex-1 w-full">
              <p className="text-[11px] text-stone-400 mb-1 max-w-md">
                White dots are your ramp; the dotted line is its hue drift. Two separate actions:
              </p>
              <ul className="text-[11px] text-stone-500 mb-3 max-w-md space-y-0.5">
                <li><span className="text-stone-300">Tap the wheel</span> → sets your <b>base</b> hue (rebuilds the ramp).</li>
                <li><span className="text-stone-300">Tap a card below</span> → pins that exact color as an <b>accent</b>.</li>
              </ul>
              <div className="grid sm:grid-cols-2 gap-2">
                {suggestions.map((s) => {
                  const pinned = accents.includes(s.hex);
                  return (
                    <button key={s.label} onClick={() => addAccent(s.hex)}
                      className={"flex items-start gap-3 text-left p-2.5 rounded-lg border " +
                        (pinned ? "border-yellow-500/70 bg-stone-800/40" : "border-stone-700/70 hover:border-stone-500")}>
                      <span className="w-7 h-7 rounded-md flex-none mt-0.5" style={{ background: s.hex }} />
                      <span>
                        <span className="text-xs font-semibold text-stone-200 flex items-center gap-1">
                          {s.label} {pinned ? <Check size={11} /> : <Plus size={11} />}
                        </span>
                        <span className="block text-[10.5px] text-stone-500 leading-snug">{s.why}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {accents.length > 0 && (
                <div className="mt-3">
                  <span className="text-[10px] uppercase tracking-wider text-stone-500">Accents — tap to preview, ✕ to remove</span>
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                    {accents.map((c, i) => (
                      <span key={i} className="relative inline-flex">
                        <button onClick={() => setPreviewAccent(c)} title="preview in recesses" aria-label={"Preview accent " + c}
                          className={"w-7 h-7 rounded-md border " + (c === previewAccent ? "border-yellow-400 ring-2 ring-yellow-400/40" : "border-stone-600")}
                          style={{ background: c }} />
                        <button aria-label={"Remove accent " + c} onClick={() => { setAccents((a) => a.filter((_, k) => k !== i)); if (c === previewAccent) setPreviewAccent(null); }}
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-stone-900 border border-stone-600 text-stone-400 hover:text-red-400 text-[9px] leading-none flex items-center justify-center">✕</button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* accent-in-recesses lesson — previews live on the model itself */}
          <div className="mt-5 pt-4 border-t border-stone-700/50">
            <h3 className="text-xs uppercase tracking-wider text-stone-300 mb-1">
              Accent in the recesses
              {previewAccent && <span className="ml-2 normal-case tracking-normal text-amber-300/90">— previewing on the model</span>}
            </h3>
            <p className="text-[11.5px] text-stone-400 leading-relaxed max-w-xl">
              {previewAccent
                ? "The model's shadow tiers are showing your accent glazed in thin — the classic 'complementary in the recesses' move. A touch of the opposite hue in shadow makes the base read richer without repainting anything. Tap the accent again to turn it off."
                : "Pin or tap an accent to preview it glazed into the shadow tiers on the model. The complementary is the one to try first: a thin wash of the opposite hue in the deepest recesses adds life that a darker version of the base color can't."}
            </p>
            <p className="text-[11px] text-stone-500 mt-2 max-w-xl">
              <b className="text-stone-400">Unifying glaze:</b> a single thin wash of one hue over the <i>whole</i> model ties
              unrelated parts together — a warm tone to harmonize, a cool one to push everything back.
            </p>
          </div>
        </Section>


        {/* ===== LIGHT CONTROLS ===== */}
        {(lightOn || rimOn || orbOn) && (
        <Section icon={<Sun size={15} />} title="Extras" {...sec("light")}>
          {lightOn && (
          <div className="flex flex-col sm:flex-row gap-5 items-start">
            <div className="flex flex-col items-center">
              <svg viewBox="0 0 52 52" className="w-[68px] h-[68px]">
                <circle cx="26" cy="26" r="22" fill="#1d201a" stroke="#34382c" />
                <text x="26" y="9" textAnchor="middle" className="fill-stone-500" style={{ fontSize: 6 }}>FRONT</text>
                <text x="26" y="49" textAnchor="middle" className="fill-stone-500" style={{ fontSize: 6 }}>BACK</text>
                <circle cx={cx} cy={cy} r="4" fill={ramp[ramp.length - 1]} />
              </svg>
              <div className="text-[10px] text-stone-500 mt-1">{el > 70 ? "overhead" : el < 15 ? "low" : "angled"}</div>
            </div>
            <div className="flex-1 w-full space-y-3">
              <Slider label="Orbit (around figure)" value={az} min={0} max={360} onChange={setAz} suffix="°" />
              <Slider label="Height (low → overhead)" value={el} min={-20} max={90} onChange={setEl} suffix="°" />
              <Slider label="Intensity (soft → harsh)" value={Math.round(lightInt * 100)} min={20} max={150} onChange={(v) => setLightInt(v / 100)} suffix="%" />
              <label className="flex items-center gap-2 text-xs text-stone-300 cursor-pointer pt-1">
                <input type="checkbox" checked={zenithalOn} onChange={(e) => setZenithalOn(e.target.checked)} />
                Zenithal underpainting <span className="text-stone-500">— sprayed light map; adds a step after priming</span>
              </label>
              <div className="flex flex-wrap gap-2 pt-1">
                {[["Zenithal", 20, 86], ["Front", 0, 32], ["Left", 90, 32], ["Right", 270, 32], ["Back", 180, 32]]
                  .map(([t, a, e]) => (
                    <button key={t} onClick={() => { setAz(a); setEl(e); }}
                      className="px-3 py-1.5 rounded-full text-xs border border-stone-700 hover:border-stone-500 text-stone-300">
                      {t}
                    </button>
                  ))}
              </div>
            </div>
          </div>
          )}
                {rimOn && (
                  <div className="pt-2 border-t border-stone-800">
                    <div className="text-xs text-stone-300">Rim light <span className="text-stone-500">— aimed separately, tinted cool (toggle in Extras)</span></div>
                    <div className="mt-2 space-y-3">
                      <Slider label="Rim orbit" value={rimAz} min={0} max={360} onChange={setRimAz} suffix="°" />
                      <Slider label="Rim height" value={rimEl} min={-20} max={90} onChange={setRimEl} suffix="°" />
                      <div className="flex items-center gap-3">
                        <input type="color" value={rimColor} onChange={(e) => setRimColor(e.target.value)}
                          className="w-8 h-8 flex-none bg-transparent border-0 cursor-pointer" title="Rim color" />
                        <div className="flex-1">
                          <Slider label="Rim strength" value={rimInt * 100} min={0} max={100} onChange={(v) => setRimInt(v / 100)} suffix="%" />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              {orbOn && (
              <div className="pt-2 mt-1 border-t border-stone-800">
          <p className="text-[11px] text-stone-500 mb-3 leading-snug">
            A second, colored light — a power weapon, a gem, glowing eyes — at its own bearing around the model. It{" "}
            <span className="text-stone-300">adds</span> on top of the main light: planes facing the orb pick up its
            color and brighten; planes facing away are untouched. Aim it independently to see the glow on its own.
          </p>
            <div className="mt-4 flex flex-col sm:flex-row gap-5 items-start">
              <div className="flex flex-col items-center">
                <svg viewBox="0 0 52 52" className="w-[68px] h-[68px]">
                  <circle cx="26" cy="26" r="22" fill="#1d201a" stroke="#34382c" />
                  <text x="26" y="9" textAnchor="middle" className="fill-stone-500" style={{ fontSize: 6 }}>FRONT</text>
                  <text x="26" y="49" textAnchor="middle" className="fill-stone-500" style={{ fontSize: 6 }}>BACK</text>
                  <circle cx={orbCx} cy={orbCy} r="5" fill={orbColor} stroke="#ffffff66" />
                </svg>
                <div className="text-[10px] text-stone-500 mt-1">orb</div>
              </div>
              <div className="flex-1 w-full space-y-3">
                <Slider label="Orb bearing (around figure)" value={orbAz} min={0} max={360} onChange={setOrbAz} suffix="°" />
                <Slider label="Orb height (below → above)" value={orbEl} min={-20} max={90} onChange={setOrbEl} suffix="°" />
                <Slider label="Glow strength" value={orbInt * 100} min={0} max={100} onChange={(v) => setOrbInt(v / 100)} suffix="%" />
                <label className="flex items-center gap-2 text-[11px] text-stone-400">
                  Glow color
                  <input type="color" value={orbColor} onChange={(e) => setOrbColor(e.target.value)} aria-label="Glow color"
                    className="w-8 h-8 rounded cursor-pointer bg-transparent border border-stone-700" />
                </label>
                <p className="text-[11px] text-amber-300/80 leading-snug">
                  <b className="text-amber-300">Watch for:</b> keep it subtle — real OSL is dim and falls off fast. Too
                  strong and it overpowers your value ramp; the giveaway of a fake glow is lighting planes that can't
                  actually "see" the orb.
                </p>
              </div>
            </div>
              </div>
              )}
        </Section>
        )}

        <Section icon={<Palette size={15} />} title="Real paints" {...sec("paints")}>
          <div className="flex gap-1 mb-3 flex-wrap">
            {[["", "All brands"], ["C", "Citadel"], ["V", "Vallejo"], ["A", "Army Painter"]].map(([k, lb]) => (
              <button key={lb} onClick={() => setPaintBrand(k)}
                className={"px-2.5 py-1 rounded-full text-[11px] border transition-colors " +
                  (paintBrand === k ? "border-stone-300 text-stone-100 bg-stone-700/60" : "border-stone-700 text-stone-400 hover:text-stone-200")}>
                {lb}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            {zoneMatches.map((matches, zi) => (
              <React.Fragment key={zi}>
                {zoneMatches.length > 1 && <div className="text-[10px] uppercase tracking-wider text-stone-500 pt-1">{zoneNames[zi]}</div>}
                {tiers.map((t, i) => { const m = matches[i]; return m && (
                  <div key={t.key} className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded flex-none border border-black/30" style={{ background: dispRamps[zi][i] }} title={"Your " + t.label + " — " + dispRamps[zi][i]} />
                    <span className="text-[10px] text-stone-500 w-16 flex-none">{t.label}</span>
                    <div className="w-5 h-5 rounded flex-none border border-black/30" style={{ background: m.hex }} title={m.hex} />
                    <div className="min-w-0 flex-1">
                      <span className="text-xs text-stone-200">{m.name}</span>
                      <span className="text-[10px] text-stone-500"> · {PAINT_BRANDS[m.brand]} · {matchQuality(m.dE)}</span>
                    </div>
                  </div> ); })}
              </React.Fragment>
            ))}
            {accents.map((c, i) => { const m = accentMatches[i]; return m && (
              <div key={"a" + i} className="flex items-center gap-2">
                <div className="w-5 h-5 rounded flex-none border border-yellow-500/40" style={{ background: c }} title={"Accent — " + c} />
                <span className="text-[10px] text-stone-500 w-16 flex-none">Accent</span>
                <div className="w-5 h-5 rounded flex-none border border-black/30" style={{ background: m.hex }} title={m.hex} />
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-stone-200">{m.name}</span>
                  <span className="text-[10px] text-stone-500"> · {PAINT_BRANDS[m.brand]} · {matchQuality(m.dE)}</span>
                </div>
              </div> ); })}
          </div>
          <p className="text-[11px] text-stone-600 mt-3 leading-snug">
            Nearest opaque pot to each mixed color — a shopping list, not gospel. “Mix to match” means start
            from that pot and adjust; pot colors also vary by batch and screen.
          </p>
        </Section>

        {/* ===== SEQUENCER ===== */}
        <Section icon={<Layers size={15} />} title="Steps" {...sec("steps")}>
          <p className="text-[11px] text-stone-500 mb-3">{method === "airbrush"
            ? "Airbrush passes in order — pressure, thinning, and spray angle per step. Tap one to isolate where it lands (steps without a tier apply to the whole model)."
            : "Tap a step to isolate its value tier on the figure above (steps without one apply to the whole model)."}</p>
          <div className="space-y-1.5">
            {stages.map((s, i) => {
              const active = s.id === activeStage;
              return (
                <div key={s.id}
                  className={"rounded-lg border transition-colors " + (active ? "border-stone-400 bg-stone-800/40" : "border-stone-700/50")}>
                  <div className="w-full flex items-center gap-3 px-3 py-2.5">
                    <button type="button" role="checkbox" aria-checked={!!done[s.id]}
                      aria-label={"Mark “" + s.name + "” done"}
                      onClick={() => setDone((d) => ({ ...d, [s.id]: !d[s.id] }))}
                      className={"w-5 h-5 rounded flex-none flex items-center justify-center border " +
                        (done[s.id] ? "bg-green-600 border-green-600" : "border-stone-600 hover:border-stone-400")}>
                      {done[s.id] && <Check size={13} />}
                    </button>
                    <button type="button" onClick={() => setActiveStage(s.id)} aria-pressed={active}
                      className="flex-1 flex items-center gap-3 text-left">
                      <span className="text-[10px] tabular-nums text-stone-500 w-4">{i + 1}</span>
                      <span className={"text-sm font-medium " + (done[s.id] ? "line-through text-stone-500" : "text-stone-100")}>{s.name}</span>
                    </button>
                  </div>
                  {active && (
                    <div className="px-3 pb-3 pl-12 space-y-1.5">
                      {s.iso == null && s.mode === "paint" && (
                        <span className="inline-block text-[9px] uppercase tracking-wider text-stone-500 border border-stone-700 rounded px-1.5 py-0.5">whole model — no single tier</span>
                      )}
                      <p className="text-xs text-stone-300 leading-snug">{s.note}</p>
                      {s.id === "prime" && (
                        <label className="flex items-center gap-2 text-[11px] text-stone-400 pt-1">
                          Primer color
                          <input type="color" value={primerColor} onChange={(e) => setPrimerColor(e.target.value)}
                            aria-label="Primer color" className="w-7 h-7 rounded cursor-pointer bg-transparent border border-stone-700" />
                          {[["#1b1b1b", "Black"], ["#7a7a7a", "Grey"], ["#f2f2f2", "White"], ["#5b3a2e", "Brown"]].map(([c, nm]) => (
                            <button key={c} onClick={() => setPrimerColor(c)} title={nm} aria-label={nm + " primer"}
                              className={"w-5 h-5 rounded-full border " + (primerColor === c ? "border-lime-400" : "border-stone-600")}
                              style={{ background: c }} />
                          ))}
                        </label>
                      )}
                      <p className="text-[11px] text-amber-300/80 leading-snug"><b className="text-amber-300">Watch for:</b> {s.watch}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        {method === "airbrush" && lightOn && (
        <Section icon={<Droplets size={15} />} title="Spray cone" {...sec("spray")}>
          <p className="text-[11px] text-stone-500 mb-3 leading-snug">
            Your light direction <span className="text-stone-300">is the nozzle</span>. Turn this on to see where paint
            actually lands — planes angled toward the nozzle get coated, planes facing away stay bare primer. Aim with
            Orbit / Height above.
          </p>
          <div className="flex items-center gap-3 mb-1">
            <button onClick={() => setSpray((v) => !v)} role="switch" aria-checked={spray} aria-label="Toggle spray coverage view"
              className={"relative w-12 h-6 rounded-full transition-colors flex-none " + (spray ? "bg-sky-600" : "bg-stone-700")}>
              <span className={"absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all " + (spray ? "left-6" : "left-0.5")} />
            </button>
            <div>
              <div className="text-sm text-stone-200 font-medium">{spray ? "Showing spray coverage" : "Show where the spray lands"}</div>
              <div className="text-[11px] text-stone-500">{spray
                ? <>Bare planes were missed by this pass. Spraying: <span style={{ color: sprayColor }}>{stage.name}</span>.</>
                : "Reframes the figures as paint coverage instead of value."}</div>
            </div>
          </div>
          {spray && (
            <div className="mt-4">
              <Slider label="Cone focus (wide / feathered → tight / focused)" value={focus * 100} min={0} max={100}
                onChange={(v) => setFocus(v / 100)} suffix="%" />
              <p className="text-[11px] text-amber-300/80 leading-snug mt-2">
                <b className="text-amber-300">Watch for:</b> a wide cone feathers paint onto angled planes — soft and
                forgiving, but more overspray. A tight cone hits only what directly faces the nozzle — clean, but slow and
                easy to leave gaps. Undersides stay bare until you aim from below.
              </p>
            </div>
          )}
        </Section>
        )}




        {/* ===== SAVE / LOAD ===== */}
        <Section icon={<Save size={15} />} title="Recipes" {...sec("recipes")}>
          <div className="flex flex-wrap gap-2 items-center mb-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Recipe name (e.g. Orc Flesh)"
              className="flex-1 min-w-[180px] bg-stone-900 border border-stone-700 rounded-md px-3 py-2 text-base sm:text-sm text-stone-200 placeholder:text-stone-600" />
            <button onClick={save} className="flex items-center gap-1.5 px-4 py-2 rounded-md text-sm bg-stone-200 text-stone-900 font-medium hover:bg-white">
              <Save size={14} /> Save
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recipes.length === 0 && <span className="text-[11px] text-stone-600">No saved recipes yet.</span>}
            {recipes.map((nm) => (
              <div key={nm} className="flex items-center gap-2 border border-stone-700 rounded-full pl-3 pr-1.5 py-1">
                <button onClick={() => load(nm)} className="text-xs text-stone-300 hover:text-white">{nm}</button>
                <button aria-label={"Delete recipe " + nm} onClick={() => del(nm)} className="text-stone-600 hover:text-red-400"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-stone-800">
            <button onClick={exportRecipes} title="Download every saved recipe as a JSON file — back up or move to another device"
              className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-200 border border-stone-700 hover:border-stone-500 rounded-full px-3 py-1.5">
              <Download size={12} /> Export recipes
            </button>
            <label className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-200 border border-stone-700 hover:border-stone-500 rounded-full px-3 py-1.5 cursor-pointer"
              title="Load a light-bench-recipes.json exported on another device — merges with what's here">
              <input type="file" accept=".json,application/json" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) importRecipes(f); e.target.value = ""; }} />
              <Upload size={12} /> Import recipes
            </label>
          </div>
        </Section>
        <p className="text-[11px] text-stone-600 mt-6 mb-2 leading-relaxed border-t border-stone-800 pt-4">
          A teaching tool, not a portrait of any one model. The figure is generic on purpose — the point is reading how
          light falls on planes, which transfers to anything on your table. Brightness here is a simple shading model
          (ambient + directional), so treat it as a guide to <i>where</i>, not a literal render.
        </p>

          </div>{/* end controls pane */}
      </div>{/* end flex row */}
    </div>
  );
}

function Section({ icon, title, children, open = true, onToggle }) {
  return (
    <section className="rounded-xl border border-stone-700/60 bg-stone-900/30 p-4 mb-4">
      <h2 className={"text-xs tracking-[0.22em] uppercase text-stone-400 " + (open ? "mb-4" : "mb-0")}>
        {onToggle ? (
          <button onClick={onToggle} aria-expanded={open}
            className="flex items-center gap-2 w-full text-left uppercase tracking-[0.22em] hover:text-stone-200">
            <span className="text-stone-500 w-3 flex-none">{open ? "▾" : "▸"}</span>{icon}{title}
          </button>
        ) : (<span className="flex items-center gap-2">{icon}{title}</span>)}
      </h2>
      {open && children}
    </section>
  );
}
function Slider({ label, value, min, max, onChange, suffix }) {
  return (
    <label className="block">
      <div className="flex justify-between text-[11px] text-stone-400 mb-1">
        <span>{label}</span><span className="tabular-nums text-stone-300">{Math.round(value)}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-lime-500" />
    </label>
  );
}


