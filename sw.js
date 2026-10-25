// HAWK's service worker: lets the site install as an app and open fast.
// Network first for everything of HAWK's own, so a new version (or new data)
// shows straight away; the last copy is used only when there's no connection.
// Requests to other sites (365Scores, Polymarket, …) are left alone.
// v6: the two v1 pages are gone — builder/index.html and vault-v1.html — so an
// installed copy has to drop a shell that still holds them. addAll is atomic:
// one 404 in the list and NOTHING precaches, which the catch below would have
// swallowed silently, leaving an app that works online and not off it.
//
// builder/engine.js and builder/hawk-settle.js stay, and are not v1 leftovers:
// they are the model and the settler, and every rebuilt page loads them.
const CACHE = "hawk-v6";
const SHELL = ["./", "./index.html", "./builder/engine.js", "./builder/hawk-settle.js",
               "./hawk-logo.svg", "./icon.svg", "./favicon.svg", "./qr.js", "./manifest.webmanifest",
               // the rebuilt pages and the sheet and scripts they all share
               "./home/", "./today/", "./scores/", "./match/", "./live/", "./acca/", "./board/", "./vault/",
               "./assets/hawk.css", "./assets/hawk-nav.js", "./assets/hawk-bg.js", "./assets/hawk-fold.js",
               "./assets/hawk-alerts.js", "./assets/hawk-acca.js", "./assets/hawk-lineups.js"];

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
  // Home, not ./builder/ — that was the front door until the rebuild, and with
  // builder/index.html deleted a notification with no url of its own would have
  // opened a 404.
  const url = (e.notification.data && e.notification.data.url) || new URL("./home/", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    // Any HAWK window takes itself to the match — assets/hawk-alerts.js listens
    // for this message on every page. It used to prefer a /builder/ window
    // because the old builder listened too; there is no such window now.
    const hawk = list.find((c) => c.url.startsWith(self.registration.scope));
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
    // Offline, and this page is not in the cache. Serving some OTHER page's
    // HTML at this URL is worse than useless: every page here is one folder
    // deep and references "../assets/…", so a page served at the wrong depth
    // loads none of its own files. Redirect instead — the browser then asks
    // for /home/, which IS cached, and its relative paths resolve.
    .then((hit) => {
      if (hit) return hit;
      if (req.mode !== "navigate") return Response.error();
      const home = new URL("./home/", self.registration.scope).href;
      // Never redirect home to itself: offline on a first visit, with nothing
      // cached, that is an infinite loop rather than an error page.
      if (url.href.split("?")[0] === home) return Response.error();
      return Response.redirect(home, 302);
    })));
});
