// Persists loaded road-tile data (real segments + signals — NOT the
// per-race-random hazards/nitros) across races and page reloads, keyed by
// absolute tile coordinates (not local race-relative meters, so a tile
// fetched during one race is reusable the next time any race touches that
// same real-world area). Cuts down on repeat Overpass load, which is the
// single biggest source of flakiness in this app (see geo.js's mirror queue).

const CACHE_KEY = "earthrace.tileCache";
const MAX_TILES = 400; // rough cap so localStorage doesn't grow unbounded

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota exceeded or storage disabled — caching is a nice-to-have, not
    // required for correctness, so just skip persisting this time.
  }
}

export function getCachedTile(globalKey) {
  return loadCache()[globalKey] || null;
}

export function setCachedTile(globalKey, data) {
  const cache = loadCache();
  cache[globalKey] = { ...data, savedAt: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > MAX_TILES) {
    keys.sort((a, b) => cache[a].savedAt - cache[b].savedAt);
    for (let i = 0; i < keys.length - MAX_TILES; i++) delete cache[keys[i]];
  }
  saveCache(cache);
}
