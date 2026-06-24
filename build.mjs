// Build script for The Light Bench.
// Source of truth: light-bench.jsx  ->  output: index.html (self-contained, offline).
// Run with:  npm install  &&  npm run build
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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
  bundle: true, minify: true, format: "iife",
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
const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
  `<title>The Light Bench — Miniature Painting Tool</title>` +
  `<style>${css}${extra}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
writeFileSync("index.html", html);
console.log("Built index.html (" + html.length + " bytes)");
