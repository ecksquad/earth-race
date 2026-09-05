// Local-only race history (v1 leaderboard is just "beat your own best").

const KEY = "earthrace.races";
const MATCH_TOLERANCE_DEG = 0.0006; // ~ within ~65m, treats it as "the same race"

function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

function saveAll(races) {
  localStorage.setItem(KEY, JSON.stringify(races));
}

function sameRace(a, startLat, startLng, endLat, endLng) {
  return Math.abs(a.startLat - startLat) < MATCH_TOLERANCE_DEG &&
    Math.abs(a.startLng - startLng) < MATCH_TOLERANCE_DEG &&
    Math.abs(a.endLat - endLat) < MATCH_TOLERANCE_DEG &&
    Math.abs(a.endLng - endLng) < MATCH_TOLERANCE_DEG;
}

export function findBest(startLat, startLng, endLat, endLng) {
  const races = loadAll().filter(r => sameRace(r, startLat, startLng, endLat, endLng));
  if (races.length === 0) return null;
  return races.reduce((best, r) => (r.timeSeconds < best.timeSeconds ? r : best));
}

export function saveRace({ startLat, startLng, endLat, endLng, distanceKm, timeSeconds }) {
  const races = loadAll();
  races.push({
    startLat, startLng, endLat, endLng, distanceKm, timeSeconds,
    dateISO: new Date().toISOString(),
  });
  saveAll(races);
}

// Saved routes: named (start, end) pairs a player can jump back into from the
// picker screen instead of re-clicking the map / re-picking a distance.
const ROUTES_KEY = "earthrace.routes";

function loadRoutesRaw() {
  try {
    return JSON.parse(localStorage.getItem(ROUTES_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveRoutesRaw(routes) {
  localStorage.setItem(ROUTES_KEY, JSON.stringify(routes));
}

export function loadRoutes() {
  return loadRoutesRaw();
}

export function saveRoute({ name, startLat, startLng, endLat, endLng, distanceKm }) {
  const routes = loadRoutesRaw();
  const route = { id: Date.now(), name, startLat, startLng, endLat, endLng, distanceKm };
  routes.push(route);
  saveRoutesRaw(routes);
  return route;
}

export function deleteRoute(id) {
  saveRoutesRaw(loadRoutesRaw().filter(r => r.id !== id));
}

// Ghost replays: the recorded path of the best time for an exact (start, end)
// pair, so a later attempt can race against it. Keyed the same way sameRace()
// buckets races, but as a lookup key (not a linear scan) since this is read
// every time the drive screen opens, not just once per finish.
const GHOSTS_KEY = "earthrace.ghosts";

function ghostKey(startLat, startLng, endLat, endLng) {
  const bucket = v => Math.round(v / MATCH_TOLERANCE_DEG);
  return `${bucket(startLat)}_${bucket(startLng)}_${bucket(endLat)}_${bucket(endLng)}`;
}

function loadGhostsRaw() {
  try {
    return JSON.parse(localStorage.getItem(GHOSTS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveGhostsRaw(ghosts) {
  localStorage.setItem(GHOSTS_KEY, JSON.stringify(ghosts));
}

export function getGhost(startLat, startLng, endLat, endLng) {
  return loadGhostsRaw()[ghostKey(startLat, startLng, endLat, endLng)] || null;
}

// Only overwrites the stored ghost when this run is a new best — the ghost
// is always "the fastest run anyone's recorded on this device," not "the
// most recent one."
export function saveGhostIfBest(startLat, startLng, endLat, endLng, timeSeconds, path) {
  const ghosts = loadGhostsRaw();
  const key = ghostKey(startLat, startLng, endLat, endLng);
  const existing = ghosts[key];
  if (!existing || timeSeconds < existing.timeSeconds) {
    ghosts[key] = { timeSeconds, path };
    saveGhostsRaw(ghosts);
  }
}

// Collectables: which of the 1000 fixed collectables (see collectables.js)
// this player has found. Just a set of ids — the definitions themselves are
// static/generated, never stored.
const COLLECTED_KEY = "earthrace.collected";

function loadCollectedRaw() {
  try {
    return JSON.parse(localStorage.getItem(COLLECTED_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveCollectedRaw(ids) {
  localStorage.setItem(COLLECTED_KEY, JSON.stringify(ids));
}

export function getCollectedIds() {
  return new Set(loadCollectedRaw());
}

export function markCollected(id) {
  const ids = loadCollectedRaw();
  if (!ids.includes(id)) {
    ids.push(id);
    saveCollectedRaw(ids);
  }
}
