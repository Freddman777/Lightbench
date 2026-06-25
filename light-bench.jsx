import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Sun, Save, Trash2, RotateCcw, Plus, Check, Lightbulb, Layers, Palette, Download, Droplets } from "lucide-react";

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
function mix(hexA, hexB, t) {
  const a = hexA.replace("#", ""), b = hexB.replace("#", "");
  const ai = [0, 2, 4].map((i) => parseInt(a.slice(i, i + 2), 16));
  const bi = [0, 2, 4].map((i) => parseInt(b.slice(i, i + 2), 16));
  const m = ai.map((v, i) => Math.round(v + (bi[i] - v) * t));
  return "#" + m.map((v) => clamp(v, 0, 255).toString(16).padStart(2, "0")).join("");
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
  return m[n].map(([key, label]) => ({ key, label }));
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
  { p: "90,86 110,86 108,102 92,102", n: [0, 0.1, 0.99] },
  { p: "62,104 138,104 142,118 58,118", n: [0, 0.82, 0.45] },
  { p: "46,116 62,114 64,150 50,152", n: [-0.85, 0.2, 0.3] },
  { p: "154,116 138,114 136,150 150,152", n: [0.85, 0.2, 0.3] },
  { p: "64,120 136,120 134,138 66,138", n: [0, 0.5, 0.85] },
  { p: "66,138 134,138 130,176 70,176", n: [0, 0.02, 1] },
  { p: "72,176 128,176 124,236 76,236", n: [0, 0.04, 1] },
  { p: "46,152 64,152 62,250 50,250", n: [-0.8, 0, 0.55] },
  { p: "154,152 136,152 138,250 150,250", n: [0.8, 0, 0.55] },
  { p: "76,236 124,236 122,262 78,262", n: [0, 0.05, 1] },
  { p: "78,260 99,260 99,272 80,272", n: [0, 0.6, 0.78] },
  { p: "101,260 122,260 120,272 101,272", n: [0, 0.6, 0.78] },
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
  { p: "90,86 110,86 108,102 92,102", n: [0, 0.1, -0.99] },
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
  { p: "90,82 108,82 106,102 92,102", n: [0.9, 0.1, 0] },
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
const RIGHT = LEFT.map((r) => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], r.n[2]] }));

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
  { p: "86,150 114,150 112,178 88,178", n: [0, 0.1, 0.99] },
  { p: "50,180 150,180 156,200 44,200", n: [0, 0.82, 0.45] },
  { p: "30,196 50,194 52,250 36,254", n: [-0.85, 0.2, 0.3] },
  { p: "170,196 150,194 148,250 164,254", n: [0.85, 0.2, 0.3] },
  { p: "52,204 148,204 146,228 54,228", n: [0, 0.5, 0.85] },
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
  { p: "86,150 114,150 112,178 88,178", n: [0, 0.1, -0.99] },
  { p: "50,180 150,180 156,200 44,200", n: [0, 0.7, -0.5] },
  { p: "30,196 50,194 52,250 36,254", n: [-0.85, 0.2, -0.3] },
  { p: "170,196 150,194 148,250 164,254", n: [0.85, 0.2, -0.3] },
  { p: "52,204 148,204 146,228 54,228", n: [0, 0.3, -0.9] },
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
  { p: "88,144 112,144 110,178 90,178", n: [0.9, 0.1, 0] },
  { p: "70,180 134,180 138,202 66,202", n: [0.2, 0.85, 0] },
  { p: "66,206 86,206 84,300 70,294", n: [0.4, 0.1, 0.78] },
  { p: "86,204 132,206 130,300 84,300", n: [0.95, 0.05, 0] },
  { p: "130,210 140,220 136,300 130,300", n: [0.45, 0.05, -0.78] },
  { p: "72,300 132,300 128,344 76,344", n: [0.9, 0.05, 0] },
  { p: "66,346 140,346 138,358 68,358", n: [0.2, 0.65, 0.1] },
  { p: "68,358 140,358 148,404 60,404", n: [0.9, 0.06, 0] },
];
const BUST_RIGHT = BUST_LEFT.map((r) => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], r.n[2]] }));
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
  { p: "90,86 110,86 108,102 92,102", n: [0, 0.1, 0.99] },
  { p: "62,104 138,104 142,118 58,118", n: [0, 0.82, 0.45] },
  { p: "64,118 136,118 134,150 66,150", n: [0, 0.3, 0.95] },
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
  { p: "84,184 102,182 104,200 86,202", n: [0, 0.2, 0.9] },
  { p: "122,182 142,178 144,194 124,196", n: [0, 0.4, 0.85] },
];
const GUN_BACK = [
  { p: "78,22 100,14 122,22 120,38 80,38", n: [0, 0.75, -0.66] },
  { p: "78,38 90,38 90,86 80,80", n: [-0.55, 0.05, -0.83] },
  { p: "122,38 110,38 110,86 120,80", n: [0.55, 0.05, -0.83] },
  { p: "90,38 110,38 110,86 90,86", n: [0, 0, -1] },
  { p: "90,86 110,86 108,102 92,102", n: [0, 0.1, -0.99] },
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
  { p: "90,82 108,82 106,102 92,102", n: [0.9, 0.1, 0] },
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
const GUN_RIGHT = GUN_LEFT.map((r) => ({ p: mirrorPoly(r.p), n: [-r.n[0], r.n[1], r.n[2]] }));
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
  bust: { label: "Bust", blurb: "Head & shoulders — what you're most likely painting.", views: BUST },
  standing: { label: "Standing figure", blurb: "Full body — broad planes, full-length light.", views: STANDING },
  gun: { label: "Rifle stance", blurb: "Arms raised, rifle held at an angle — asymmetry, foreshortening, and angled planes.", views: GUN },
  dual: { label: "Dual wield", blurb: "Arms thrown out — pistol raised high, blade out. Extended limbs and two held items at different angles.", views: DUAL },
};
const frontOf = (views) => views.find((v) => v.key === "front").regions;

