// 1000 procedurally-defined collectables, scattered across the real world.
// Everything here is deterministic (seeded PRNGs, no Math.random()) so every
// player's 1000 collectables sit at exactly the same coordinates with exactly
// the same name/rarity/icon — the set is fixed data baked into the client,
// not something generated per-session. That's what makes "have you found the
// Obsidian Beacon of the Deep yet?" a conversation two players can actually
// have, even though there's no server: it's the same global list for everyone.

export const COLLECTABLE_COUNT = 1000;

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"];
const RARITY_COUNTS = { common: 600, uncommon: 250, rare: 100, epic: 40, legendary: 10 };
export const RARITY_LABELS = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };
// RGB triples (not hex) so callers can drop in any alpha for glows/fills.
export const RARITY_RGB = {
  common: "142,153,163",
  uncommon: "53,195,122",
  rare: "74,144,217",
  epic: "168,85,247",
  legendary: "240,168,63",
};

export const COLLECT_RADIUS_M = 25; // how close the player must drive to pick one up

// Small deterministic PRNG (mulberry32) — same seed always produces the same
// sequence, which is the whole point: no two players' worlds can drift apart.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const ADJECTIVES = [
  "Golden", "Crystal", "Shadow", "Ancient", "Radiant", "Frozen", "Blazing", "Mystic", "Silver", "Emerald",
  "Cursed", "Sacred", "Lost", "Hidden", "Whispering", "Thunder", "Crimson", "Azure", "Obsidian", "Celestial",
  "Rusty", "Forgotten", "Gilded", "Phantom", "Prismatic", "Wandering", "Sunken", "Stormlit", "Moonlit", "Ember",
];
const NOUNS = [
  "Compass", "Idol", "Relic", "Coin", "Gem", "Crown", "Shard", "Key", "Amulet", "Chalice",
  "Talisman", "Orb", "Medallion", "Scroll", "Feather", "Lantern", "Anchor", "Locket", "Rune", "Mask",
  "Vial", "Beacon", "Seed", "Horn", "Mirror", "Sigil", "Tooth", "Fragment", "Charm", "Statuette",
];
const ORIGINS = [
  "of the North", "of the Deep", "of Old", "of Legend", "of the Tide", "of the Peaks", "of Dusk", "of Dawn",
  "of the Wild", "of Fortune", "of the Void", "of Echoes", "of the Storm", "of the Sands", "of the Forge",
  "of Whispers", "of the Stars", "of the Ashes", "of the Horizon", "of the Depths",
];
const ICONS = [
  "💎", "🔮", "🏆", "🗿", "🎯", "🚀", "🛸", "🎪", "🎭", "⚡",
  "🔥", "❄️", "🌙", "☀️", "🍀", "🔑", "👑", "🧿", "🪙", "🎁",
  "🧭", "⚓", "🎻", "📿", "🦋", "🐉", "🦅", "🌺", "🍄", "⭐",
];

// Rough landmass bounding boxes, weighted loosely by land area/population —
// keeps collectables reachable by road instead of scattered a third into the
// ocean, while still genuinely spanning every inhabited continent. Doubles as
// the "region" grouping for collectable sets/bonuses and the globe_trotter
// achievement (see achievements.js).
export const REGIONS = [
  { name: "North America", lat: [25, 60], lng: [-125, -70], w: 15 },
  { name: "South America", lat: [-55, 12], lng: [-80, -35], w: 10 },
  { name: "Europe", lat: [36, 70], lng: [-10, 40], w: 15 },
  { name: "Africa", lat: [-35, 37], lng: [-18, 50], w: 12 },
  { name: "Middle East", lat: [12, 45], lng: [35, 75], w: 6 },
  { name: "South Asia", lat: [8, 35], lng: [68, 90], w: 8 },
  { name: "East Asia", lat: [20, 50], lng: [100, 145], w: 12 },
  { name: "Southeast Asia", lat: [-10, 20], lng: [95, 140], w: 6 },
  { name: "Australia", lat: [-45, -10], lng: [112, 155], w: 6 },
  { name: "Russia", lat: [50, 70], lng: [40, 170], w: 5 },
];
const TOTAL_REGION_WEIGHT = REGIONS.reduce((s, r) => s + r.w, 0);

function pickRegion(rng) {
  let roll = rng() * TOTAL_REGION_WEIGHT;
  for (const r of REGIONS) {
    if ((roll -= r.w) <= 0) return r;
  }
  return REGIONS[REGIONS.length - 1];
}

// Best-effort "which region is this real-world point in" for lat/lngs that
// didn't come from pickRegion() (e.g. a race's actual start point) — falls
// back to the nearest region by center distance if it's outside every box
// (open ocean, Antarctica, etc.), so it always returns *something*.
export function regionNameForLatLng(lat, lng) {
  for (const r of REGIONS) {
    if (lat >= r.lat[0] && lat <= r.lat[1] && lng >= r.lng[0] && lng <= r.lng[1]) return r.name;
  }
  let best = REGIONS[0], bestDist = Infinity;
  for (const r of REGIONS) {
    const cLat = (r.lat[0] + r.lat[1]) / 2, cLng = (r.lng[0] + r.lng[1]) / 2;
    const d = Math.hypot(lat - cLat, lng - cLng);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best.name;
}

let _all = null;

export function getAllCollectables() {
  if (_all) return _all;

  const rarityPool = [];
  for (const r of RARITIES) for (let i = 0; i < RARITY_COUNTS[r]; i++) rarityPool.push(r);
  const rarityByIndex = seededShuffle(rarityPool, 20260905);

  const list = [];
  for (let id = 0; id < COLLECTABLE_COUNT; id++) {
    const rng = mulberry32(0x9e3779b1 ^ id);
    const region = pickRegion(rng);
    const lat = region.lat[0] + rng() * (region.lat[1] - region.lat[0]);
    const lng = region.lng[0] + rng() * (region.lng[1] - region.lng[0]);
    const name = `${ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)]} ${NOUNS[Math.floor(rng() * NOUNS.length)]} ${ORIGINS[Math.floor(rng() * ORIGINS.length)]}`;
    const icon = ICONS[Math.floor(rng() * ICONS.length)];
    list.push({ id, name, rarity: rarityByIndex[id], icon, lat, lng, region: region.name });
  }
  _all = list;
  return _all;
}

// { regionName: { total, ids: [...] } } — used by the collectables gallery to
// show set-completion progress per region.
export function getRegionGroups() {
  const groups = {};
  for (const c of getAllCollectables()) {
    (groups[c.region] ??= { total: 0, ids: [] });
    groups[c.region].total++;
    groups[c.region].ids.push(c.id);
  }
  return groups;
}

// Projects every collectable into a race's local flat-meters frame once, so
// per-frame pickup/render checks are cheap hypot() calls instead of haversine.
export function projectCollectables(roadData) {
  return getAllCollectables().map(c => {
    const p = roadData.project(c.lat, c.lng);
    return { ...c, x: p.x, y: p.y };
  });
}
