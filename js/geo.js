// Geodesy + Overpass helpers. Pure functions / network calls, no DOM.

const EARTH_RADIUS_M = 6371000;

// The public Overpass instances are shared/free and rate-limit hard (429) or
// time out (504) under any real load. We spread requests across a few known
// mirrors and serialize everything through one queue with a minimum gap, app
// wide, so we never hammer a single instance with a burst of parallel calls.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];
const MIN_GAP_MS = 700;
const MIRROR_TIMEOUT_MS = 15000; // a hung mirror must not block the others forever

let queueTail = Promise.resolve();
let lastRequestAt = 0;

function enqueue(task) {
  const run = queueTail.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return task();
  });
  queueTail = run.catch(() => {}); // don't let one failed task jam the queue
  return run;
}

function fetchMirror(base, ql, signal) {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), MIRROR_TIMEOUT_MS);
  const onExternalAbort = () => timeoutCtrl.abort();
  signal?.addEventListener("abort", onExternalAbort);
  return fetch(base, { method: "POST", body: "data=" + encodeURIComponent(ql), signal: timeoutCtrl.signal })
    .then(res => {
      if (!res.ok) throw new Error(`Overpass ${base} responded ${res.status}`);
      return res.json();
    })
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    });
}

// POST an Overpass QL query, serialized/throttled app-wide (one query in
// flight at a time, spaced by MIN_GAP_MS), racing all mirrors for THIS query
// in parallel rather than trying them one at a time — a dead/rate-limited
// mirror should cost us nothing beyond its own timeout, not push that wait
// onto every other mirror in line behind it.
export function overpassFetch(ql, { signal } = {}) {
  return enqueue(() => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    let remaining = OVERPASS_MIRRORS.length;
    for (const base of OVERPASS_MIRRORS) {
      fetchMirror(base, ql, signal).then(resolve, (err) => {
        if (signal?.aborted) { reject(err); return; } // caller cancelled — propagate
        console.warn(`Overpass mirror failed: ${base}`, err);
        remaining--;
        if (remaining === 0) {
          reject(new Error("Couldn't reach any map-data server right now — try again in a moment."));
        }
      });
    }
  }));
}

export function toRad(deg) { return deg * Math.PI / 180; }
export function toDeg(rad) { return rad * 180 / Math.PI; }

export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)) / 1000;
}

