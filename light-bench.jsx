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
const clamp01 = (v) => clamp(v, 0, 1);
function lerpHue(a, b, t) { let d = (((b - a) % 360) + 540) % 360 - 180; return ((a + d * t) % 360 + 360) % 360; }
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
function generateRamp(baseHex, n) {
  const { h, s, l } = hexToHsl(baseHex);
  const out = new Array(n);
  out[1] = baseHex;                                  // base
  // shadow
  out[0] = hslToHex(lerpHue(h, 250, 0.22), clamp(s + 7, 0, 100), clamp(l - 22, 6, 96));
  // highlights
  const hc = n - 2;
  const topL = Math.min(96, l + 46);
  for (let i = 2; i < n; i++) {
    const frac = (i - 1) / hc;                       // 0<frac<=1
    const nl = l + (topL - l) * frac;
    const nh = lerpHue(h, 52, 0.12 + 0.34 * frac);
    const ns = s - s * 0.32 * frac;
    out[i] = hslToHex(nh, clamp(ns, 0, 100), clamp(nl, 0, 99));
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

function defaultGlaze(ramp, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 1 : i / (count - 1);
    const idx = clamp(Math.round(1 + t * (ramp.length - 2)), 1, ramp.length - 1);
    out.push({ color: ramp[idx], opacity: 0.5 });
  }
  return out;
}
function glazeColor(b, layers, pooling) {
  let c = valueGrey(b);
  for (const L of layers) {
    const eff = clamp(L.opacity * (1 - pooling * b), 0, 1);
    c = mix(c, L.color, eff);
  }
  return c;
}
/* Each region: world-space surface normal [x,y,z].
   +z = front, +x = the figure's "left-view" side, +y = up. */
const FRONT = [
  { p: "78,22 100,14 122,22 120,38 80,38", n: [0, 0.75, 0.66] },
  { p: "78,38 88,40 88,86 80,80", n: [-0.6, 0.05, 0.8] },
  { p: "122,38 112,40 112,86 120,80", n: [0.6, 0.05, 0.8] },
  { p: "88,38 112,38 112,86 88,86", n: [0, 0, 1] },
  { p: "90,86 110,86 108,102 92,102", n: [0, 0.1, 0.99], ao: 0.5 }, // neck recess
  { p: "62,104 138,104 142,118 58,118", n: [0, 0.82, 0.45] },
  { p: "46,116 62,114 64,150 50,152", n: [-0.85, 0.2, 0.3] },
  { p: "154,116 138,114 136,150 150,152", n: [0.85, 0.2, 0.3] },
  { p: "64,120 136,120 134,138 66,138", n: [0, 0.5, 0.85], ao: 0.7 }, // hollow under the neck
  { p: "66,138 134,138 130,176 70,176", n: [0, 0.02, 1] },
  { p: "72,176 128,176 124,236 76,236", n: [0, 0.04, 1] },
  { p: "46,152 64,152 62,250 50,250", n: [-0.8, 0, 0.55] },
  { p: "154,152 136,152 138,250 150,250", n: [0.8, 0, 0.55] },
  { p: "76,236 124,236 122,262 78,262", n: [0, 0.05, 1] },
  { p: "78,260 99,260 99,272 80,272", n: [0, 0.6, 0.78], ao: 0.55 }, // between the legs (left)
  { p: "101,260 122,260 120,272 101,272", n: [0, 0.6, 0.78], ao: 0.55 }, // between the legs (right)
  { p: "80,272 99,272 98,344 84,344", n: [0, 0.03, 1] },
  { p: "101,272 120,272 116,344 102,344", n: [0, 0.03, 1] },
  { p: "84,348 98,348 96,436 86,436", n: [0, 0.02, 1] },
  { p: "102,348 116,348 114,436 104,436", n: [0, 0.02, 1] },
];
const BACK = [
  { p: "78,22 100,14 122,22 120,38 80,38", n: [0, 0.75, -0.66] },
  { p: "78,38 90,38 90,86 80,80", n: [-0.55, 0.05, -0.83] },
  { p: "122,38 110,38 110,86 120,80", n: [0.55, 0.05, -0.83] },
  { p: "90,38 110,38 110,86 90,86", n: [0, 0, -1] },
  { p: "90,86 110,86 108,102 92,102", n: [0, 0.1, -0.99], ao: 0.5 }, // nape recess
  { p: "62,104 138,104 142,118 58,118", n: [0, 0.7, -0.5] },
  { p: "46,116 62,114 64,150 50,152", n: [-0.85, 0.2, -0.3] },
  { p: "154,116 138,114 136,150 150,152", n: [0.85, 0.2, -0.3] },
  { p: "64,120 136,120 132,176 68,176", n: [0, 0.15, -0.97] },
  { p: "72,176 128,176 124,236 76,236", n: [0, 0.05, -1] },
  { p: "46,152 64,152 62,250 50,250", n: [-0.8, 0, -0.55] },
  { p: "154,152 136,152 138,250 150,250", n: [0.8, 0, -0.55] },
  { p: "76,236 124,236 122,272 78,272", n: [0, 0.1, -0.98] },
  { p: "80,272 99,272 98,344 84,344", n: [0, 0.03, -1] },
  { p: "101,272 120,272 116,344 102,344", n: [0, 0.03, -1] },
  { p: "84,348 98,348 96,436 86,436", n: [0, 0.05, -1] },
  { p: "102,348 116,348 114,436 104,436", n: [0, 0.05, -1] },
];
const LEFT = [
  { p: "84,22 108,16 116,30 110,40 86,40", n: [0.5, 0.7, 0.1] },
  { p: "84,40 96,40 92,82 82,78", n: [0.4, 0.05, 0.75] },
  { p: "96,40 112,42 110,82 92,82", n: [0.95, 0.05, 0] },
  { p: "112,42 116,52 114,80 110,82", n: [0.5, 0.05, -0.75] },
  { p: "90,82 108,82 106,102 92,102", n: [0.9, 0.1, 0], ao: 0.5 }, // neck recess (mirrors to right)
  { p: "78,104 124,104 126,118 76,118", n: [0.2, 0.85, 0] },
  { p: "76,120 92,120 90,176 78,172", n: [0.4, 0.1, 0.78] },
  { p: "92,118 122,120 120,176 90,176", n: [0.95, 0.05, 0] },
  { p: "104,150 124,150 122,250 106,250", n: [0.9, 0, 0.1] },
  { p: "120,140 128,150 126,176 120,176", n: [0.45, 0.05, -0.78] },
  { p: "80,176 120,176 118,236 82,236", n: [0.92, 0.04, 0] },
  { p: "84,236 118,236 116,262 86,262", n: [0.9, 0.05, 0] },
  { p: "86,260 116,260 114,272 88,272", n: [0.2, 0.6, 0.1] },
  { p: "88,272 112,272 108,344 92,344", n: [0.92, 0.03, 0] },
  { p: "92,348 108,348 106,436 94,436", n: [0.92, 0.02, 0] },
];
function mirrorPoly(p) {
  return p.split(" ").map((pt) => { const [x, y] = pt.split(","); return (200 - parseFloat(x)) + "," + y; }).join(" ");
}
const RIGHT = LEFT.map((r) => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], r.n[2]], ao: r.ao }));

const STANDING_TOP = [
  { p: "10,78 28,72 32,96 14,100", n: [-0.8, 0.55, 0] },
  { p: "210,78 192,72 188,96 206,100", n: [0.8, 0.55, 0] },
  { p: "28,60 110,52 110,84 22,84", n: [-0.4, 0.8, -0.4] },
  { p: "110,52 192,60 198,84 110,84", n: [0.4, 0.8, -0.4] },
  { p: "22,84 110,84 110,116 28,108", n: [-0.4, 0.8, 0.4] },
  { p: "110,84 198,84 192,108 110,116", n: [0.4, 0.8, 0.4] },
  { p: "89,59 110,50 131,59 131,80 89,80", n: [0, 0.85, -0.4] },
  { p: "89,80 131,80 131,101 110,110 89,101", n: [0, 0.85, 0.4] },
  { p: "98,68 122,68 122,92 98,92", n: [0, 1, 0] },
];
const STANDING = [
  { key: "front", label: "Front", regions: FRONT },
  { key: "left", label: "Left", regions: LEFT },
  { key: "right", label: "Right", regions: RIGHT },
  { key: "back", label: "Back", regions: BACK },
  { key: "top", label: "Top (from above)", regions: STANDING_TOP },
];

/* ---------------- BUST (blocky, generic) ---------------- */
const BUST_FRONT = [
  { p: "70,44 100,32 130,44 126,70 74,70", n: [0, 0.75, 0.66] },
  { p: "70,70 84,72 84,150 76,140", n: [-0.6, 0.05, 0.8] },
  { p: "130,70 116,72 116,150 124,140", n: [0.6, 0.05, 0.8] },
  { p: "84,70 116,70 116,150 84,150", n: [0, 0, 1] },
  { p: "86,150 114,150 112,178 88,178", n: [0, 0.1, 0.99], ao: 0.5 }, // under-chin / neck recess
  { p: "50,180 150,180 156,200 44,200", n: [0, 0.82, 0.45] },
  { p: "30,196 50,194 52,250 36,254", n: [-0.85, 0.2, 0.3] },
  { p: "170,196 150,194 148,250 164,254", n: [0.85, 0.2, 0.3] },
  { p: "52,204 148,204 146,228 54,228", n: [0, 0.5, 0.85], ao: 0.7 }, // neck-to-chest hollow
  { p: "54,228 146,228 142,300 58,300", n: [0, 0.02, 1] },
  { p: "62,300 138,300 132,344 68,344", n: [0, 0.05, 1] },
  { p: "58,346 142,346 140,358 60,358", n: [0, 0.7, 0.55] },
  { p: "60,358 140,358 150,404 50,404", n: [0, 0.08, 1] },
];
const BUST_BACK = [
  { p: "70,44 100,32 130,44 126,70 74,70", n: [0, 0.75, -0.66] },
  { p: "70,70 84,72 84,150 76,140", n: [-0.55, 0.05, -0.83] },
  { p: "130,70 116,72 116,150 124,140", n: [0.55, 0.05, -0.83] },
  { p: "84,70 116,70 116,150 84,150", n: [0, 0, -1] },
  { p: "86,150 114,150 112,178 88,178", n: [0, 0.1, -0.99], ao: 0.5 }, // nape recess
  { p: "50,180 150,180 156,200 44,200", n: [0, 0.7, -0.5] },
  { p: "30,196 50,194 52,250 36,254", n: [-0.85, 0.2, -0.3] },
  { p: "170,196 150,194 148,250 164,254", n: [0.85, 0.2, -0.3] },
  { p: "52,204 148,204 146,228 54,228", n: [0, 0.3, -0.9], ao: 0.7 }, // upper-back hollow under neck
  { p: "54,228 146,228 142,300 58,300", n: [0, 0.05, -1] },
  { p: "62,300 138,300 132,344 68,344", n: [0, 0.05, -1] },
  { p: "58,346 142,346 140,358 60,358", n: [0, 0.7, -0.55] },
  { p: "60,358 140,358 150,404 50,404", n: [0, 0.08, -1] },
];
const BUST_LEFT = [
  { p: "84,44 112,36 120,56 112,68 86,66", n: [0.4, 0.7, 0.1] },
  { p: "84,66 96,66 92,144 82,138", n: [0.4, 0.05, 0.75] },
  { p: "96,66 114,68 112,144 92,144", n: [0.95, 0.05, 0] },
  { p: "114,68 120,80 116,142 112,144", n: [0.5, 0.05, -0.75] },
  { p: "88,144 112,144 110,178 90,178", n: [0.9, 0.1, 0], ao: 0.5 }, // neck recess (mirrors to right)
  { p: "70,180 134,180 138,202 66,202", n: [0.2, 0.85, 0] },
  { p: "66,206 86,206 84,300 70,294", n: [0.4, 0.1, 0.78] },
  { p: "86,204 132,206 130,300 84,300", n: [0.95, 0.05, 0] },
  { p: "130,210 140,220 136,300 130,300", n: [0.45, 0.05, -0.78] },
  { p: "72,300 132,300 128,344 76,344", n: [0.9, 0.05, 0] },
  { p: "66,346 140,346 138,358 68,358", n: [0.2, 0.65, 0.1] },
  { p: "68,358 140,358 148,404 60,404", n: [0.9, 0.06, 0] },
];
const BUST_RIGHT = BUST_LEFT.map((r) => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], r.n[2]], ao: r.ao }));
const BUST_TOP = [
  { p: "40,60 110,52 110,84 34,84", n: [-0.35, 0.8, -0.4] },
  { p: "110,52 180,60 186,84 110,84", n: [0.35, 0.8, -0.4] },
  { p: "34,84 110,84 110,116 40,108", n: [-0.35, 0.8, 0.4] },
  { p: "110,84 186,84 180,108 110,116", n: [0.35, 0.8, 0.4] },
  { p: "89,59 110,50 131,59 131,80 89,80", n: [0, 0.85, -0.4] },
  { p: "89,80 131,80 131,101 110,110 89,101", n: [0, 0.85, 0.4] },
  { p: "98,68 122,68 122,92 98,92", n: [0, 1, 0] },
];
const BUST = [
  { key: "front", label: "Front", regions: BUST_FRONT },
  { key: "left", label: "Left", regions: BUST_LEFT },
  { key: "right", label: "Right", regions: BUST_RIGHT },
  { key: "back", label: "Back", regions: BUST_BACK },
  { key: "top", label: "Top (from above)", regions: BUST_TOP },
];

