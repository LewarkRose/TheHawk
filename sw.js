// HAWK's service worker: lets the site install as an app and open fast.
// Network first for everything of HAWK's own, so a new version (or new data)
// shows straight away; the last copy is used only when there's no connection.
// Requests to other sites (365Scores, Polymarket, …) are left alone.
const CACHE = "hawk-v2";
const SHELL = ["./", "./index.html", "./builder/", "./builder/index.html", "./builder/engine.js", "./builder/hawk-settle.js",
               "./hawk-logo.svg", "./builder/hawk-logo.svg", "./icon.svg", "./favicon.svg", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => { /* first visit offline: fine */ }));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Tapping a HAWK notification (a goal, a lineup): back to HAWK at that match —
// the open HAWK window if there is one, otherwise a new one.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || new URL("./builder/", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const hawk = list.find((c) => c.url.includes("/builder/"));
    if (hawk) { hawk.postMessage({ open: url }); return hawk.focus(); }
    return self.clients.openWindow(url);
  }));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then((hit) => hit || (req.mode === "navigate" ? caches.match("./builder/index.html") : Response.error()))));
});
