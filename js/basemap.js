// Satellite basemap tiles — same Esri World Imagery source as the picker map.
// Each tile's corners are run through the exact roadData project()/unproject()
// already used for roads, so the imagery lines up with the road overlay
// instead of needing a second projection to reconcile against it.
//
// draw() takes an explicit zoom so the same instance/cache can serve both the
// close-up driving view (always at DEFAULT_ZOOM, the most detail available)
// and an occasional whole-route overview at a much coarser zoom (covering a
// 1000km route at DEFAULT_ZOOM would mean many thousands of tiles).

const TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const DEFAULT_ZOOM = 19; // Esri World_Imagery's maxZoom — the most detail available

// Esri returns this exact static image (always 2521 bytes) at any tile
// address where it has no imagery at that zoom — common in rural/remote
// areas. Detected by byte length; a real photographic tile coincidentally
// matching it is not a real risk. A tile confirmed unavailable this way just
// falls back to the flat background fill, same as one still loading — far
// less jarring than drawing Esri's gray "no data" graphic, and much simpler
// (and more robust) than trying to substitute a coarser zoom for it.
const PLACEHOLDER_TILE_BYTES = 2521;
const UNAVAILABLE = Symbol("tile unavailable");

function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
function latToTileY(lat, z) {
  const rad = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * 2 ** z);
}
function tileToLon(x, z) { return x / 2 ** z * 360 - 180; }
function tileToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return 180 / Math.PI * Math.atan(Math.sinh(n));
}

export class BaseMap {
  constructor(roadData) {
    this.roadData = roadData;
    this.tiles = new Map(); // "z_x_y" -> HTMLImageElement | UNAVAILABLE
    this.pending = new Set();
  }

  async _load(z, x, y, key) {
    try {
      const url = TILE_URL.replace("{z}", z).replace("{y}", y).replace("{x}", x);
      const res = await fetch(url);
      if (!res.ok) return; // stays uncached — retried on a later frame
      const buf = await res.arrayBuffer();
      if (buf.byteLength === PLACEHOLDER_TILE_BYTES) {
        this.tiles.set(key, UNAVAILABLE); // confirmed no imagery here — don't keep re-fetching it
        return;
      }
      const blob = new Blob([buf], { type: res.headers.get("content-type") || "image/jpeg" });
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode().catch(() => {});
      this.tiles.set(key, img);
    } catch (err) {
      console.warn("Basemap tile load failed, will retry", key, err);
    } finally {
      this.pending.delete(key);
    }
  }

  _get(z, x, y) {
    const key = `${z}_${x}_${y}`;
    const cached = this.tiles.get(key);
    if (cached === UNAVAILABLE) return null;
    if (cached) return cached;
    if (!this.pending.has(key)) {
      this.pending.add(key);
      this._load(z, x, y, key);
    }
    return null;
  }

  // Draw whatever tiles cover the given world-meters viewport and are
  // already loaded — a tile still loading (or confirmed unavailable) is
  // skipped, leaving the flat background fill showing through.
  draw(ctx, toScreen, minX, minY, maxX, maxY, zoom = DEFAULT_ZOOM) {
    const nw = this.roadData.unproject(minX, maxY);
    const se = this.roadData.unproject(maxX, minY);
    const xMin = lonToTileX(nw.lng, zoom), xMax = lonToTileX(se.lng, zoom);
    const yMin = latToTileY(nw.lat, zoom), yMax = latToTileY(se.lat, zoom);

    for (let tx = xMin; tx <= xMax; tx++) {
      for (let ty = yMin; ty <= yMax; ty++) {
        const img = this._get(zoom, tx, ty);
        if (!img) continue;

        const topLeft = this.roadData.project(tileToLat(ty, zoom), tileToLon(tx, zoom));
        const bottomRight = this.roadData.project(tileToLat(ty + 1, zoom), tileToLon(tx + 1, zoom));
        const a = toScreen(topLeft.x, topLeft.y);
        const b = toScreen(bottomRight.x, bottomRight.y);
        ctx.drawImage(img, a.sx, a.sy, b.sx - a.sx, b.sy - a.sy);
      }
    }
  }
}