/* ---------------- RIFLE STANCE (arms raised, rifle held at an angle) ---------------- */
const GUN_FRONT = [
  { p: "78,22 100,14 122,22 120,38 80,38", n: [0, 0.75, 0.66] },
  { p: "78,38 88,40 88,86 80,80", n: [-0.6, 0.05, 0.8] },
  { p: "122,38 112,40 112,86 120,80", n: [0.6, 0.05, 0.8] },
  { p: "88,38 112,38 112,86 88,86", n: [0, 0, 1] },
  { p: "90,86 110,86 108,102 92,102", n: [0, 0.1, 0.99], ao: 0.5 }, // neck recess
  { p: "62,104 138,104 142,118 58,118", n: [0, 0.82, 0.45] },
  { p: "64,118 136,118 134,150 66,150", n: [0, 0.3, 0.95], ao: 0.7 }, // chest hollow under the neck/arms
  { p: "66,150 134,150 130,238 70,238", n: [0, 0.04, 1] },
  { p: "74,238 126,238 122,266 78,266", n: [0, 0.05, 1] },
  { p: "80,266 100,266 88,330 68,330", n: [0, 0.04, 1] },
  { p: "68,330 88,330 92,414 76,418", n: [0, 0.03, 1] },
  { p: "104,266 124,266 122,336 110,336", n: [0, 0.04, 1] },
  { p: "110,340 124,340 124,432 112,432", n: [0, 0.03, 1] },
  { p: "50,120 66,122 64,160 50,160", n: [-0.72, 0.15, 0.45] },
  { p: "62,156 96,176 90,190 56,170", n: [-0.2, 0.1, 0.9] },
  { p: "134,122 150,120 150,158 134,156", n: [0.72, 0.15, 0.45] },
  { p: "148,156 126,166 132,178 150,170", n: [0.2, 0.1, 0.9] },
  { p: "58,198 70,192 74,200 62,206", n: [0, 0.3, 0.8] },
  { p: "70,194 76,204 176,156 170,146", n: [0, 0.5, 0.72] },
  { p: "76,204 176,156 178,166 78,214", n: [0, 0.12, 0.98] },
  { p: "88,178 100,172 106,182 94,190", n: [0, 0.15, 0.95] },
  { p: "124,164 136,158 142,168 130,176", n: [0, 0.15, 0.95] },
];
const GUN_BACK = [
  { p: "78,22 100,14 122,22 120,38 80,38", n: [0, 0.75, -0.66] },
  { p: "78,38 90,38 90,86 80,80", n: [-0.55, 0.05, -0.83] },
  { p: "122,38 110,38 110,86 120,80", n: [0.55, 0.05, -0.83] },
  { p: "90,38 110,38 110,86 90,86", n: [0, 0, -1] },
  { p: "90,86 110,86 108,102 92,102", n: [0, 0.1, -0.99], ao: 0.5 }, // nape recess
  { p: "62,104 138,104 142,118 58,118", n: [0, 0.7, -0.5] },
  { p: "64,118 136,118 134,150 66,150", n: [0, 0.15, -0.95] },
  { p: "66,150 134,150 130,238 70,238", n: [0, 0.05, -1] },
  { p: "74,238 126,238 122,266 78,266", n: [0, 0.1, -0.98] },
  { p: "80,266 100,266 88,330 68,330", n: [0, 0.04, -1] },
  { p: "68,330 88,330 92,414 76,418", n: [0, 0.03, -1] },
  { p: "104,266 124,266 122,336 110,336", n: [0, 0.04, -1] },
  { p: "110,340 124,340 124,432 112,432", n: [0, 0.03, -1] },
  { p: "50,120 66,122 64,160 50,160", n: [-0.72, 0.15, -0.45] },
  { p: "134,122 150,120 150,158 134,156", n: [0.72, 0.15, -0.45] },
  { p: "56,156 70,162 66,182 52,174", n: [-0.3, 0.1, -0.6] },
  { p: "144,158 130,164 134,182 148,174", n: [0.3, 0.1, -0.6] },
  { p: "170,150 182,146 184,156 172,160", n: [0.4, 0.3, -0.4] },
  { p: "58,196 70,192 73,200 61,206", n: [-0.2, 0.2, -0.6] },
];
const GUN_LEFT = [
  { p: "84,22 108,16 116,30 110,40 86,40", n: [0.5, 0.7, 0.1] },
  { p: "84,40 96,40 92,82 82,78", n: [0.4, 0.05, 0.75] },
  { p: "96,40 112,42 110,82 92,82", n: [0.95, 0.05, 0] },
  { p: "112,42 116,52 114,80 110,82", n: [0.5, 0.05, -0.75] },
  { p: "90,82 108,82 106,102 92,102", n: [0.9, 0.1, 0], ao: 0.5 }, // neck recess (mirrors to right)
  { p: "78,104 124,104 126,118 76,118", n: [0.2, 0.85, 0] },
  { p: "76,120 92,120 90,168 78,164", n: [0.4, 0.1, 0.78] },
  { p: "92,118 120,120 118,202 90,202", n: [0.95, 0.05, 0] },
  { p: "118,134 126,144 124,202 118,202", n: [0.45, 0.05, -0.78] },
  { p: "80,202 118,202 116,252 82,252", n: [0.92, 0.04, 0] },
  { p: "82,252 116,252 114,282 86,282", n: [0.9, 0.05, 0] },
  { p: "100,282 116,282 118,344 106,344", n: [0.9, 0.04, -0.2] },
  { p: "106,348 118,344 122,430 112,432", n: [0.9, 0.03, -0.15] },
  { p: "106,428 128,426 130,440 104,442", n: [0.3, 0.3, -0.4] },
  { p: "82,282 104,278 100,300 80,306", n: [0.6, 0.3, 0.5] },
  { p: "80,300 100,300 96,420 76,420", n: [0.88, 0.03, 0.1] },
  { p: "60,416 96,414 98,430 58,432", n: [0.35, 0.3, 0.5] },
  { p: "84,124 102,122 104,150 86,154", n: [0.6, 0.15, 0.5] },
  { p: "60,148 102,142 104,156 62,164", n: [0.4, 0.05, 0.8] },
  { p: "34,148 100,140 102,154 36,162", n: [0.6, 0.35, 0.12] },
  { p: "98,146 112,144 112,158 98,160", n: [0.7, 0.2, -0.15] },
  { p: "46,148 60,144 64,156 50,160", n: [0.5, 0.2, 0.4] },
  { p: "86,148 100,144 102,156 88,160", n: [0.5, 0.2, 0.2] },
];
const GUN_RIGHT = GUN_LEFT.map((r) => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], r.n[2]], ao: r.ao }));
const GUN_TOP = [
  { p: "40,54 110,48 110,76 34,76", n: [-0.35, 0.8, -0.4] },
  { p: "110,48 180,54 186,76 110,76", n: [0.35, 0.8, -0.4] },
  { p: "34,76 110,76 110,96 40,92", n: [-0.35, 0.8, 0.4] },
  { p: "110,76 186,76 180,96 110,96", n: [0.35, 0.8, 0.4] },
  { p: "54,92 78,90 86,116 64,120", n: [-0.3, 0.7, 0.45] },
  { p: "166,92 142,90 134,116 156,120", n: [0.3, 0.7, 0.45] },
  { p: "30,116 190,108 192,122 32,130", n: [0, 0.72, 0.4] },
  { p: "90,50 110,42 130,50 130,68 90,68", n: [0, 0.85, -0.4] },
  { p: "90,68 130,68 130,80 110,86 90,80", n: [0, 0.85, 0.4] },
  { p: "100,56 120,56 120,72 100,72", n: [0, 1, 0] },
];
const GUN = [
  { key: "front", label: "Front", regions: GUN_FRONT },
  { key: "left", label: "Left", regions: GUN_LEFT },
  { key: "right", label: "Right", regions: GUN_RIGHT },
  { key: "back", label: "Back", regions: GUN_BACK },
  { key: "top", label: "Top (from above)", regions: GUN_TOP },
];

