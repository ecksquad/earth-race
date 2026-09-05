// Road/parking-lot data for the drive screen: fetched incrementally in tiles
// around the car and kept as line segments in a local flat meters projection
// (equirectangular, centered on the race's start point — accurate enough at
// race scale and much cheaper per-frame than geodesic math). Segments are
// grouped per tile so both collision checks and rendering only ever look at
// the handful of tiles near the car, not the whole route (important for the
// 1000km tier, where the full route's tiles would otherwise pile up).
// Pure state/math, no DOM or canvas references, so any renderer can consume it.

import { overpassFetch } from "./geo.js";
import { getCachedTile, setCachedTile } from "./tileCache.js";

const TILE_DEG = 0.02; // ~2.2km tiles at the equator
const LOAD_RADIUS_TILES = 1; // load/consider the current tile + 1 ring around it
const M_PER_DEG_LAT = 110540;

export const ROAD_HALF_WIDTH_M = 5;
export const OFFROAD_MARGIN_M = 4;
const HAZARD_CHANCE = 0.015; // per road segment in a freshly loaded tile
const NITRO_CHANCE = 0.01;
export const HAZARD_RADIUS_M = 2.2;
export const NITRO_RADIUS_M = 3;
export const NITRO_RESPAWN_MS = 25000;
export const NITRO_BOOST_SECONDS = 4;

function metersPerDegLng(lat) {
  return 111320 * Math.cos(lat * Math.PI / 180);
}

export class RoadData {
  constructor(originLat, originLng) {
    this.originLat = originLat;
    this.originLng = originLng;
    this.mPerDegLng = metersPerDegLng(originLat);
    this.tileSegments = new Map(); // tileKey -> {x1,y1,x2,y2}[]
    this.tileSignals = new Map();  // tileKey -> {x,y,kind}[] ("signal" | "stop")
    this.tileHazards = new Map();  // tileKey -> {x,y}[] (roadworks cones — static, always there)
    this.tileNitros = new Map();   // tileKey -> {x,y,collectedAt}[] (respawning boost pickups)
    this.pendingTiles = new Set();
  }

  project(lat, lng) {
    return {
      x: (lng - this.originLng) * this.mPerDegLng,
      y: (lat - this.originLat) * M_PER_DEG_LAT,
    };
  }

  unproject(x, y) {
    return {
      lat: this.originLat + y / M_PER_DEG_LAT,
      lng: this.originLng + x / this.mPerDegLng,
    };
  }

  _tileCoordsFor(x, y) {
    const { lat, lng } = this.unproject(x, y);
    return { tx: Math.floor(lat / TILE_DEG), ty: Math.floor(lng / TILE_DEG) };
  }

  // Kick off loading for any unloaded tiles near (x,y) in local meters.
  // Fire-and-forget: newly loaded segments just appear in future frames.
  ensureLoaded(x, y) {
    const { tx, ty } = this._tileCoordsFor(x, y);
    for (let dx = -LOAD_RADIUS_TILES; dx <= LOAD_RADIUS_TILES; dx++) {
      for (let dy = -LOAD_RADIUS_TILES; dy <= LOAD_RADIUS_TILES; dy++) {
        const key = `${tx + dx}_${ty + dy}`;
        if (this.tileSegments.has(key) || this.pendingTiles.has(key)) continue;
        this.pendingTiles.add(key);
        this._loadTile(tx + dx, ty + dy, key);
      }
    }
  }