/* ============================== LIGHTING ============================== */
function lightVector(azDeg, elDeg) {
  const a = (azDeg * Math.PI) / 180, e = (elDeg * Math.PI) / 180;
  const ce = Math.cos(e);
  return [ce * Math.sin(a), Math.sin(e), ce * Math.cos(a)];
}
function brightness(normal, L) {
  const d = normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2];
  return 0.05 + 0.95 * smoothstep(-0.3, 1, d); // ambient floor + directional
}
// How much spray lands on a plane. L is the nozzle aim; focus 0=wide/feathered, 1=tight.
// No ambient floor: planes facing away from the nozzle get NO paint (stay bare) — the
// core airbrush lesson the soft light model hides.
function sprayCoverage(normal, L, focus) {
  const d = normal[0] * L[0] + normal[1] * L[1] + normal[2] * L[2];
  const edge = -0.15 + focus * 0.85; // wide cone reaches angled planes; tight cone only near-facing ones
  const soft = 0.6 - focus * 0.48;   // wide = gentle feathered falloff; tight = hard edge
  return smoothstep(edge, edge + soft, d);
}
function tierIndex(b, n) { return clamp(Math.floor(b * n), 0, n - 1); }

/* ============================== SEQUENCER ============================== */
function buildStages(n, method = "brush") {
  const air = method === "airbrush";
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
    { id: "base", name: "Base coat", mode: "paint", iso: "base",
      note: air
        ? "Thin the base to milk and lay angled passes from slightly above, letting the zenithal value glow through."
        : "Lay the midtone over everything, thin enough to let the zenithal value show through.",
      watch: air
        ? "Paint too thick or pressure too high goes chalky and buries the zenithal. Thin it more and build more passes."
        : "Opaque here buries the zenithal. If you go solid, you've signed up to rebuild all the shading by hand." },
    { id: "shade", name: "Shade", mode: "paint", iso: "shadow",
      note: air
        ? "Drop the spray angle: thinned shadow color low and from the side, so the cone only catches the undersides and recesses."
        : "Push your shadow color into the recesses only — the regions lit here are where it belongs.",
      watch: air
        ? "Spray straight-on and shadow lands everywhere. Lower the angle so the raised planes stay clean."
        : "Keep it in the valleys. Shadow creeping onto raised planes flattens the whole figure." },
  ];
  if (has("mid")) s.push({ id: "mid", name: "Midtone highlight", mode: "paint", iso: "mid",
    note: air
      ? "Raise the angle back toward overhead so only the broad upper faces catch the pass."
      : "First highlight on the broad raised faces, pulled back off the recesses.",
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
function FigureView({ label, regions, L, ramp, mode, isoTier, tierKeys, glazeOn, glazeLayers, pooling, viewBox = "0 0 200 460", svgExtra = "", sprayOn = false, focus = 0.5, sprayColor = "#cfe3ef" }) {
  return (
    <div className="flex flex-col items-center min-w-0">
      <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" className={"w-full h-auto " + svgExtra}>
        {regions.map((r, i) => {
          const b = brightness(r.n, L);
          const idx = tierIndex(b, ramp.length);
          let fill;
          let dim = isoTier != null && tierKeys[idx] !== isoTier;
          if (sprayOn) {
            const cov = sprayCoverage(r.n, L, focus);
            fill = mix("#33322d", sprayColor, cov); // bare primer -> paint by coverage
            dim = false;
          } else if (mode === "prime") fill = "#1b1b1b";
          else if (mode === "zenithal") fill = valueGrey(b);
          else if (glazeOn) fill = glazeColor(b, glazeLayers, pooling);
          else fill = ramp[idx];
          return (
            <polygon key={i} points={r.p} fill={fill}
              opacity={dim ? 0.12 : 1}
              stroke="#00000033" strokeWidth="0.6" strokeLinejoin="round" />
          );
        })}
      </svg>
      <div className="mt-1 text-[10px] tracking-[0.25em] uppercase text-stone-400">{label}</div>
    </div>
  );
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
            <circle key={i} cx={points[i][0]} cy={points[i][1]} r="8" fill={c} stroke="#fff" strokeWidth="1.5" />
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
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-white" /> ramp
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
        const b = brightness(r.n, L);
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
  const [activeStage, setActiveStage] = useState("zenithal");
  const [done, setDone] = useState({});
  const [recipes, setRecipes] = useState([]);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [model, setModel] = useState(null); // null = chooser screen
  const [glazeOn, setGlazeOn] = useState(false);
  const [method, setMethod] = useState("brush");
  const [spray, setSpray] = useState(false);
  const [focus, setFocus] = useState(0.5);
  const [pooling, setPooling] = useState(0.6);
  const [glazeLayers, setGlazeLayers] = useState(() => defaultGlaze(generateRamp("#5f8a4a", 5), 3));

  const L = useMemo(() => lightVector(az, el), [az, el]);
  const tiers = useMemo(() => tierMeta(numSteps), [numSteps]);
  const tierKeys = tiers.map((t) => t.key);
  const stages = useMemo(() => buildStages(numSteps, method), [numSteps, method]);
  const stage = stages.find((s) => s.id === activeStage) || stages[0];
  const sprayActive = spray && method === "airbrush";
  const sprayColor = useMemo(() => {
    const k = stage && stage.iso;
    if (k) { const i = tierKeys.indexOf(k); if (i >= 0) return ramp[i]; }
    return ramp[ramp.length - 1];
  }, [stage, tierKeys, ramp]);
  const views = model ? MODELS[model].views : MODELS.bust.views;
  const previewRegions = frontOf(views);

  // regenerate ramp when base or count changes
  useEffect(() => { setRamp(generateRamp(base, numSteps)); }, [base, numSteps]);

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

  const save = async () => {
    const nm = name.trim(); if (!nm) { setStatus("Name it first."); return; }
    const recipe = { base, numSteps, ramp, accents, az, el, done, glazeOn, pooling, glazeLayers, method, spray, focus };
    if (!window.storage) { setStatus("Storage unavailable in preview."); return; }
    try { await window.storage.set("recipe:" + nm, JSON.stringify(recipe)); setStatus("Saved “" + nm + "”."); refreshList(); }
    catch { setStatus("Save failed."); }
  };
  const load = async (nm) => {
    if (!window.storage) return;
    try {
      const res = await window.storage.get("recipe:" + nm); if (!res) return;
      const r = JSON.parse(res.value);
      setBase(r.base); setNumSteps(r.numSteps); setRamp(r.ramp);
      setAccents(r.accents || []); setAz(r.az); setEl(r.el); setDone(r.done || {}); setPreviewAccent(null);
      setGlazeOn(!!r.glazeOn); setPooling(typeof r.pooling === "number" ? r.pooling : 0.6);
      setMethod(r.method === "airbrush" ? "airbrush" : "brush");
      setSpray(!!r.spray); setFocus(typeof r.focus === "number" ? r.focus : 0.5);
      setGlazeLayers(Array.isArray(r.glazeLayers) && r.glazeLayers.length ? r.glazeLayers : defaultGlaze(r.ramp, 3));
      setName(nm); setStatus("Loaded “" + nm + "”.");
    } catch { setStatus("Load failed."); }
  };
  const del = async (nm) => {
    if (!window.storage) return;
    try { await window.storage.delete("recipe:" + nm); refreshList(); setStatus("Deleted “" + nm + "”."); } catch {}
  };

  // light compass dot
  const cx = 26 + 18 * Math.sin((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180);
  const cy = 26 - 18 * Math.cos((az * Math.PI) / 180) * Math.cos((el * Math.PI) / 180);

  if (!model) return <Chooser ramp={ramp} L={L} onPick={setModel} />;

  return (
    <div className="min-h-screen w-full text-stone-200 lg:h-screen lg:overflow-hidden flex flex-col"
      style={{ background: "#141611", fontFamily: "Segoe UI, system-ui, sans-serif" }}>
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
            <button onClick={() => setModel(null)}
              className="text-[11px] text-stone-400 hover:text-stone-200 border border-stone-700 hover:border-stone-500 rounded-full px-3 py-1.5">
              Model: <span className="text-stone-200">{MODELS[model].label}</span> · change
            </button>
          </div>
        </div>
        <p className="text-stone-400 text-[13px] max-w-2xl">
          One light, one figure, four views. Move the light and watch where each value lands. Build a recipe,
          check it on the wheel, then walk the steps.
        </p>
      </div>

      <div className="max-w-6xl w-full mx-auto px-4 pb-4 flex-1 min-h-0 flex flex-col lg:flex-row gap-5 items-start">
          {/* ===== MODEL PANE (fits to viewport height) ===== */}
          <div className="w-full lg:w-[36%] lg:flex-none lg:h-full lg:overflow-y-auto controls-scroll lg:pr-1">
            <div className="rounded-xl border border-stone-700/60 p-3"
              style={{ background: "radial-gradient(120% 90% at 50% 0%, #20241b, #141611 75%)" }}>
              <div className="grid grid-cols-2 gap-2">
                {views.filter((v) => v.key !== "top").map((v) => (
                  <FigureView key={v.key} label={v.label} regions={v.regions} L={L} ramp={ramp}
                    mode={stage.mode} isoTier={stage.iso} tierKeys={tierKeys}
                    glazeOn={glazeOn} glazeLayers={glazeLayers} pooling={pooling}
                    sprayOn={sprayActive} focus={focus} sprayColor={sprayColor}
                    svgExtra="lg:max-h-[27vh]" />
                ))}
              </div>
              {views.find((v) => v.key === "top") && (
                <div className="mt-2 pt-2 border-t border-stone-700/40">
                  <div className="mx-auto" style={{ width: "70%" }}>
                    <FigureView label="Top (from above)" regions={views.find((v) => v.key === "top").regions}
                      viewBox="0 0 220 150" L={L} ramp={ramp}
                      mode={stage.mode} isoTier={stage.iso} tierKeys={tierKeys}
                      glazeOn={glazeOn} glazeLayers={glazeLayers} pooling={pooling}
                      sprayOn={sprayActive} focus={focus} sprayColor={sprayColor}
                      svgExtra="lg:max-h-[15vh]" />
                  </div>
                </div>
              )}
              <div className="mt-3 pt-3 border-t border-stone-700/50 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.2em] text-stone-500">Showing</span>
                <span className="text-xs text-stone-300 font-medium">
                  {sprayActive ? <span className="text-sky-300">Spray coverage · {stage.name}</span>
                    : <>{stage.name}{glazeOn && (stage.mode === "paint") ? <span className="text-sky-300"> · glaze</span> : null}</>}
                </span>
              </div>
            </div>
          </div>

          {/* ===== CONTROLS PANE (scrolls internally on desktop) ===== */}
          <div className="flex-1 w-full min-w-0 lg:h-full lg:overflow-y-auto lg:pr-2 controls-scroll">

        {/* ===== LIGHT CONTROLS ===== */}
        <Section icon={<Sun size={15} />} title="Light direction">
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

        {method === "airbrush" && (
        <Section icon={<Droplets size={15} />} title="Spray cone">
          <p className="text-[11px] text-stone-500 mb-3 leading-snug">
            Your light direction <span className="text-stone-300">is the nozzle</span>. Turn this on to see where paint
            actually lands — planes angled toward the nozzle get coated, planes facing away stay bare primer. Aim with
            Orbit / Height above.
          </p>
          <div className="flex items-center gap-3 mb-1">
            <button onClick={() => setSpray((v) => !v)}
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

        {/* ===== RECIPE BUILDER ===== */}
        <Section icon={<Palette size={15} />} title="Recipe">
          <div className="flex flex-wrap items-center gap-4 mb-4">
            <label className="flex items-center gap-2 text-sm text-stone-300">
              Base color
              <input type="color" value={base} onChange={(e) => setBase(e.target.value)}
                className="w-9 h-9 rounded cursor-pointer bg-transparent border border-stone-700" />
            </label>
            <div className="flex items-center gap-1 text-sm text-stone-300">
              Steps
              {[3, 4, 5].map((n) => (
                <button key={n} onClick={() => setNumSteps(n)}
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
                  <input type="color" value={c} onChange={(e) => editStep(i, e.target.value)} className="sr-only" />
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

        {/* ===== GLAZE ===== */}
        <Section icon={<Droplets size={15} />} title="Paint behavior">
          <div className="flex items-center gap-3 mb-1">
            <button onClick={() => setGlazeOn((v) => !v)}
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
                      <button key={n} onClick={() => setGlazeLayers(defaultGlaze(ramp, n))}
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
                        <input type="color" value={L.color} className="sr-only"
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
        <Section icon={<Lightbulb size={15} />} title="Wheel & cohesion">
          <div className="flex flex-col sm:flex-row gap-6 items-start">
            <ColorWheel ramp={ramp} accents={accents} base={base} onPickBase={setBase}
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
                        <button onClick={() => setPreviewAccent(c)} title="preview in recesses"
                          className={"w-7 h-7 rounded-md border " + (c === previewAccent ? "border-yellow-400 ring-2 ring-yellow-400/40" : "border-stone-600")}
                          style={{ background: c }} />
                        <button onClick={() => { setAccents((a) => a.filter((_, k) => k !== i)); if (c === previewAccent) setPreviewAccent(null); }}
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

        {/* ===== SEQUENCER ===== */}
        <Section icon={<Layers size={15} />} title="Steps">
          <p className="text-[11px] text-stone-500 mb-3">{method === "airbrush"
            ? "Airbrush passes in order — pressure, thinning, and spray angle per step. Tap one to isolate where it lands."
            : "Brush steps in order. Tap one to isolate where it goes on the figure above."}</p>
          <div className="space-y-1.5">
            {stages.map((s, i) => {
              const active = s.id === activeStage;
              return (
                <div key={s.id}
                  className={"rounded-lg border transition-colors " + (active ? "border-stone-400 bg-stone-800/40" : "border-stone-700/50")}>
                  <button onClick={() => setActiveStage(s.id)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left">
                    <span onClick={(e) => { e.stopPropagation(); setDone((d) => ({ ...d, [s.id]: !d[s.id] })); }}
                      className={"w-5 h-5 rounded flex-none flex items-center justify-center border " +
                        (done[s.id] ? "bg-green-600 border-green-600" : "border-stone-600")}>
                      {done[s.id] && <Check size={13} />}
                    </span>
                    <span className="text-[10px] tabular-nums text-stone-500 w-4">{i + 1}</span>
                    <span className={"text-sm font-medium " + (done[s.id] ? "line-through text-stone-500" : "text-stone-100")}>{s.name}</span>
                  </button>
                  {active && (
                    <div className="px-3 pb-3 pl-12 space-y-1.5">
                      <p className="text-xs text-stone-300 leading-snug">{s.note}</p>
                      <p className="text-[11px] text-amber-300/80 leading-snug"><b className="text-amber-300">Watch for:</b> {s.watch}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        {/* ===== SAVE / LOAD ===== */}
        <Section icon={<Save size={15} />} title="Recipes">
          <div className="flex flex-wrap gap-2 items-center mb-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Recipe name (e.g. Orc Flesh)"
              className="flex-1 min-w-[180px] bg-stone-900 border border-stone-700 rounded-md px-3 py-2 text-sm text-stone-200 placeholder:text-stone-600" />
            <button onClick={save} className="flex items-center gap-1.5 px-4 py-2 rounded-md text-sm bg-stone-200 text-stone-900 font-medium hover:bg-white">
              <Save size={14} /> Save
            </button>
          </div>
          {status && <p className="text-[11px] text-stone-500 mb-2">{status}</p>}
          <div className="flex flex-wrap gap-2">
            {recipes.length === 0 && <span className="text-[11px] text-stone-600">No saved recipes yet.</span>}
            {recipes.map((nm) => (
              <div key={nm} className="flex items-center gap-2 border border-stone-700 rounded-full pl-3 pr-1.5 py-1">
                <button onClick={() => load(nm)} className="text-xs text-stone-300 hover:text-white">{nm}</button>
                <button onClick={() => del(nm)} className="text-stone-600 hover:text-red-400"><Trash2 size={12} /></button>
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

function Section({ icon, title, children }) {
  return (
    <section className="rounded-xl border border-stone-700/60 bg-stone-900/30 p-4 mb-5">
      <h2 className="flex items-center gap-2 text-xs tracking-[0.22em] uppercase text-stone-400 mb-4">{icon}{title}</h2>
      {children}
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
        const b = brightness(r.n, L);
        return <polygon key={i} points={r.p} fill={ramp[tierIndex(b, ramp.length)]}
          stroke="#00000033" strokeWidth="0.6" strokeLinejoin="round" />;
      })}
    </svg>
  );
}

function Chooser({ ramp, L, onPick }) {
  return (
    <div className="min-h-screen w-full text-stone-200 flex flex-col items-center justify-center px-4 py-10"
      style={{ background: "#141611", fontFamily: "Segoe UI, system-ui, sans-serif" }}>
      <p className="text-[11px] tracking-[0.32em] uppercase text-stone-500 mb-1">Miniature painting · light & value</p>
      <h1 className="text-3xl sm:text-4xl font-extrabold uppercase tracking-wide leading-none mb-2 text-center">
        The <span style={{ color: ramp[ramp.length - 1] }}>Light</span> Bench
      </h1>
      <p className="text-stone-400 text-sm max-w-md text-center mb-8">
        Pick a model to work on. The light, recipe, and steps work the same on any of them —
        a color scheme you build carries across models.
      </p>
      <div className="grid grid-cols-2 gap-4 w-full max-w-xl">
        {Object.entries(MODELS).map(([key, m]) => (
          <button key={key} onClick={() => onPick(key)}
            className="group rounded-xl border border-stone-700/70 hover:border-stone-400 bg-stone-900/30 p-4 transition-colors text-left">
            <div className="h-40 flex items-center justify-center mb-3">
              <div className="w-[88px]"><MiniFigure regions={frontOf(m.views)} ramp={ramp} L={L} /></div>
            </div>
            <div className="text-sm font-semibold text-stone-100 group-hover:text-white">{m.label}</div>
            <div className="text-[11px] text-stone-500 leading-snug mt-0.5">{m.blurb}</div>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-stone-600 mt-8 max-w-md text-center">
        Each pose works the same — the light, recipe, and steps don't care which you pick. A fully posable figure is the planned next step.
      </p>
    </div>
  );
}