// Destination point given a start, bearing (deg, 0=north) and distance (km).
export function destinationPoint(lat, lng, bearingDeg, distanceKm) {
  const d = distanceKm * 1000 / EARTH_RADIUS_M;
  const brng = toRad(bearingDeg);
  const lat1 = toRad(lat), lng1 = toRad(lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

export function randomBearing() {
  return Math.random() * 360;
}

function bboxAround(lat, lng, radiusM) {
  const dLat = toDeg(radiusM / EARTH_RADIUS_M);
  const dLng = toDeg(radiusM / (EARTH_RADIUS_M * Math.cos(toRad(lat))));
  return { south: lat - dLat, west: lng - dLng, north: lat + dLat, east: lng + dLng };
}

function roadsQL(bbox) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:25];(way["highway"](${b});way["amenity"="parking"](${b}););out geom;`;
}

// Fetch roads/parking ways as arrays of {lat,lng} polylines within a bbox.
export async function fetchRoadWays(bbox) {
  const json = await overpassFetch(roadsQL(bbox));
  const ways = [];
  for (const el of json.elements || []) {
    if (el.type === "way" && Array.isArray(el.geometry)) {
      ways.push(el.geometry.map(p => ({ lat: p.lat, lng: p.lon })));
    }
  }
  return ways;
}

function nearestPointOnWays(ways, lat, lng) {
  let best = null, bestDist = Infinity;
  for (const way of ways) {
    for (const p of way) {
      const d = haversineDistanceKm(lat, lng, p.lat, p.lng);
      if (d < bestDist) { bestDist = d; best = p; }
    }
  }
  return best ? { point: best, distanceKm: bestDist } : null;
}

// Find a real point on a road/parking lot near (lat,lng), expanding the search
// radius a few times if nothing is found nearby (e.g. candidate landed in open
// water or unmapped terrain).
export async function snapToNearestRoad(lat, lng) {
  const radii = [300, 1000, 3000, 8000];
  for (const r of radii) {
    const ways = await fetchRoadWays(bboxAround(lat, lng, r));
    const nearest = nearestPointOnWays(ways, lat, lng);
    if (nearest) return nearest.point;
  }
  return null; // caller should pick a new bearing and retry
}

// Tags worth naming a destination after — real points of interest, not just
// an arbitrary spot on a road. "node"-only: ways/relations would need a
// separate center-of-geometry query, and nodes alone already give plenty of
// hits (viewpoints, monuments, peaks, museums, places of worship...).
const LANDMARK_TAGS = [
  ["tourism", "attraction"], ["tourism", "viewpoint"], ["tourism", "museum"],
  ["historic", "monument"], ["historic", "castle"], ["historic", "memorial"],
  ["natural", "peak"], ["amenity", "place_of_worship"],
];
const LANDMARK_CHANCE = 0.4; // fraction of distance-based races that try for a named destination first

async function findLandmarkNear(lat, lng, radiusM) {
  const bbox = bboxAround(lat, lng, radiusM);
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const clauses = LANDMARK_TAGS.map(([k, v]) => `node["${k}"="${v}"]["name"](${b});`).join("");
  const ql = `[out:json][timeout:25];(${clauses});out center 30;`;
  try {
    const json = await overpassFetch(ql);
    const named = (json.elements || []).filter(e => e.tags?.name && typeof e.lat === "number");
    if (named.length === 0) return null;
    const pick = named[Math.floor(Math.random() * named.length)];
    return { lat: pick.lat, lng: pick.lon, name: pick.tags.name };
  } catch {
    return null; // landmark search is a bonus, not essential — fall through to a plain endpoint
  }
}

// A lightweight flavor name for routes that didn't land on a real named
// landmark — based on distance tier + compass direction from the start, not
// actual terrain analysis (no elevation/land-cover data available here), so
// it's "The Coastal..." in name only if you happen to be near a coast.
const DISTANCE_STYLES = [
  { max: 5, words: ["Sprint", "Dash", "Quick Run", "Jaunt"] },
  { max: 50, words: ["Cruise", "Circuit", "Drive", "Loop"] },
  { max: 300, words: ["Expedition", "Trek", "Run", "Haul"] },
  { max: Infinity, words: ["Odyssey", "Crossing", "Marathon", "Pilgrimage"] },
];
const COMPASS = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"];

function generateRouteFlavorName(distanceKm, bearingDeg) {
  const style = DISTANCE_STYLES.find(s => distanceKm <= s.max);
  const word = style.words[Math.floor(Math.random() * style.words.length)];
  const dirIdx = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return `${word} to the ${COMPASS[dirIdx]}`;
}

// v1 simplification: this matches the requested distance as a straight-line
// (great-circle) distance to a real point on a road, not actual road-network
// driving distance — an exact version needs a full routing engine, which is
// out of scope for v1.
//
// Sometimes tries to land the destination on a real named landmark near the
// target distance/bearing instead of an arbitrary road point — "drive to the
// Eiffel Tower" beats "drive to this anonymous street corner." Falls back to
// the plain random-point method whenever no landmark turns up nearby, so this
// never makes a race less likely to succeed, only occasionally nicer.
export async function generateEndpoint(startLat, startLng, distanceKm) {
  if (Math.random() < LANDMARK_CHANCE) {
    const bearing = randomBearing();
    const target = destinationPoint(startLat, startLng, bearing, distanceKm);
    const searchRadiusM = Math.max(2000, distanceKm * 1000 * 0.2);
    const landmark = await findLandmarkNear(target.lat, target.lng, searchRadiusM);
    if (landmark) {
      const snapped = await snapToNearestRoad(landmark.lat, landmark.lng);
      if (snapped) return { ...snapped, name: landmark.name };
    }
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const bearing = randomBearing();
    const candidate = destinationPoint(startLat, startLng, bearing, distanceKm);
    const snapped = await snapToNearestRoad(candidate.lat, candidate.lng);
    if (snapped) return { ...snapped, name: generateRouteFlavorName(distanceKm, bearing) };
  }
  throw new Error("Could not find a road near the target distance/direction — try again.");
}

export { bboxAround };
