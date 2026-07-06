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
input[type=range]{height:4px;}
.controls-scroll::-webkit-scrollbar{width:8px;}
.controls-scroll::-webkit-scrollbar-thumb{background:#3a3f31;border-radius:4px;}
.controls-scroll{scrollbar-width:thin;scrollbar-color:#3a3f31 transparent;}
`;
// PWA tags: manifest + icons for install, theme color for the title bar. The
// service-worker registration is guarded so a double-clicked file:// copy is
// unaffected — PWA install only activates when hosted over http(s).
const pwa = `<link rel="manifest" href="manifest.json">` +
  `<meta name="theme-color" content="#141611">` +
  `<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">` +
  `<meta name="mobile-web-app-capable" content="yes">` +
  `<meta name="apple-mobile-web-app-capable" content="yes">` +
  `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` +
  `<meta name="apple-mobile-web-app-title" content="Light Bench">`;
const swReg = `<script>if("serviceWorker"in navigator&&/^https?:$/.test(location.protocol)){addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}))}</script>`;
const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
  `<title>The Light Bench — Miniature Painting Tool</title>` +
  pwa +
  `<style>${css}${extra}</style></head><body><div id="root"></div><script>${js}</script>${swReg}</body></html>`;
writeFileSync("index.html", html);

// 5. Service worker: precache everything, stale-while-revalidate on fetch.
//    Cache name carries a hash of the built HTML so each rebuild ships a new
//    cache and old ones are dropped on activate.
const ver = createHash("sha256").update(html).digest("hex").slice(0, 10);
const sw = `const CACHE="lightbench-${ver}";
const ASSETS=["./","./index.html","./manifest.json","./icons/icon-192.png","./icons/icon-512.png","./icons/maskable-192.png","./icons/maskable-512.png","./icons/apple-touch-icon.png"];
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
