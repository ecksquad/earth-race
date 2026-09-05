// Caches the app shell (HTML/JS/assets) so the game still *loads* offline or
// on a flaky connection — it deliberately does NOT try to fake offline
// gameplay: road tiles (Overpass), satellite imagery (Esri), and multiplayer
// (Firebase) all need to be genuinely live to be useful, so those are never
// intercepted here, only same-origin shell files.

const CACHE_NAME = "earthrace-shell-v3";
const SHELL_FILES = [
  "./",
  "index.html",
  "manifest.json",
  "js/main.js", "js/picker.js", "js/drive.js", "js/car.js", "js/bots.js",
  "js/roads.js", "js/geo.js", "js/storage.js", "js/collectables.js",
  "js/collectablesUI.js", "js/achievements.js", "js/garageUI.js", "js/statsUI.js",
  "js/audio.js", "js/multiplayer.js", "js/firebaseConfig.js", "js/ghostCode.js",
  "js/basemap.js", "js/tileCache.js", "js/grandprix.js",
  "assets/car-top.png", "assets/engine-idle.mp3", "assets/horn.mp3",
  "assets/icon-192.png", "assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let Overpass/Firebase/Esri requests pass through untouched

  // Network-first for the app's own code/HTML, so a shipped update is
  // visible the moment you're back online — the cache here is purely an
  // offline fallback, never a "prefer the old version" strategy (an earlier
  // cache-first version of this file kept serving stale JS after deploys
  // until a page fully reloaded past the old service worker). Large static
  // binary assets (sprite/audio/icons) are the one exception: those don't
  // change without a full redeploy, so cache-first for those is free
  // performance, not staleness risk.
  const isStaticAsset = url.pathname.includes("/assets/");
  event.respondWith(
    isStaticAsset
      ? caches.match(event.request).then((cached) => cached || fetch(event.request))
      : fetch(event.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            return res;
          })
          .catch(() => caches.match(event.request))
  );
});