/* ---------------- DUAL WIELD (arms wide, pistol raised + blade out) ---------------- */
const DUAL_FRONT = [
  { p: "80,30 100,22 120,30 118,52 82,52", n: [0, 0.75, 0.66] },
  { p: "80,52 90,54 90,96 82,90", n: [-0.6, 0.05, 0.8] },
  { p: "120,52 110,54 110,96 118,90", n: [0.6, 0.05, 0.8] },
  { p: "90,52 110,52 110,96 90,96", n: [0, 0, 1] },
  { p: "92,96 108,96 106,110 94,110", n: [0, 0.1, 0.99] },
  { p: "64,112 136,112 140,128 60,128", n: [0, 0.82, 0.45] },
  { p: "38,110 64,108 66,142 36,146", n: [-0.7, 0.3, 0.4] },
  { p: "162,110 136,108 134,142 164,146", n: [0.7, 0.3, 0.4] },
  { p: "62,128 138,128 132,210 68,210", n: [0, 0.03, 1] },
  { p: "68,210 132,210 128,250 72,250", n: [0, 0.04, 1] },
  { p: "72,250 128,250 126,278 74,278", n: [0, 0.05, 1] },
  { p: "74,278 98,278 86,346 64,344", n: [0, 0.04, 1] },
  { p: "64,346 86,344 92,430 72,432", n: [0, 0.03, 1] },
  { p: "54,428 92,426 94,442 52,444", n: [0.2, 0.3, 0.5] },
  { p: "102,278 126,278 136,344 116,344", n: [0, 0.04, 1] },
  { p: "116,348 136,344 140,430 122,432", n: [0, 0.03, 1] },
  { p: "112,428 150,426 152,442 110,444", n: [0.2, 0.3, -0.3] },
  { p: "44,124 60,130 42,110 30,116", n: [-0.6, 0.25, 0.55] },
  { p: "30,116 42,110 32,74 18,80", n: [-0.5, 0.15, 0.7] },
  { p: "12,78 36,76 38,92 14,94", n: [0, 0.4, 0.9] },
  { p: "16,40 30,38 34,78 20,80", n: [-0.2, 0.35, 0.85] },
  { p: "12,52 22,50 24,64 14,66", n: [-0.4, 0.2, 0.78] },
  { p: "140,128 156,124 178,144 164,150", n: [0.6, 0.2, 0.5] },
  { p: "164,148 178,144 192,158 178,164", n: [0.5, 0.1, 0.7] },
  { p: "178,158 192,156 196,170 182,174", n: [0.3, 0.1, 0.8] },
  { p: "179,160 197,158 198,168 181,170", n: [0.2, 0.2, 0.7] },
  { p: "185,158 193,156 199,82 192,82", n: [0.3, 0.4, 0.55] },
];
const DUAL_BACK = DUAL_FRONT.map((r) => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], -r.n[2]] }));
const DUAL_LEFT = [
  { p: "84,30 108,24 116,38 110,50 86,50", n: [0.5, 0.7, 0.1] },
  { p: "84,50 96,50 92,96 82,90", n: [0.4, 0.05, 0.75] },
  { p: "96,50 112,52 110,96 92,96", n: [0.95, 0.05, 0] },
  { p: "112,52 116,62 114,94 110,96", n: [0.5, 0.05, -0.75] },
  { p: "90,96 108,96 106,112 92,112", n: [0.9, 0.1, 0] },
  { p: "76,108 110,106 112,140 74,142", n: [0.3, 0.5, 0.2] },
  { p: "84,112 116,112 118,124 82,124", n: [0.2, 0.82, 0] },
  { p: "80,124 96,124 94,200 82,196", n: [0.4, 0.1, 0.78] },
  { p: "96,122 120,124 118,205 94,205", n: [0.95, 0.05, 0] },
  { p: "118,136 126,146 124,205 118,205", n: [0.45, 0.05, -0.78] },
  { p: "84,205 118,205 116,252 86,252", n: [0.9, 0.04, 0] },
  { p: "86,252 116,252 114,282 90,282", n: [0.9, 0.05, 0] },
  { p: "100,282 116,282 118,340 106,340", n: [0.9, 0.04, -0.2] },
  { p: "106,344 118,340 122,428 112,430", n: [0.9, 0.03, -0.15] },
  { p: "106,426 128,424 130,438 104,440", n: [0.3, 0.3, -0.4] },
  { p: "86,282 108,280 100,332 80,330", n: [0.85, 0.04, 0.25] },
  { p: "80,332 100,330 96,420 78,422", n: [0.88, 0.03, 0.12] },
  { p: "62,418 96,414 98,430 60,432", n: [0.3, 0.3, 0.5] },
  { p: "84,124 100,122 94,98 78,102", n: [0.4, 0.4, 0.5] },
  { p: "78,102 94,98 88,60 72,64", n: [0.3, 0.25, 0.7] },
  { p: "70,32 84,30 88,64 74,66", n: [0.2, 0.4, 0.6] },
  { p: "94,150 116,148 114,174 92,176", n: [0.5, 0.1, 0.6] },
  { p: "110,160 152,140 156,152 114,172", n: [0.4, 0.35, 0.5] },
];
const DUAL_RIGHT = DUAL_LEFT.map((r) => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], r.n[2]] }));
const DUAL_TOP = [
  { p: "70,60 150,60 156,96 64,96", n: [0, 1, 0] },
  { p: "96,66 124,66 122,92 98,92", n: [0, 1, 0.05] },
  { p: "98,52 122,52 120,72 100,72", n: [0, 0.98, 0.15] },
  { p: "44,70 70,66 72,86 46,90", n: [-0.4, 0.85, 0.1] },
  { p: "150,70 176,66 174,90 148,86", n: [0.4, 0.85, 0.1] },
  { p: "30,72 56,68 58,82 32,86", n: [-0.6, 0.6, 0.2] },
  { p: "10,70 32,66 34,82 12,86", n: [-0.7, 0.55, 0.2] },
  { p: "164,72 190,68 192,82 166,86", n: [0.6, 0.6, 0.2] },
  { p: "188,74 214,72 216,82 190,84", n: [0.7, 0.5, 0.2] },
];
const DUAL = [
  { key: "front", label: "Front", regions: DUAL_FRONT },
  { key: "left", label: "Left", regions: DUAL_LEFT },
  { key: "right", label: "Right", regions: DUAL_RIGHT },
  { key: "back", label: "Back", regions: DUAL_BACK },
  { key: "top", label: "Top (from above)", regions: DUAL_TOP },
];

const MODELS = {
  // The 2D croquis models were retired once full-detail STL rendering landed —
  // their view data (STANDING etc.) stays as the generic preview geometry.
  male: { label: "3D figure", blurb: "A realistic figure you rotate in 3D — drag to read light across real anatomy.", only3d: true },
  custom: { label: "Imported model", blurb: "Your own STL or OBJ, simplified so the planes read clearly.", only3d: true, custom: true },
};
const frontOf = (views) => views.find((v) => v.key === "front").regions;

