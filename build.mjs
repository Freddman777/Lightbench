// Build script for The Light Bench.
// Source of truth: light-bench.jsx  ->  output: index.html (self-contained, offline).
// Run with:  npm install  &&  npm run build
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// 1. Turn the source into a browser entry: swap Claude's window.storage for a
//    localStorage shim, and mount the React app.
let src = readFileSync("light-bench.jsx", "utf8").replaceAll("window.storage", "store");
const shim = `
const store = {
  async list(p){ const keys=Object.keys(localStorage).filter(k=>k.startsWith(p)); return { keys }; },
  async get(k){ const v=localStorage.getItem(k); return v==null?null:{ value:v }; },
  async set(k,v){ localStorage.setItem(k,v); return { key:k }; },
  async delete(k){ localStorage.removeItem(k); return { key:k }; },
};
`;
src = src.replace('from "lucide-react";', 'from "lucide-react";\n' + shim);
src = 'import { createRoot } from "react-dom/client";\n' + src +
      '\ncreateRoot(document.getElementById("root")).render(React.createElement(App));\n';
writeFileSync("browser.jsx", src);

// 2. Bundle React + icons + app into one minified IIFE (no CDN, runs offline).
await build({
  entryPoints: ["browser.jsx"],
  bundle: true, minify: true, format: "iife", legalComments: "none",
  outfile: "app.js", loader: { ".jsx": "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
});

// 3. Generate only the Tailwind utilities actually used.
execSync("npx tailwindcss -i input.css -o styles.css --minify", { stdio: "inherit" });

// 4. Assemble the single self-contained index.html.
const css = readFileSync("styles.css", "utf8");
const js  = readFileSync("app.js", "utf8");
const extra = `
html,body{margin:0;background:#141611;}
body{padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);}
input[type=range]{height:4px;}
button,select,label,input{touch-action:manipulation;}
@media (pointer:coarse){input[type=range]{height:28px;}}
.controls-scroll::-webkit-scrollbar{width:8px;}
.controls-scroll::-webkit-scrollbar-thumb{background:#3a3f31;border-radius:4px;}
.controls-scroll{scrollbar-width:thin;scrollbar-color:#3a3f31 transparent;}
`;
// PWA tags: manifest + icons for install, theme color for the title bar. The
// service-worker registration is guarded so a double-clicked file:// copy is
// unaffected — PWA install only activates when hosted over http(s).
const pwa = `<meta name="description" content="The Light Bench — a miniature-painting light, value and layering planner. One light, one figure: move the light, build a recipe, walk the steps.">` +
  `<link rel="icon" type="image/svg+xml" href="icons/icon.svg">` +
  `<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">` +
  `<link rel="manifest" href="manifest.json">` +
  `<meta name="theme-color" content="#141611">` +
  `<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">` +
  `<meta name="mobile-web-app-capable" content="yes">` +
  `<meta name="apple-mobile-web-app-capable" content="yes">` +
  `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` +
  `<meta name="apple-mobile-web-app-title" content="Light Bench">`;
// SW registration + update flow: the new worker auto-activates (skipWaiting/claim in
// sw.js), so when it takes control mid-session we offer a one-tap reload. No toast on
// the very first install (no prior controller). reg.update() runs whenever the tab
// becomes visible again — installed PWAs keep pages alive for days.
const swReg = `<script>
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  addEventListener("load", () => {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then((reg) => {
      document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) { hadController = true; return; }
      if (document.getElementById("lb-upd")) return;
      const b = document.createElement("button");
      b.id = "lb-upd";
      b.textContent = "Updated — tap to reload";
      b.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom));z-index:9999;background:#1d201a;color:#d6e3b8;border:1px solid #5a6547;border-radius:9999px;padding:10px 18px;font:600 11px 'Segoe UI',system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5)";
      b.onclick = () => location.reload();
      document.body.appendChild(b);
    });
  });
}
</script>`.replace(/\n\s*/g, "");
const html0 = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">` +
  `<title>The Light Bench — Miniature Painting Tool</title>` +
  pwa +
  `<script>window.LB_VERSION="__LBVER__"</script>` +
  `<style>${css}${extra}</style></head><body><div id="root"></div><script>${js}</script>${swReg}</body></html>`;

// 5. Build version: one short hash stamped into the page (window.LB_VERSION, shown in
//    the app footer) AND used as the SW cache name, so "which build am I running?" and
//    "which cache is this?" always agree. Hash is taken over the placeholder form to
//    avoid the circular dependency of hashing the stamped output.
const ver = createHash("sha256").update(html0).digest("hex").slice(0, 8);
const html = html0.replaceAll("__LBVER__", ver);
writeFileSync("index.html", html);
const sw = `const CACHE="lightbench-${ver}";
const ASSETS=["./","./index.html","./manifest.json","./icons/icon.svg","./icons/icon-192.png","./icons/icon-512.png","./icons/maskable-192.png","./icons/maskable-512.png","./icons/apple-touch-icon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  if(new URL(e.request.url).origin!==location.origin)return;
  e.respondWith(caches.open(CACHE).then(async c=>{
    const hit=await c.match(e.request,{ignoreSearch:true});
    const fetched=fetch(e.request).then(res=>{if(res.ok)c.put(e.request,res.clone());return res}).catch(()=>hit);
    return hit||fetched;
  }));
});
`;
writeFileSync("sw.js", sw);
console.log("Built index.html (" + html.length + " bytes), sw.js (cache lightbench-" + ver + ")");