  async _loadTile(tx, ty, key) {
    // Cached tile data (see tileCache.js) is keyed by absolute tile coords and
    // stored as raw lat/lng — NOT this instance's local meters — since a tile
    // fetched by one race's RoadData (with its own local origin) needs to be
    // reprojected before another race (a different origin) can reuse it.
    const globalKey = `${tx}_${ty}`;
    let raw = getCachedTile(globalKey);

    if (!raw) {
      try {
        const bbox = {
          south: tx * TILE_DEG, north: (tx + 1) * TILE_DEG,
          west: ty * TILE_DEG, east: (ty + 1) * TILE_DEG,
        };
        const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
        const ql = `[out:json][timeout:25];(way["highway"](${b});way["amenity"="parking"](${b});node["highway"="traffic_signals"](${b});node["highway"="stop"](${b}););out geom;`;
        const json = await overpassFetch(ql);
        const ways = [];
        const signals = [];
        for (const el of json.elements || []) {
          if (el.type === "way" && Array.isArray(el.geometry)) {
            for (let i = 0; i < el.geometry.length - 1; i++) {
              const a = el.geometry[i], b2 = el.geometry[i + 1];
              ways.push({ lat1: a.lat, lng1: a.lon, lat2: b2.lat, lng2: b2.lon });
            }
          } else if (el.type === "node" && el.tags?.highway) {
            const kind = el.tags.highway === "traffic_signals" ? "signal" : el.tags.highway === "stop" ? "stop" : null;
            if (kind && typeof el.lat === "number") signals.push({ lat: el.lat, lng: el.lon, kind });
          }
        }
        raw = { ways, signals };
        // Only cache on success — a failed tile must stay retriable, not get
        // permanently blackholed as "loaded with zero roads" on the next
        // ensureLoaded() call (the public Overpass mirrors fail transiently often).
        setCachedTile(globalKey, raw);
      } catch (err) {
        console.warn("Road tile load failed, will retry", key, err);
        this.pendingTiles.delete(key);
        return;
      }
    }

    const segs = raw.ways.map(w => {
      const p1 = this.project(w.lat1, w.lng1), p2 = this.project(w.lat2, w.lng2);
      return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    });
    const signals = raw.signals.map(s => {
      const p = this.project(s.lat, s.lng);
      return { x: p.x, y: p.y, kind: s.kind };
    });

    // Roadworks/nitro pickups aren't real OSM features — scattered at random
    // along the segments this tile actually has, at load time, so they're
    // stable for the rest of the race but different next time you drive the
    // same area. Not seeded/deterministic like the 1000 fixed collectables —
    // these are meant to vary race to race, so they're never cached above.
    const hazards = [];
    const nitros = [];
    for (const s of segs) {
      const roll = Math.random();
      const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
      if (roll < HAZARD_CHANCE) hazards.push({ x: mx, y: my });
      else if (roll < HAZARD_CHANCE + NITRO_CHANCE) nitros.push({ x: mx, y: my, collectedAt: 0 });
    }

    this.tileSegments.set(key, segs);
    this.tileSignals.set(key, signals);
    this.tileHazards.set(key, hazards);
    this.tileNitros.set(key, nitros);
    this.pendingTiles.delete(key);
  }

  // Segments from the loaded tile grid around (x,y) — bounded regardless of
  // total race distance, used for both collision checks and rendering.
  nearbySegments(x, y) {
    const { tx, ty } = this._tileCoordsFor(x, y);
    const out = [];
    for (let dx = -LOAD_RADIUS_TILES; dx <= LOAD_RADIUS_TILES; dx++) {
      for (let dy = -LOAD_RADIUS_TILES; dy <= LOAD_RADIUS_TILES; dy++) {
        const segs = this.tileSegments.get(`${tx + dx}_${ty + dy}`);
        if (segs) out.push(...segs);
      }
    }
    return out;
  }

  // Traffic signals/stop signs from the same loaded tile grid as nearbySegments().
  nearbySignals(x, y) {
    return this._nearbyFrom(this.tileSignals, x, y);
  }

  nearbyHazards(x, y) {
    return this._nearbyFrom(this.tileHazards, x, y);
  }

  nearbyNitros(x, y) {
    return this._nearbyFrom(this.tileNitros, x, y);
  }

  _nearbyFrom(map, x, y) {
    const { tx, ty } = this._tileCoordsFor(x, y);
    const out = [];
    for (let dx = -LOAD_RADIUS_TILES; dx <= LOAD_RADIUS_TILES; dx++) {
      for (let dy = -LOAD_RADIUS_TILES; dy <= LOAD_RADIUS_TILES; dy++) {
        const items = map.get(`${tx + dx}_${ty + dy}`);
        if (items) out.push(...items);
      }
    }
    return out;
  }

  // Shortest distance in meters from (x,y) to the nearest nearby road/parking segment.
  distanceToNearestRoad(x, y) {
    let best = Infinity;
    for (const s of this.nearbySegments(x, y)) {
      const d = distToSegment(x, y, s.x1, s.y1, s.x2, s.y2);
      if (d < best) best = d;
    }
    return best;
  }
}

// Real signal timing isn't in OSM, so each light gets a deterministic pseudo-
// random phase offset (seeded from its own position, so it's stable across
// frames/reloads and different lights aren't all synchronized) cycling
// through a fixed green/yellow/red rhythm.
const SIGNAL_CYCLE_MS = 24000;
const SIGNAL_GREEN_MS = 10000;
const SIGNAL_YELLOW_MS = 2000;

export function signalPhase(signal, nowMs) {
  const seed = Math.abs(Math.round(signal.x * 7) ^ Math.round(signal.y * 13)) % SIGNAL_CYCLE_MS;
  const t = (nowMs + seed) % SIGNAL_CYCLE_MS;
  if (t < SIGNAL_GREEN_MS) return "green";
  if (t < SIGNAL_GREEN_MS + SIGNAL_YELLOW_MS) return "yellow";
  return "red";
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