/* ============================== LIGHTING ============================== */
function lightVector(azDeg, elDeg) {
  const a = (azDeg * Math.PI) / 180, e = (elDeg * Math.PI) / 180;
  const ce = Math.cos(e);
  return [ce * Math.sin(a), Math.sin(e), ce * Math.cos(a)];
}
function brightness(normal, L, ao = 1) {
  const d = normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2];
  // ambient floor + directional, then ambient occlusion: a recessed plane (ao→0) loses
  // its ambient/bounce light fully and part of the direct light, so valleys read dark
  // regardless of how they happen to face the light — "shadow gathers in the recesses".
  return 0.05 * ao + 0.95 * smoothstep(-0.3, 1, d) * (0.5 + 0.5 * ao);
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
function buildStages(n, method = "brush") {
  const air = method === "airbrush"; // brush/airbrush swap the copy; id/mode/iso stay identical
  const has = (k) => tierMeta(n).some((t) => t.key === k);
  const s = [
    { id: "prime", name: "Prime black", mode: "prime", iso: null,
      note: air
        ? "Airbrush thinned black primer in light passes at low pressure (~15–20 PSI). This is your deepest shadow — everything builds from here."
        : "Thin, even coat of black primer. This is your deepest shadow — everything builds up from here.",
      watch: air
        ? "Too close or too wet and it pools and spiders. Back off to about a hand's width and build it in thin passes."
        : "Don't flood it. Heavy primer fills detail and hides the sculpt. Several light passes beat one wet one." },
    { id: "zenithal", name: "Zenithal", mode: "zenithal", iso: null,
      note: air
        ? "Spray white from straight overhead in soft passes — pre-baking the light map, tops bright and undersides dark. This step was always an airbrush job."
        : "Spray white from straight above. You're pre-baking the light map — tops bright, undersides dark.",
      watch: air
        ? "Keep the nozzle strictly overhead. Drift to the side and your sprayed shading won't match where light actually falls."
        : "Keep the light strictly overhead. Angle it and your free shading no longer matches where light actually falls." },
    { id: "base", name: "Base coat", mode: "paint", iso: null,
      note: air
        ? "Thin the base to milk and lay angled passes from slightly above, letting the zenithal value glow through."
        : "Lay the midtone over everything, thin enough to let the zenithal value show through. This is the whole scheme before you isolate the lights and darks.",
      watch: air
        ? "Paint too thick or pressure too high goes chalky and buries the zenithal. Thin it more and build more passes."
        : "Opaque here buries the zenithal. If you go solid, you've signed up to rebuild all the shading by hand." },
    { id: "shade", name: "Shade", mode: "paint", iso: "shadow",
      note: air
        ? "Drop the spray angle: thinned shadow color low and from the side, so the cone only catches the undersides and recesses."
        : "Push your shadow into the recesses — a thin all-over wash settles into them on its own, or glaze it in deliberately where you want more control.",
      watch: air
        ? "Spray straight-on and shadow lands everywhere. Lower the angle so the raised planes stay clean."
        : "Keep it in the valleys. Shadow creeping onto raised planes flattens the whole figure." },
  ];
  if (has("mid")) s.push({ id: "mid", name: "Midtone highlight", mode: "paint", iso: "mid",
    note: air
      ? "Raise the angle back toward overhead so only the broad upper faces catch the pass."
      : "First, broad highlight on the raised faces — layered and feathered, not a hard line (the edge step does the crisp lines). Pull it back off the recesses.",
    watch: air
      ? "Ease off the pressure and stay above — overspray drifting down flattens the highlight."
      : "This layer is broad. Resist going bright yet — that's the next step's job." });
  s.push({ id: "top", name: "Highlight", mode: "paint", iso: "top",
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

/* ============================== FIGURE VIEW ============================== */
// Centroid of a "x,y x,y …" polygon — used to place the light marker.
function centroid(pts) {
  const pairs = pts.trim().split(/\s+/).map((p) => p.split(",").map(Number));
  const n = pairs.length || 1;
  return [pairs.reduce((a, p) => a + p[0], 0) / n, pairs.reduce((a, p) => a + p[1], 0) / n];
}
const FigureView = React.memo(function FigureView({ label, regions, L, ramp, mode, isoTier, tierKeys, glazeOn, glazeLayers, pooling, valueMode, sprayOn = false, focus = 0.5, sprayColor = "#cfe3ef", orbOn = false, Lorb = null, orbColor = "#3fb8ff", orbInt = 0.5, viewBox = "0 0 200 460", svgExtra = "", zoneRamps = null, zoneMap = null, zoneMetals = null, onPickRegion = null }) {
  // The facet facing the light most directly is just the max of b = dot(normal, light);
  // marking it makes the whole shading model legible at a glance.
  const bs = regions.map((r) => brightness(r.n, L, r.ao));
  let maxI = 0; for (let i = 1; i < bs.length; i++) if (bs[i] > bs[maxI]) maxI = i;
  const [sunX, sunY] = centroid(regions[maxI].p);
  return (
    <div className="flex flex-col items-center min-w-0">
      <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className={"w-full h-auto " + svgExtra}>
        {regions.map((r, i) => {
          const b = bs[i];
          // each region shades from its zone's ramp (zone 0 = the main ramp)
          const zi = (zoneMap && zoneMap[i]) || 0;
          const zr = (zoneRamps && (zoneRamps[zi] || zoneRamps[0])) || ramp;
          const met = zoneMetals && zoneMetals[zi];
          const idx = tierIndex(b, zr.length);
          let fill, dim = isoTier != null && tierKeys[idx] !== isoTier;
          if (sprayOn) { fill = mix("#33322d", sprayColor, sprayCoverage(r.n, L, focus)); dim = false; } // coverage, not value
          else if (mode === "prime") fill = "#1b1b1b";
          else if (mode === "zenithal") fill = valueGrey(b);
          else if (glazeOn) fill = glazeColor(b, glazeLayers, pooling);
          else if (met) fill = nmmColor(met, b, r.n); // NMM zone: metal shading, not the tier ramp
          else fill = zr[idx];
          if (valueMode && mode === "paint" && !sprayOn) fill = valueGreyOf(fill); // squint test: show value, not hue
          if (orbOn && Lorb && !sprayOn) fill = orbGlow(fill, r.n, Lorb, orbColor, orbInt); // object-source glow adds on top
          return (
            <polygon key={i} points={r.p} fill={fill}
              opacity={dim ? 0.12 : 1}
              onClick={onPickRegion ? () => onPickRegion(i) : undefined}
              style={onPickRegion ? { cursor: "crosshair" } : undefined}
              stroke="#00000033" strokeWidth="0.6" strokeLinejoin="round" />
          );
        })}
        {mode !== "prime" && (
          /* light hotspot: a soft amber glow over the facet that faces the light most */
          <g pointerEvents="none">
            <circle cx={sunX} cy={sunY} r="7" fill="#fde68a" opacity="0.16" />
            <circle cx={sunX} cy={sunY} r="3.6" fill="#fde68a" opacity="0.34" />
            <circle cx={sunX} cy={sunY} r="1.8" fill="#fff6da" stroke="#9a7724" strokeWidth="0.5" />
          </g>
        )}
      </svg>
      <div className="mt-1 text-[10px] tracking-[0.25em] uppercase text-stone-400">{label}</div>
    </div>
  );
});

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
// Orient every face of a convex part so its normal points away from the part's center —
// makes winding bulletproof for boxes/prisms/segments at any orientation.
function orientFaces(faces) {
  const c = centroid3(faces.flat());
  return faces.map((f) => (dot3(faceNormal(f), sub3(centroid3(f), c)) < 0 ? [...f].reverse() : f));
}
function box(cx, cy, cz, hx, hy, hz) {
  const X = [cx - hx, cx + hx], Y = [cy - hy, cy + hy], Z = [cz - hz, cz + hz];
  const c = (i, j, k) => [X[i], Y[j], Z[k]];
  return orientFaces([
    [c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)], [c(1, 0, 0), c(0, 0, 0), c(0, 1, 0), c(1, 1, 0)],
    [c(1, 0, 1), c(1, 0, 0), c(1, 1, 0), c(1, 1, 1)], [c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)],
    [c(0, 1, 1), c(1, 1, 1), c(1, 1, 0), c(0, 1, 0)], [c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)],
  ]);
}
// An N-sided (optionally tapered, elliptical) vertical prism. Faceted sides give normals
// that fan around the form, so a single light reads the full value range across the mass.
// czB/czT let a section lean front-to-back (z), which is what sculpts the side profile.
function prism(cx, czB, czT, rxBot, rzBot, rxTop, rzTop, y0, y1, sides) {
  const bot = [], top = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    bot.push([cx + rxBot * ca, y0, czB + rzBot * sa]);
    top.push([cx + rxTop * ca, y1, czT + rzTop * sa]);
  }
  const faces = [];
  for (let i = 0; i < sides; i++) { const j = (i + 1) % sides; faces.push([bot[i], top[i], top[j], bot[j]]); }
  faces.push(top); faces.push(bot);
  return orientFaces(faces);
}
// A tapered prism between two arbitrary 3D points — for angled limbs and the rifle.
function segment(p0, p1, r0, r1, sides) {
  const d = norm3(sub3(p1, p0));
  const helper = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(cross3(helper, d)), v = norm3(cross3(d, u));
  const a = [], b = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Math.PI * 2, ca = Math.cos(t), sa = Math.sin(t);
    const off = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
    a.push([p0[0] + r0 * off[0], p0[1] + r0 * off[1], p0[2] + r0 * off[2]]);
    b.push([p1[0] + r1 * off[0], p1[1] + r1 * off[1], p1[2] + r1 * off[2]]);
  }
  const faces = [];
  for (let i = 0; i < sides; i++) { const j = (i + 1) % sides; faces.push([a[i], b[i], b[j], a[j]]); }
  faces.push(a); faces.push(b);
  return orientFaces(faces);
}
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
function meshAdjacency(mesh) {
  if (mesh._adj) return mesh._adj;
  const key = (p) => p[0].toFixed(1) + "," + p[1].toFixed(1) + "," + p[2].toFixed(1);
  const edgeMap = new Map(), adj = mesh.faces.map(() => []);
  mesh.faces.forEach((f, i) => {
    for (let a = 0; a < f.length; a++) {
      const k1 = key(f[a]), k2 = key(f[(a + 1) % f.length]);
      const ek = k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
      const other = edgeMap.get(ek);
      if (other !== undefined && other !== i) { adj[i].push(other); adj[other].push(i); }
      else edgeMap.set(ek, i);
    }
  });
  return (mesh._adj = adj);
}
function zonePatch(mesh, start, maxFaces = 1500) {
  const adj = meshAdjacency(mesh), norms = mesh.normals;
  const out = [start], seen = new Set(out);
  for (let q = 0; q < out.length && out.length < maxFaces; q++) {
    for (const j of adj[out[q]]) {
      if (!seen.has(j) && dot3(norms[out[q]], norms[j]) > 0.72) { seen.add(j); out.push(j); }
    }
  }
  return out;
}

/* ---- Import your own model (STL/OBJ) — parse, normalize, decimate in-browser. ---- */
// Binary or ASCII STL -> triangle soup (verts get welded by the decimator's clustering).
function parseSTL(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 84) throw new Error("File too small to be an STL.");
  const dv = new DataView(buf);
  const isBinary = 84 + dv.getUint32(80, true) * 50 === bytes.length; // size math beats the "solid" prefix check
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
      for (let i = 1; i < p.length; i++) idx.push(parseInt(p[i].split("/")[0], 10) - 1);
      faces.push(idx);
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

// ---- Generic croquis figures (~8 heads tall), higher facet counts + sculpted side
//      profile (chest forward, seat back, posture S-curve via the prism z-lean) and
//      proper hands/feet. Built from prisms (masses) + segments (limbs). +y up, +z front. ----
// Foot: a heel/ankle block plus a flatter sole that extends forward to the toes.
function foot(s) {
  const x = 9 * s;
  return [...box(x, -77, -2, 4.5, 6, 5), ...box(x, -81, 8, 4.2, 2.5, 11)];
}
// Hand: a small flattened block reading as a fist/paddle, hung just past the wrist point p.
function hand(p) { return box(p[0], p[1] - 3, p[2], 3.4, 4.6, 2.6); }
function bodyCore() {
  return [
    ...prism(0, 3, 4, 9, 10, 7, 8, 68, 88, 14),       // head (small ovoid, leaning forward)
    ...prism(0, 1, 3, 5.5, 5.5, 6, 6, 58, 69, 10),    // neck
    ...prism(0, -1, 3, 14, 10, 22, 13, 30, 58, 16),   // torso: waist(back) -> chest/shoulders(forward, deep)
    ...prism(0, -3, -1, 17, 12, 14, 10, 4, 30, 16),   // pelvis: seat(back) -> waist
    ...segment([8, 6, 1], [8, -36, -1], 10, 7, 10),       // thigh (knee tucks back)
    ...segment([-8, 6, 1], [-8, -36, -1], 10, 7, 10),
    ...segment([8, -36, -1], [9, -78, 3], 9, 4.5, 10),    // calf bulge -> ankle forward
    ...segment([-8, -36, -1], [-9, -78, 3], 9, 4.5, 10),
    ...foot(1), ...foot(-1),
    ...box(0, -87, 2, 28, 4, 18),                     // plinth
  ];
}
// Arm hanging at the side, slightly out & forward, hand near the upper thigh (s = +1/-1).
function armDown(s) {
  return [
    ...segment([20 * s, 56, 1], [23 * s, 28, 2], 7, 5.5, 10),  // upper arm
    ...segment([23 * s, 28, 2], [24 * s, 2, 3], 5.5, 3.6, 10), // forearm
    ...hand([24 * s, 2, 3]),
  ];
}
// Mesh construction (especially the O(n²) AO pass on the ~2.8k-face scan) is deferred
// until a model is actually shown, so page load doesn't pay for meshes never opened.
const buildStanding = () => buildMesh([...bodyCore(), ...armDown(1), ...armDown(-1)]);
const buildGun = () => buildMesh([
  ...bodyCore(),
  // arms raised onto a rifle tilted up across the front (asymmetric, angled planes)
  ...segment([20, 56, 2], [18, 36, 11], 7, 5.5, 10),  // right upper arm (out & forward)
  ...segment([18, 36, 11], [14, 20, 17], 5.5, 4, 9),  // right forearm -> butt grip
  ...hand([14, 19, 17]),
  ...segment([-20, 56, 2], [-22, 48, 11], 7, 5.5, 10),// left upper arm (raised)
  ...segment([-22, 48, 11], [-26, 50, 16], 5.5, 4, 9),// left forearm -> fore-grip
  ...hand([-26, 49, 16]),
  ...segment([16, 18, 17], [-32, 56, 13], 3.5, 2.5, 9), // rifle: low-right -> up-left, in front
]);
// Bust: the same head/neck on broad shoulders, cut at the chest on a base.
const buildBust = () => buildMesh([
  ...prism(0, 3, 4, 9, 10, 7, 8, 68, 88, 14),     // head
  ...prism(0, 1, 3, 5.5, 5.5, 6, 6, 56, 69, 10),  // neck
  ...prism(0, -1, 3, 16, 12, 24, 13, 30, 58, 16), // shoulders / upper chest (forward)
  ...prism(0, -1, 0, 26, 16, 18, 13, 12, 30, 14), // chest (flares to the cut)
  ...box(0, 5, 0, 30, 8, 20),                     // base
]);

