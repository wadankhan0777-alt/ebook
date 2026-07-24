/* Folio service worker — makes the app work offline.
 * App shell: stale-while-revalidate. Covers/images: cache-first.
 * Book texts live in IndexedDB (managed by the app), not here. */

const CACHE = "folio-v1";
const SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/vendor/fflate.js",
  "js/api.js",
  "js/store.js",
  "js/import.js",
  "js/narrator.js",
  "js/reader.js",
  "js/app.js",
  "manifest.webmanifest",
  "icon.svg",
];

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
    // shell: serve cached instantly, refresh in the background
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

  if (req.destination === "image") {
    // book covers: cache-first so shelves render offline
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
