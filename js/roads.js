// Road/parking-lot data for the drive screen: fetched incrementally in tiles
// around the car and kept as line segments in a local flat meters projection
// (equirectangular, centered on the race's start point — accurate enough at
// race scale and much cheaper per-frame than geodesic math). Segments are
// grouped per tile so both collision checks and rendering only ever look at
// the handful of tiles near the car, not the whole route (important for the
// 1000km tier, where the full route's tiles would otherwise pile up).
// Pure state/math, no DOM or canvas references, so any renderer can consume it.

import { overpassFetch } from "./geo.js";

const TILE_DEG = 0.02; // ~2.2km tiles at the equator
const LOAD_RADIUS_TILES = 1; // load/consider the current tile + 1 ring around it
const M_PER_DEG_LAT = 110540;

export const ROAD_HALF_WIDTH_M = 5;
export const OFFROAD_MARGIN_M = 4;

function metersPerDegLng(lat) {
  return 111320 * Math.cos(lat * Math.PI / 180);
}

export class RoadData {
  constructor(originLat, originLng) {
    this.originLat = originLat;
    this.originLng = originLng;
    this.mPerDegLng = metersPerDegLng(originLat);
    this.tileSegments = new Map(); // tileKey -> {x1,y1,x2,y2}[]
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
    try {
      const bbox = {
        south: tx * TILE_DEG, north: (tx + 1) * TILE_DEG,
        west: ty * TILE_DEG, east: (ty + 1) * TILE_DEG,
      };
      const ql = `[out:json][timeout:25];(way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});way["amenity"="parking"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out geom;`;
      const json = await overpassFetch(ql);
      const segs = [];
      for (const el of json.elements || []) {
        if (el.type !== "way" || !Array.isArray(el.geometry)) continue;
        const pts = el.geometry.map(p => this.project(p.lat, p.lon));
        for (let i = 0; i < pts.length - 1; i++) {
          segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
        }
      }
      // Only cache on success — a failed tile must stay retriable, not get
      // permanently blackholed as "loaded with zero roads" on the next
      // ensureLoaded() call (the public Overpass mirrors fail transiently often).
      this.tileSegments.set(key, segs);
    } catch (err) {
      console.warn("Road tile load failed, will retry", key, err);
    } finally {
      this.pendingTiles.delete(key);
    }
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

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
