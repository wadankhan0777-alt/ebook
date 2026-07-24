/* Folio service worker — makes the app work offline.
 * App shell: stale-while-revalidate. Covers/images: cache-first.
 * Book texts live in IndexedDB (managed by the app), not here. */

const CACHE = "folio-v3";
const SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/vendor/fflate.js",
  "js/vendor/kokoro.web.js",
  "js/vendor/ort-wasm-simd-threaded.jsep.mjs",
  "js/api.js",
  "js/store.js",
  "js/import.js",
  "js/narrator.js",
  "js/music.js",
  "js/reader.js",
  "js/app.js",
  "manifest.webmanifest",
  "icon.svg",
];
// (the 21 MB ONNX wasm binary is runtime-cached on first neural use)

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (req.mode === "navigate") {
      // the page itself: network-first, so updates always arrive;
      // cached copy only when offline
      e.respondWith(
        fetch(req)
          .then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
            return res;
          })
          .catch(() => caches.match(req).then((c) => c || caches.match("index.html")))
      );
      return;
    }
    // static assets: serve cached instantly, refresh in the background
    e.respondWith(
      caches.match(req).then((cached) => {
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
            return res;
          })
          .catch(() => cached);
        return cached || refresh;
      })
    );
    return;
  }

  if (url.hostname === "cdn.jsdelivr.net" || req.destination === "image") {
    // AI-voice library + book covers: cache-first so they work offline
    e.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
            return res;
          })
      )
    );
  }
  // everything else (catalog API, book texts): straight to network
});
