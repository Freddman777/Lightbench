const CACHE="lightbench-d5b3580b";
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