const MESH_BUILDERS = {
  bust: buildBust, standing: buildStanding, gun: buildGun,
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
const Model3DCanvas = React.memo(function Model3DCanvas({ mesh, L, ramp, mode, isoTier, tierKeys, glazeOn, glazeLayers, pooling, valueMode, sprayOn = false, focus = 0.5, sprayColor = "#cfe3ef", orbOn = false, Lorb = null, orbColor = "#3fb8ff", orbInt = 0.5, noDrag, initRot, zoneRamps = null, zoneMap = null, zoneMetals = null, zoneVer = 0, onPickFace = null, brushSize = 0, onBrushFaces = null }) {
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
  const onDown = (e) => {
    if (noDrag) return;
    if (onBrushFaces && brushSize > 0) { drag.current = { painting: true }; e.currentTarget.setPointerCapture?.(e.pointerId); brushAt(e); return; }
    drag.current = { x: e.clientX, y: e.clientY, moved: false, ...rot }; e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const raf = useRef(0), pendingRot = useRef(null);
  const onMove = (e) => {
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
    const wasPainting = drag.current && drag.current.painting;
    const wasClick = drag.current && !drag.current.painting && !drag.current.moved;
    drag.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (e.type === "pointerleave" && ringRef.current) ringRef.current.style.display = "none";
    if (wasPainting || !wasClick || !onPickFace) return;
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
  const brights = useMemo(() => mesh.faces.map((f, i) => brightness(mesh.normals[i], L, mesh.ao[i])), [mesh, L]);

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
      vis.push({ i, n: normals[i], cv, depth: cv.reduce((a, v) => a + v[2], 0) / cv.length, b: brights[i] });
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
      if (sprayOn) { fill = mix("#33322d", sprayColor, sprayCoverage(o.n, L, focus)); dim = false; }
      else if (mode === "prime") fill = "#1b1b1b";
      else if (mode === "zenithal") fill = valueGrey(o.b);
      else if (glazeOn) fill = glazeColor(o.b, glazeLayers, pooling);
      else if (met) fill = nmmColor(met, o.b, o.n); // NMM zone: metal shading, not the tier ramp
      else fill = zr[idx];
      if (valueMode && mode === "paint" && !sprayOn) fill = valueGreyOf(fill);
      if (orbOn && Lorb && !sprayOn) fill = orbGlow(fill, o.n, Lorb, orbColor, orbInt);
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
  }, [mesh, brights, L, ramp, mode, isoTier, tierKeys, glazeOn, glazeLayers, pooling, valueMode, sprayOn, focus, sprayColor, orbOn, Lorb, orbColor, orbInt, rot, zoom, zoneRamps, zoneMap, zoneMetals, zoneVer, onPickFace]);

  return (
    <div className="relative flex flex-col items-center">
      <canvas ref={canvasRef} width={460} height={600}
        className={"w-full h-auto select-none touch-none " + (onPickFace || onBrushFaces ? "cursor-crosshair" : noDrag ? "" : "cursor-grab active:cursor-grabbing")}
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
const GL_VERT = `#version 300 es
precision highp float;
in vec3 aPos; in vec3 aNrm; in float aFid;
uniform vec3 uCenter; uniform vec4 uRot;
uniform float uSX, uSY, uCamDist, uZr;
out vec3 vWN; out float vCNz; flat out int vFid;
vec3 rotv(vec3 p){
  p = vec3(uRot.x*p.x + uRot.y*p.z, p.y, -uRot.y*p.x + uRot.x*p.z);
  return vec3(p.x, uRot.z*p.y - uRot.w*p.z, uRot.w*p.y + uRot.z*p.z);
}
void main(){
  vec3 v = rotv(aPos - uCenter);
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
uniform vec3 uL, uLorb, uOrbColor, uSprayColor;
uniform vec3 uRamps[28];
uniform vec4 uGlaze[8];
uniform int uGlazeN, uMode, uNTiers, uIso, uMetals[4];
uniform float uPooling, uFocus, uOrbInt;
uniform bool uGlazeOn, uValueMode, uSprayOn, uOrbOn;
out vec4 frag;
vec3 hsl2rgb(vec3 hsl){
  vec3 rgb = clamp(abs(mod(hsl.x*6.0+vec3(0.0,4.0,2.0),6.0)-3.0)-1.0,0.0,1.0);
  float c = (1.0-abs(2.0*hsl.z-1.0))*hsl.y;
  return (rgb-0.5)*c + hsl.z;
}
vec3 vGrey(float b){ return hsl2rgb(vec3(40.0/360.0, 0.04, 0.12 + b*0.78)); }
vec3 nmm(int kind, float b, vec3 n){
  vec3 lo,mid,hi,spark,sky,earth;
  if (kind==2){ lo=vec3(.165,.102,.039); mid=vec3(.541,.353,.102); hi=vec3(.910,.722,.290); spark=vec3(1.,.965,.847); sky=vec3(1.,.929,.690); earth=vec3(.290,.180,.071); }
  else { lo=vec3(.078,.090,.114); mid=vec3(.290,.337,.400); hi=vec3(.659,.722,.800); spark=vec3(.957,.973,1.); sky=vec3(.761,.847,.918); earth=vec3(.180,.169,.149); }
  float t = smoothstep(0.2,0.9,b);
  vec3 c = t<0.5 ? mix(lo,mid,t*2.0) : mix(mid,hi,(t-0.5)*2.0);
  if (b>0.88) c = mix(c, spark, smoothstep(0.88,0.98,b));
  if (n.y>0.0) c = mix(c, sky, n.y*0.35); else c = mix(c, earth, -n.y*0.45);
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
  float b = 0.05*ao + 0.95*smoothstep(-0.3, 1.0, d)*(0.5 + 0.5*ao);
  int idx = clamp(int(floor(b*float(uNTiers-1) + 0.5)), 0, uNTiers-1);
  bool dim = (uIso >= 0) && (idx != uIso);
  vec3 fill;
  if (uSprayOn) {
    float edge = -0.15 + uFocus*0.85;
    float cov = smoothstep(edge, edge + (0.6 - uFocus*0.48), d);
    fill = mix(vec3(0.200,0.196,0.176), uSprayColor, cov); dim = false;
  }
  else if (uMode == 1) fill = vec3(0.106,0.106,0.106);
  else if (uMode == 2) fill = vGrey(b);
  else if (uGlazeOn) {
    vec3 c = vGrey(b);
    for (int i = 0; i < 8; i++) { if (i >= uGlazeN) break;
      float eff = clamp(uGlaze[i].a*(1.0 - uPooling*b), 0.0, 1.0);
      c = mix(c, uGlaze[i].rgb, eff);
    }
    fill = c;
  }
  else if (uMetals[zone] > 0) fill = nmm(uMetals[zone], b, n);
  else fill = uRamps[zone*7 + idx];
  if (uValueMode && uMode == 0 && !uSprayOn) {
    vec3 lin = pow(fill, vec3(2.2));
    fill = vec3(pow(dot(lin, vec3(0.2126,0.7152,0.0722)), 1.0/2.2));
  }
  if (uOrbOn && !uSprayOn) fill = clamp(fill + uOrbColor * (uOrbInt * smoothstep(0.0,1.0,dot(n,uLorb))), 0.0, 1.0);
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
vec3 rotv(vec3 p){
  p = vec3(uRot.x*p.x + uRot.y*p.z, p.y, -uRot.y*p.x + uRot.x*p.z);
  return vec3(p.x, uRot.z*p.y - uRot.w*p.z, uRot.w*p.y + uRot.z*p.z);
}
void main(){
  vec3 v = rotv(aPos - uCenter);
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
const ModelGL = React.memo(function ModelGL({ mesh, L, ramp, mode, isoTier, tierKeys, glazeOn, glazeLayers, pooling, valueMode, sprayOn = false, focus = 0.5, sprayColor = "#cfe3ef", orbOn = false, Lorb = null, orbColor = "#3fb8ff", orbInt = 0.5, noDrag, initRot, zoneRamps = null, zoneMetals = null, zoneArr = null, zoneVer = 0, onPickFace = null, brushSize = 0, onBrushFaces = null, onGLFail }) {
  const [rot, setRot] = useState(initRot || { yaw: -0.5, pitch: 0.12 });
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef(null), ringRef = useRef(null);
  const S = useRef(null);
  const drag = useRef(null), raf = useRef(0), pendingRot = useRef(null);
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
      buf(g.pos, 0, 3); buf(g.nrm, 1, 3); buf(g.fid, 2, 1);
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
      S.current = { gl, g, prog, pick, line, vao, lineVao, ztex, texH, fbo, up: U(prog), upk: U(pick), ul: line ? U(line) : null, zver: -1, ztmp: new Uint8Array(ZTEX_W * texH * 4) };
    } catch (err) { S.current = null; onGLFail && onGLFail(); return; }
    return () => { try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch {} S.current = null; };
  }, [mesh]);

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
    gl.uniform1i(up("uGlazeOn"), glazeOn ? 1 : 0);
    gl.uniform1i(up("uValueMode"), valueMode ? 1 : 0);
    gl.uniform1i(up("uSprayOn"), sprayOn ? 1 : 0);
    gl.uniform1i(up("uOrbOn"), orbOn && Lorb ? 1 : 0);
    gl.bindVertexArray(st.vao);
    gl.drawArrays(gl.TRIANGLES, 0, g.triCount * 3);
    if (st.line) {
      gl.useProgram(st.line); setCam(st.ul, st);
      gl.bindVertexArray(st.lineVao);
      gl.drawArrays(gl.LINES, 0, g.lines.length / 3);
    }
    gl.bindVertexArray(null);
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
  const onDown = (e) => {
    if (noDrag) return;
    if (onBrushFaces && brushSize > 0) { drag.current = { painting: true }; e.currentTarget.setPointerCapture?.(e.pointerId); brushAt(e); return; }
    drag.current = { x: e.clientX, y: e.clientY, moved: false, ...rot }; e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    moveRing(e);
    if (!drag.current) return;
    if (drag.current.painting) { brushAt(e); return; }
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true;
    pendingRot.current = { yaw: drag.current.yaw + dx * 0.01, pitch: clamp(drag.current.pitch + dy * 0.01, -1.2, 1.2) };
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; setRot(pendingRot.current); });
  };
  const onUp = (e) => {
    const wasPainting = drag.current && drag.current.painting;
    const wasClick = drag.current && !drag.current.painting && !drag.current.moved;
    drag.current = null; e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (e.type === "pointerleave" && ringRef.current) ringRef.current.style.display = "none";
    if (wasPainting || !wasClick || !onPickFace) return;
    const id = pickAt(e);
    if (id >= 0) onPickFace(id);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useEffect(() => {
    const cnv = canvasRef.current; if (!cnv || noDrag) return;
    const onWheel = (e) => { e.preventDefault(); setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.6, 4)); };
    cnv.addEventListener("wheel", onWheel, { passive: false });
    return () => cnv.removeEventListener("wheel", onWheel);
  }, [noDrag]);
  return (
    <div className="relative flex flex-col items-center">
      <canvas key={meshKey} ref={canvasRef} width={460} height={600}
        className={"w-full h-auto select-none touch-none " + (onPickFace || onBrushFaces ? "cursor-crosshair" : noDrag ? "" : "cursor-grab active:cursor-grabbing")}
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
// Public 3D view: WebGL when available, the canvas renderer as automatic fallback.
function Model3D(props) {
  const [useGL, setUseGL] = useState(true);
  if (useGL) return <ModelGL {...props} onGLFail={() => setUseGL(false)} />;
  return <Model3DCanvas {...props} zoneMap={props.zoneArr} />;
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
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const radius = rect.width / 2;
    let h = Math.atan2(dx, -dy) * 180 / Math.PI - 90; h = ((h % 360) + 360) % 360;
    const s = clamp(Math.hypot(dx, dy) / radius * 100, 6, 100);
    const { l } = hexToHsl(base);
    onPickBase(hslToHex(h, s, l));
  }, [base, onPickBase]);

  const points = ramp.map((c) => { const { h, s } = hexToHsl(c); return pos(h, s); });
  return (
    <div className="flex flex-col items-center">
      <div ref={ref} onPointerDown={handle}
        className="relative rounded-full cursor-crosshair select-none touch-none"
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
      <div className="mt-1 text-[10px] tracking-[0.16em] uppercase text-stone-500">tap wheel → set base hue</div>
    </div>
  );
}

/* recess-glaze preview: front view with an accent glazed into the shadow tier */
function GlazePreview({ accent, ramp, L, tierKeys, regions }) {
  return (
    <svg viewBox="0 0 200 460" className="w-full h-auto">
      {regions.map((r, i) => {
        const b = brightness(r.n, L, r.ao);
        const idx = tierIndex(b, ramp.length);
        let fill = ramp[idx];
        if (accent && tierKeys[idx] === "shadow") fill = mix(fill, accent, 0.55);
        return <polygon key={i} points={r.p} fill={fill} stroke="#00000033" strokeWidth="0.6" strokeLinejoin="round" />;
      })}
    </svg>
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
  const [model, setModel] = useState(null); // null = chooser screen
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
  const [zoneMap2d, setZoneMap2d] = useState({});    // { model: { viewKey: { regionIdx: zone } } }
  const [zoneMap3d, setZoneMap3d] = useState({});    // { model: { faceIdx: zone } }
  // Collapsible control sections — core ones open by default, specialty tools tucked away.
  const [openSec, setOpenSec] = useState({ recipe: true, zones: true, light: true });
  const sec = (k) => ({ open: !!openSec[k], onToggle: () => setOpenSec((s) => ({ ...s, [k]: !s[k] })) });
  // Status messages surface as a toast and clear themselves.
  useEffect(() => { if (!status) return; const t = setTimeout(() => setStatus(""), 2600); return () => clearTimeout(t); }, [status]);
  const [pooling, setPooling] = useState(0.6);
  const [glazeLayers, setGlazeLayers] = useState(() => defaultGlaze(generateRamp("#5f8a4a", 5), 3));

  const L = useMemo(() => lightVector(az, el), [az, el]);
  const Lorb = useMemo(() => lightVector(orbAz, orbEl), [orbAz, orbEl]);
  const tiers = useMemo(() => tierMeta(numSteps), [numSteps]);
  const tierKeys = useMemo(() => tiers.map((t) => t.key), [tiers]);
  const stages = useMemo(() => buildStages(numSteps, method), [numSteps, method]);
  const stage = stages.find((s) => s.id === activeStage) || stages[0];
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
  const cycleMetal = (zi) => {
    const next = { null: "steel", steel: "gold", gold: null }[String(zoneMetals[zi])];
    if (zi === 0) setMainMetal(next);
    else setExtraZones((zs) => zs.map((z, k) => (k === zi - 1 ? { ...z, metal: next } : z)));
  };
  const accentMatches = useMemo(() => accents.map((c) => nearestPaint(c, paintBrand)), [accents, paintBrand]);
  // Zone assignment handlers — clicking the figure paints the active zone onto it.
  const pickRegion = useCallback((viewKey) => (i) => {
    setZoneMap2d((m) => {
      const mm = { ...(m[model] || {}) }, vv = { ...(mm[viewKey] || {}) };
      if (activeZone === 0) delete vv[i]; else vv[i] = activeZone;
      mm[viewKey] = vv;
      return { ...m, [model]: mm };
    });
  }, [model, activeZone]);
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
  const applyFaces = useCallback((idxs) => {
    const a = zoneArrFor(model); if (!a) return;
    for (const f of idxs) a[f] = activeZone;
    setZoneVer((v) => v + 1);
    scheduleZonePersist(model);
  }, [model, activeZone]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickFace = useCallback((i) => {
    const mesh = MESH3D[model]; if (!mesh) return;
    applyFaces(glZonePatch(glifyMesh(mesh), i)); // patch mode: a click grabs the smooth connected patch
  }, [model, applyFaces]);
  const brushFaces = applyFaces; // brush mode: paint exactly what the cursor touches
  const clearZones = () => {
    setZoneMap2d((m) => ({ ...m, [model]: {} })); setZoneMap3d((m) => ({ ...m, [model]: {} }));
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
    setZoneMap2d((m) => Object.fromEntries(Object.entries(m).map(([k, views]) => [k,
      Object.fromEntries(Object.entries(views).map(([vk, v]) => [vk, stripFlat(v)]))])));
    for (const a of Object.values(zoneArrs.current)) if (a) { for (let i = 0; i < a.length; i++) if (a[i] === z) a[i] = 0; }
    setZoneVer((v) => v + 1);
    setExtraZones((zs) => zs.slice(0, -1));
    setActiveZone((a) => (a >= z ? 0 : a));
  };
  const setZoneBase = (zi, hex) => { // zi >= 1
    setExtraZones((zs) => zs.map((zz, k) => (k === zi - 1 ? { ...zz, base: hex, ramp: generateRamp(hex, numSteps) } : zz)));
  };
  const only3d = !!(model && MODELS[model].only3d); // 3D-only model (no orthographic sheet)
  const views = (model && MODELS[model].views) || STANDING; // fallback so sheet/preview code never sees undefined
  const previewRegions = frontOf(views);

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
  // Changing the glaze layer count keeps the tuned layers — trim on shrink, append
  // only the new slots on grow. "Colors from recipe" stays the explicit full reset.
  const resizeGlaze = (n) => setGlazeLayers((ls) =>
    n <= ls.length ? ls.slice(0, n) : [...ls, ...defaultGlaze(ramp, n).slice(ls.length)]);

  const save = async () => {
    const nm = name.trim(); if (!nm) { setStatus("Name it first."); return; }
    const recipe = { base, numSteps, ramp, accents, az, el, done, glazeOn, pooling, glazeLayers, method, spray, focus, orbOn, orbAz, orbEl, orbColor, orbInt, extraZones, mainMetal };
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
      ? r.glazeLayers : defaultGlaze(ramp, 3);
    setBase(base); setNumSteps(steps); setRamp(ramp);
    setAccents(Array.isArray(r.accents) ? r.accents.filter(validHex) : []);
    setAz(num(r.az, 0, 0, 360)); setEl(num(r.el, 32, -20, 90)); setPreviewAccent(null);
    setDone(r.done && typeof r.done === "object" ? r.done : {});
    setGlazeOn(!!r.glazeOn); setPooling(num(r.pooling, 0.6, 0, 0.9)); setGlazeLayers(layers);
    setMethod(r.method === "airbrush" ? "airbrush" : "brush");
    setSpray(!!r.spray); setFocus(num(r.focus, 0.5, 0, 1));
    setOrbOn(!!r.orbOn); setOrbAz(num(r.orbAz, 200, 0, 360)); setOrbEl(num(r.orbEl, 0, -20, 90));
    setOrbColor(validHex(r.orbColor) ? r.orbColor : "#3fb8ff"); setOrbInt(num(r.orbInt, 0.5, 0, 1));
    const metalOk = (m) => (m === "steel" || m === "gold" ? m : null);
    setMainMetal(metalOk(r.mainMetal));
    setExtraZones(Array.isArray(r.extraZones)
      ? r.extraZones.slice(0, 3).filter((z) => z && validHex(z.base)).map((z, k) => ({
          name: typeof z.name === "string" && z.name.trim() ? z.name.slice(0, 24) : "Zone " + (k + 2),
          base: z.base,
          metal: metalOk(z.metal),
          ramp: Array.isArray(z.ramp) && z.ramp.length === steps && z.ramp.every(validHex) ? z.ramp : generateRamp(z.base, steps),
        }))
      : []);
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
            // Colors/light/steps are restored, but the app always opens on the model chooser.
            if (typeof r.activeStage === "string") setActiveStage(r.activeStage);
            if (typeof r.paintBrand === "string") setPaintBrand(r.paintBrand);
            if (r.zoneMap2d && typeof r.zoneMap2d === "object") setZoneMap2d(r.zoneMap2d);
            if (r.zoneMap3d && typeof r.zoneMap3d === "object") setZoneMap3d(r.zoneMap3d);
            if (r.openSec && typeof r.openSec === "object") setOpenSec(r.openSec);
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
      try { window.storage.set("session:last", JSON.stringify({ model, activeStage, base, numSteps, ramp, accents, az, el, done, glazeOn, pooling, glazeLayers, method, spray, focus, orbOn, orbAz, orbEl, orbColor, orbInt, paintBrand, extraZones, mainMetal, zoneMap2d, zoneMap3d, openSec })); } catch {}
    }, 300);
    return () => clearTimeout(saveTimer.current);
  }, [model, activeStage, base, numSteps, ramp, accents, az, el, done, glazeOn, pooling, glazeLayers, method, spray, focus, orbOn, orbAz, orbEl, orbColor, orbInt, paintBrand, extraZones, mainMetal, zoneMap2d, zoneMap3d, openSec]);

  // Export a painting-reference PNG: the figure as shown + value ramp, accents, light & glaze.
  const exportPNG = () => {
    const pad = 28, W = 740, figW = 300, figH = 380, top = 92;
    const cv = document.createElement("canvas");
    // right column: ramp grid + per-zone paint lists + accents + light/glaze lines — size to whichever is taller
    const paintsH = zoneMatches.reduce((s, m) => s + (zoneMatches.length > 1 ? 15 : 0) + m.length * 16, 27);
    const rightH = 22 + Math.ceil(tiers.length / 4) * 72 + 14 + paintsH + (accents.length ? 54 : 0) + 60;
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
    } else {
      const s = Math.min(figW / 200, figH / 460), ox = fx + (figW - 200 * s) / 2;
      const zmFront = zoneMap2d[model]?.front || {};
      for (const [ri, r] of previewRegions.entries()) {
        const zif = zmFront[ri] || 0;
        const zr = zoneRamps[zif] || ramp, met = zoneMetals[zif];
        const b2 = brightness(r.n, L, r.ao);
        const fill = met ? nmmColor(met, b2, r.n) : zr[tierIndex(b2, zr.length)];
        ctx.beginPath();
        r.p.trim().split(/\s+/).forEach((pt, i) => { const [x, y] = pt.split(",").map(Number); const X = ox + x * s, Y = fy + y * s; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
        ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 0.5; ctx.strokeStyle = "#00000033"; ctx.stroke();
      }
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
    ctx.fillText("Light — orbit " + Math.round(az) + "°, height " + Math.round(el) + "°", rx, ry); ry += 20;
    ctx.fillText("Paint — " + (glazeOn ? "Glaze · pooling " + Math.round(pooling * 100) + "% · " + glazeLayers.length + " layers" : "Opaque"), rx, ry);
    const a = document.createElement("a");
    a.download = (name.trim() || "light-bench") + ".png";
    a.href = cv.toDataURL("image/png"); a.click();
    setStatus("Exported PNG.");
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

  if (!model) return <Chooser ramp={ramp} L={L} onPick={setModel} onImport={importModel} customReady={customReady} importMsg={importMsg} detail={detail} onDetail={setDetail} />;

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
          <div className="flex items-center gap-2 mb-1">
            <div className="flex items-center rounded-full border border-stone-700 overflow-hidden text-[11px]" title="Switch the Steps panel between brush and airbrush workflows">
              <button onClick={() => setMethod("brush")}
                className={"px-3 py-1.5 transition-colors " + (method === "brush" ? "bg-stone-700 text-stone-100" : "text-stone-400 hover:text-stone-200")}>Brush</button>
              <button onClick={() => setMethod("airbrush")}
                className={"px-3 py-1.5 transition-colors " + (method === "airbrush" ? "bg-sky-700/70 text-stone-100" : "text-stone-400 hover:text-stone-200")}>Airbrush</button>
            </div>
            <button onClick={exportPNG} title="Download a reference image to take to the bench"
              className="flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-200 border border-stone-700 hover:border-stone-500 rounded-full px-3 py-1.5">
              <Download size={12} /> Export PNG
            </button>
            <button onClick={() => setModel(null)}
              className="text-[11px] text-stone-400 hover:text-stone-200 border border-stone-700 hover:border-stone-500 rounded-full px-3 py-1.5">
              Model: <span className="text-stone-200">{MODELS[model].label}</span> · change
            </button>
            {model === "custom" && (
              <label className="text-[11px] text-stone-400 hover:text-stone-200 border border-stone-700 hover:border-stone-500 rounded-full px-3 py-1.5 cursor-pointer"
                title="Load a different STL/OBJ in place of this one (same detail setting)">
                <input type="file" accept=".stl,.obj" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) importModel(f); e.target.value = ""; }} />
                Replace file…
              </label>
            )}
            {model === "custom" && importMsg && <span className="text-[11px] text-amber-400">{importMsg}</span>}
          </div>
        </div>
        <p className="text-stone-400 text-[13px] max-w-2xl">
          One light, one figure, four views. Move the light and watch where each value lands. Build a recipe,
          check it on the wheel, then walk the steps.
        </p>
      </div>

      <div className="max-w-6xl w-full mx-auto px-4 pb-4 flex-1 min-h-0 flex flex-col lg:flex-row gap-5 items-start">
          {/* ===== MODEL PANE (fits to viewport height) ===== */}
          <div className="w-full sticky top-0 z-10 max-h-[42vh] overflow-y-auto bg-[#141611] lg:static lg:z-auto lg:max-h-none lg:bg-transparent lg:w-[36%] lg:flex-none lg:h-full controls-scroll lg:pr-1">
            <div ref={figRef} className="relative rounded-xl border border-stone-700/60 p-3"
              style={{ background: "radial-gradient(120% 90% at 50% 0%, #20241b, #141611 75%)" }}>
              {zonePaint && (
                <div className="absolute top-2 left-2 right-2 z-20 flex flex-wrap items-center gap-1">
                  {zoneNames.map((nm, zi) => (
                    <button key={zi} onClick={() => setActiveZone(zi)} aria-pressed={activeZone === zi}
                      className={"flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] border " +
                        (activeZone === zi ? "border-lime-400 text-stone-100 bg-stone-900/90" : "border-stone-600 text-stone-300 bg-stone-900/70 hover:border-stone-400")}>
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: dispRamps[zi][Math.floor(dispRamps[zi].length / 2)] }} />
                      {nm}
                    </button>
                  ))}
                  {only3d && (
                    <button onClick={() => setZoneMode(zoneMode === "patch" ? "brush" : "patch")}
                      title="Switch between auto fill and brush"
                      className="px-2 py-1 rounded-full text-[10px] border border-stone-600 text-stone-300 bg-stone-900/70 hover:border-stone-400">
                      {zoneMode === "patch" ? "auto fill" : "brush"}
                    </button>
                  )}
                </div>
              )}
              {only3d && MESH3D[model] ? (
                <Model3D mesh={MESH3D[model]} L={L} ramp={ramp} mode={stage.mode} isoTier={stage.iso}
                  tierKeys={tierKeys} glazeOn={glazeOn} glazeLayers={glazeLayers} pooling={pooling} valueMode={valueMode}
                  sprayOn={sprayActive} focus={focus} sprayColor={sprayColor}
                  orbOn={orbOn} Lorb={Lorb} orbColor={orbColor} orbInt={orbInt}
                  zoneRamps={zoneRamps} zoneArr={zoneArrFor(model)} zoneVer={zoneVer} zoneMetals={zoneMetals}
                  onPickFace={zonePaint && zoneMode === "patch" ? pickFace : null}
                  brushSize={zonePaint && zoneMode === "brush" ? brushSize : 0}
                  onBrushFaces={zonePaint && zoneMode === "brush" ? brushFaces : null} />
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {views.filter((v) => v.key !== "top").map((v) => (
                      <FigureView key={v.key} label={v.label} regions={v.regions} L={L} ramp={ramp}
                        mode={stage.mode} isoTier={stage.iso} tierKeys={tierKeys}
                        glazeOn={glazeOn} glazeLayers={glazeLayers} pooling={pooling} valueMode={valueMode}
                        sprayOn={sprayActive} focus={focus} sprayColor={sprayColor}
                        orbOn={orbOn} Lorb={Lorb} orbColor={orbColor} orbInt={orbInt}
                        zoneRamps={zoneRamps} zoneMap={zoneMap2d[model]?.[v.key]} zoneMetals={zoneMetals}
                        onPickRegion={zonePaint ? pickRegion(v.key) : null}
                        svgExtra="lg:max-h-[27vh]" />
                    ))}
                  </div>
                  {views.find((v) => v.key === "top") && (
                    <div className="mt-2 pt-2 border-t border-stone-700/40">
                      <div className="mx-auto" style={{ width: "70%" }}>
                        <FigureView label="Top (from above)" regions={views.find((v) => v.key === "top").regions}
                          viewBox="0 0 220 150" L={L} ramp={ramp}
                          mode={stage.mode} isoTier={stage.iso} tierKeys={tierKeys}
                          glazeOn={glazeOn} glazeLayers={glazeLayers} pooling={pooling} valueMode={valueMode}
                          sprayOn={sprayActive} focus={focus} sprayColor={sprayColor}
                          orbOn={orbOn} Lorb={Lorb} orbColor={orbColor} orbInt={orbInt}
                          zoneRamps={zoneRamps} zoneMap={zoneMap2d[model]?.top} zoneMetals={zoneMetals}
                          onPickRegion={zonePaint ? pickRegion("top") : null}
                          svgExtra="lg:max-h-[15vh]" />
                      </div>
                    </div>
                  )}
                </>
              )}
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

        {/* ===== RECIPE BUILDER ===== */}
        <Section icon={<Palette size={15} />} title="Recipe" {...sec("recipe")}>
          <div className="flex flex-wrap items-center gap-4 mb-4">
            <label className="flex items-center gap-2 text-sm text-stone-300">
              Base color
              <input type="color" value={base} onChange={(e) => pickBase(e.target.value)}
                className="w-9 h-9 rounded cursor-pointer bg-transparent border border-stone-700" />
            </label>
            <div className="flex items-center gap-1 text-sm text-stone-300">
              Steps
              {[3, 4, 5].map((n) => (
                <button key={n} onClick={() => pickSteps(n)}
                  className={"w-8 h-8 rounded-md text-sm border " + (numSteps === n ? "border-stone-300 text-white" : "border-stone-700 text-stone-400")}>
                  {n}
                </button>
              ))}
            </div>
            <button onClick={() => setRamp(generateRamp(base, numSteps))}
              className="flex items-center gap-1.5 px-3 py-2 rounded-md text-xs border border-stone-700 hover:border-stone-500 text-stone-300">
              <RotateCcw size={13} /> Auto-generate
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
        </Section>

        {/* ===== ZONES ===== */}
        <Section icon={<Layers size={15} />} title="Zones (materials)" {...sec("zones")}>
          <p className="text-[11px] text-stone-500 mb-3 leading-snug">
            Give cloak, armor, and skin their own color schemes — all shaded by the same light.
            Pick a zone, switch on <b className="text-stone-300">Assign</b>, then click the figure to paint parts into it.
            The <b className="text-stone-300">matte / steel / gold</b> toggle turns a zone into NMM — metal painted with
            matte paint: harder contrast, a bright ping, sky color on up-facing planes and ground color underneath.
          </p>
          <div className="space-y-1.5 mb-3">
            {zoneNames.map((nm, zi) => (
              <div key={zi} className={"flex items-center gap-2 rounded-lg border px-2 py-1.5 " +
                (activeZone === zi ? "border-stone-400 bg-stone-800/40" : "border-stone-700/50")}>
                <button onClick={() => setActiveZone(zi)} aria-pressed={activeZone === zi}
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
          <div className="flex flex-wrap items-center gap-2">
            {extraZones.length < 3 && (
              <button onClick={addZone} className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs border border-stone-700 hover:border-stone-500 text-stone-300">
                <Plus size={12} /> Add zone
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
              Assign: {zonePaint ? "on — click the figure" : "off"}
            </button>
            {zonePaint && only3d && (
              <div className="flex items-center rounded-md border border-stone-700 overflow-hidden text-xs">
                <button onClick={() => setZoneMode("patch")} aria-pressed={zoneMode === "patch"}
                  title="A click grabs the whole smooth patch around the face you hit — fast for big areas"
                  className={"px-3 py-1.5 " + (zoneMode === "patch" ? "bg-stone-700 text-stone-100" : "text-stone-400 hover:text-stone-200")}>
                  Auto fill
                </button>
                <button onClick={() => setZoneMode("brush")} aria-pressed={zoneMode === "brush"}
                  title="Drag to paint exactly the faces under the brush — for edges auto fill can't see, like hair against skin"
                  className={"px-3 py-1.5 " + (zoneMode === "brush" ? "bg-stone-700 text-stone-100" : "text-stone-400 hover:text-stone-200")}>
                  Brush
                </button>
              </div>
            )}
            <button onClick={clearZones} className="px-3 py-1.5 rounded-md text-xs border border-stone-700 hover:border-stone-500 text-stone-400">
              Clear this model
            </button>
          </div>
          {zonePaint && only3d && zoneMode === "brush" && (
            <div className="mt-2 max-w-[220px]">
              <Slider label="Brush size" value={brushSize} min={8} max={60} onChange={setBrushSize} suffix="px" />
            </div>
          )}
          {zonePaint && <p className="text-[11px] text-amber-300/80 mt-2">
            Assigning to <b>{zoneNames[activeZone]}</b>
            {only3d
              ? (zoneMode === "brush"
                  ? " — drag paints under the brush (orbiting is paused; turn Assign off to rotate)."
                  : " — drag still orbits; a click (no drag) auto-fills the smooth patch.")
              : " — click any facet in any view."}
            {" "}Set the active zone to Main to un-assign.</p>}
        </Section>

        {/* ===== LIGHT CONTROLS ===== */}
        <Section icon={<Sun size={15} />} title="Light direction" {...sec("light")}>
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
        </Section>

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
                      <p className="text-[11px] text-amber-300/80 leading-snug"><b className="text-amber-300">Watch for:</b> {s.watch}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        {method === "airbrush" && (
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

        {/* ===== GLOW SOURCE (object-source lighting) ===== */}
        <Section icon={<Lightbulb size={15} />} title="Glow source (object light)" {...sec("glow")}>
          <p className="text-[11px] text-stone-500 mb-3 leading-snug">
            A second, colored light — a power weapon, a gem, glowing eyes — at its own bearing around the model. It{" "}
            <span className="text-stone-300">adds</span> on top of the main light: planes facing the orb pick up its
            color and brighten; planes facing away are untouched. Aim it independently to see the glow on its own.
          </p>
          <div className="flex items-center gap-3 mb-1">
            <button onClick={() => setOrbOn((v) => !v)} role="switch" aria-checked={orbOn} aria-label="Toggle object-source glow"
              className={"relative w-12 h-6 rounded-full transition-colors flex-none " + (orbOn ? "bg-sky-600" : "bg-stone-700")}>
              <span className={"absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all " + (orbOn ? "left-6" : "left-0.5")} />
            </button>
            <div className="text-sm text-stone-200 font-medium">{orbOn ? "Glow on" : "Glow off"}</div>
          </div>
          {orbOn && (
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
          )}
        </Section>

        <Section icon={<Droplets size={15} />} title="Paint behavior" {...sec("behavior")}>
          <div className="flex items-center gap-3 mb-1">
            <button onClick={() => setGlazeOn((v) => !v)} role="switch" aria-checked={glazeOn} aria-label="Toggle glaze mode"
              className={"relative w-12 h-6 rounded-full transition-colors flex-none " + (glazeOn ? "bg-sky-600" : "bg-stone-700")}>
              <span className={"absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all " + (glazeOn ? "left-6" : "left-0.5")} />
            </button>
            <div>
              <div className="text-sm text-stone-200 font-medium">{glazeOn ? "Glaze (transparent layers)" : "Opaque (flat coats)"}</div>
              <div className="text-[11px] text-stone-500">{glazeOn ? "Layers build up and let what's underneath show through." : "Each plane is one solid color — the original model."}</div>
            </div>
          </div>

          {glazeOn && (
            <div className="mt-4 space-y-4">
              <Slider label="Recess pooling (thin on highlights, builds in shadow)" value={pooling * 100} min={0} max={90}
                onChange={(v) => setPooling(v / 100)} suffix="%" />

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] text-stone-400">Layers (bottom → top)</span>
                  <div className="flex items-center gap-1">
                    {[2, 3, 4, 5].map((n) => (
                      <button key={n} onClick={() => resizeGlaze(n)}
                        className={"w-7 h-7 rounded-md text-xs border " + (glazeLayers.length === n ? "border-stone-300 text-white" : "border-stone-700 text-stone-400")}>
                        {n}
                      </button>
                    ))}
                    <button onClick={() => setGlazeLayers(defaultGlaze(ramp, glazeLayers.length))}
                      className="ml-1 flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] border border-stone-700 hover:border-stone-500 text-stone-300">
                      <RotateCcw size={12} /> Colors from recipe
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  {glazeLayers.map((L, i) => (
                    <div key={i} className="flex items-center gap-3 bg-stone-900/40 rounded-lg p-2">
                      <label className="cursor-pointer flex-none">
                        <span className="block w-8 h-8 rounded-md border border-stone-600" style={{ background: L.color }} />
                        <input type="color" value={L.color} className="sr-only" aria-label={"Glaze layer " + (i + 1) + " color"}
                          onChange={(e) => setGlazeLayers((ls) => ls.map((x, k) => k === i ? { ...x, color: e.target.value } : x))} />
                      </label>
                      <div className="flex-1">
                        <div className="flex justify-between text-[10px] text-stone-500 mb-1">
                          <span>Layer {i + 1} opacity</span><span className="tabular-nums text-stone-300">{Math.round(L.opacity * 100)}%</span>
                        </div>
                        <input type="range" min={5} max={100} value={L.opacity * 100} className="w-full accent-sky-500"
                          onChange={(e) => setGlazeLayers((ls) => ls.map((x, k) => k === i ? { ...x, opacity: Number(e.target.value) / 100 } : x))} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <p className="text-[11px] text-stone-500 max-w-xl">
                Each layer is see-through and stacks over the one below. A low-opacity layer lets the underlayer show
                through — which is exactly why a thin coat over a different base reads as a blended shadow rather than a
                flat new color. Turn pooling up and glazes thin out on the lit planes and gather in the recesses, the
                way an airbrushed glaze actually behaves.
              </p>
            </div>
          )}
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

          {/* glaze preview */}
          <div className="mt-5 pt-4 border-t border-stone-700/50 flex flex-col sm:flex-row gap-4 items-center sm:items-start">
            <div className="w-[110px] flex-none">
              <GlazePreview accent={previewAccent} ramp={ramp} L={L} tierKeys={tierKeys} regions={previewRegions} />
            </div>
            <div className="flex-1">
              <h3 className="text-xs uppercase tracking-wider text-stone-300 mb-1">Accent in the recesses</h3>
              <p className="text-[11.5px] text-stone-400 leading-relaxed max-w-md">
                {previewAccent
                  ? "This is your selected accent glazed thin into the deepest shadow zones only — the classic 'complementary in the recesses' move. A touch of the opposite hue in shadow makes the base color read richer without repainting anything."
                  : "Pin or tap an accent to see it glazed into the shadow zones here. The complementary is the one to try first: a thin wash of the opposite hue in the deepest recesses adds life that a darker version of the base color can't."}
              </p>
              <p className="text-[11px] text-stone-500 mt-2 max-w-md">
                <b className="text-stone-400">Unifying glaze:</b> a single thin wash of one hue over the <i>whole</i> model ties
                unrelated parts together — a warm tone to harmonize, a cool one to push everything back.
              </p>
            </div>
          </div>
        </Section>

        {/* ===== SAVE / LOAD ===== */}
        <Section icon={<Save size={15} />} title="Recipes" {...sec("recipes")}>
          <div className="flex flex-wrap gap-2 items-center mb-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Recipe name (e.g. Orc Flesh)"
              className="flex-1 min-w-[180px] bg-stone-900 border border-stone-700 rounded-md px-3 py-2 text-sm text-stone-200 placeholder:text-stone-600" />
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

function MiniFigure({ regions, ramp, L }) {
  return (
    <svg viewBox="0 0 200 460" className="w-full h-auto">
      {regions.map((r, i) => {
        const b = brightness(r.n, L, r.ao);
        return <polygon key={i} points={r.p} fill={ramp[tierIndex(b, ramp.length)]}
          stroke="#00000033" strokeWidth="0.6" strokeLinejoin="round" />;
      })}
    </svg>
  );
}

function Chooser({ ramp, L, onPick, onImport, customReady, importMsg, detail, onDetail }) {
  return (
    <div className="min-h-screen w-full text-stone-200 flex flex-col items-center justify-center px-4 py-10"
      style={{ background: "#141611", fontFamily: "Segoe UI, system-ui, sans-serif" }}>
      <p className="text-[11px] tracking-[0.32em] uppercase text-stone-500 mb-1">Miniature painting · light & value</p>
      <h1 className="text-3xl sm:text-4xl font-extrabold uppercase tracking-wide leading-none mb-2 text-center">
        The <span style={{ color: ramp[ramp.length - 1] }}>Light</span> Bench
      </h1>
      <p className="text-stone-400 text-sm max-w-md text-center mb-8">
        Work on the 3D study figure, or import the actual model from your bench —
        the light, recipe, and steps work the same on both.
      </p>
      <div className="grid grid-cols-2 gap-4 w-full max-w-xl">
        {Object.entries(MODELS).filter(([, m]) => !m.custom).map(([key, m]) => (
          <button key={key} onClick={() => onPick(key)}
            className="group rounded-xl border border-stone-700/70 hover:border-stone-400 bg-stone-900/30 p-4 transition-colors text-left">
            <div className="h-40 flex items-center justify-center mb-3">
              {m.views
                ? <div className="w-[88px]"><MiniFigure regions={frontOf(m.views)} ramp={ramp} L={L} /></div>
                : <div className="w-[118px]"><Model3D mesh={MESH3D[key]} L={L} ramp={ramp} mode="paint" noDrag initRot={{ yaw: -0.4, pitch: 0.08 }} /></div>}
            </div>
            <div className="text-sm font-semibold text-stone-100 group-hover:text-white">{m.label}</div>
            <div className="text-[11px] text-stone-500 leading-snug mt-0.5">{m.blurb}</div>
          </button>
        ))}
        <label className="group rounded-xl border border-dashed border-stone-600 hover:border-stone-400 bg-stone-900/30 p-4 transition-colors text-left cursor-pointer">
          <input type="file" accept=".stl,.obj" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; }} />
          <div className="h-40 flex items-center justify-center mb-3">
            {customReady
              ? <div className="w-[118px]" title="Open your imported model"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPick("custom"); }}>
                  <Model3D mesh={MESH3D.custom} L={L} ramp={ramp} mode="paint" noDrag initRot={{ yaw: -0.4, pitch: 0.08 }} />
                </div>
              : <Upload size={40} className="text-stone-500 group-hover:text-stone-300 transition-colors" />}
          </div>
          <div className="text-sm font-semibold text-stone-100 group-hover:text-white">Import your model</div>
          <div className="text-[11px] text-stone-500 leading-snug mt-0.5">
            {customReady
              ? "Click the figure to reopen it, or the card to load a different STL/OBJ."
              : "Load an STL or OBJ of the mini on your bench — it's simplified so the planes read clearly."}
          </div>
          <div className="flex items-center gap-1 mt-2" onClick={(e) => e.preventDefault()}>
            <span className="text-[10px] uppercase tracking-wider text-stone-600 mr-1">Detail</span>
            {[["Standard", 3400], ["High", 8000], ["Ultra", 14000], ["Full", 500000]].map(([lb, n]) => (
              <button key={n} type="button" onClick={(e) => { e.stopPropagation(); onDetail(n); }}
                title={n >= 100000 ? "The actual STL on the GPU — up to 500,000 triangles" : n.toLocaleString() + " faces max — more detail, but rotation gets heavier"}
                className={"px-2 py-0.5 rounded-full text-[10px] border transition-colors " +
                  (detail === n ? "border-stone-300 text-stone-100 bg-stone-700/60" : "border-stone-700 text-stone-500 hover:text-stone-300")}>
                {lb}
              </button>
            ))}
          </div>
          {importMsg && <div className="text-[11px] text-amber-400 leading-snug mt-1">{importMsg}</div>}
        </label>
      </div>
      <p className="text-[11px] text-stone-600 mt-8 max-w-md text-center">
        Color schemes and zone materials carry over when you switch between them.
      </p>
    </div>
  );
}
