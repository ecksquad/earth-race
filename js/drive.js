// Canvas 2D top-down renderer + game loop + input + race timer. This is the
// only module that touches the DOM/canvas — it just reads car.js/roads.js
// state, so a future 3D renderer can be added alongside it without touching
// physics or road logic.

import { stepCar, MAX_SPEED_ON_ROAD, MAX_SPEED_OFF_ROAD } from "./car.js";
import { ROAD_HALF_WIDTH_M, OFFROAD_MARGIN_M } from "./roads.js";
import { saveRace, findBest, saveRoute, getGhost, saveGhostIfBest, getCollectedIds, markCollected } from "./storage.js";
import { BaseMap, DEFAULT_ZOOM } from "./basemap.js";
import { spawnBots, stepBots, BOT_RADIUS_M } from "./bots.js";
import { projectCollectables, RARITY_RGB, COLLECT_RADIUS_M } from "./collectables.js";
import { encodeGhost, decodeGhost } from "./ghostCode.js";
import * as audio from "./audio.js";
import { startBroadcasting, stopBroadcasting, getOthers } from "./multiplayer.js";

const PX_PER_METER = 7.5;
const FINISH_RADIUS_M = 15;
const GAMEPAD_DEADZONE = 0.15;
const CAR_LENGTH_M = 4.5; // real-world car length, used to size the sprite
const CAR_HITBOX_RADIUS_M = 0.9; // player half-width for collision — real car half-width, not half-length
const EXPLOSION_DURATION_MS = 700;
const GHOST_SAMPLE_INTERVAL_S = 0.15; // how often to record a path point for the ghost replay
const TOAST_DURATION_MS = 2600;

// The source image's nose points along its own +x (the engine-vent panel is
// the rear), so bringing it to "nose up" at heading 0 needs a -90° twist
// before car.heading is applied on top.
const CAR_SPRITE_BASE_ROTATION = -Math.PI / 2;

// The source PNG is huge (3848px) but drawn at only ~20px in-game — letting
// the browser downscale that ~170:1 ratio live, every frame, produces visible
// aliasing/moiré. Pre-downsample once with high-quality smoothing instead.
let carSprite = null;
{
  const raw = new Image();
  raw.src = "assets/car-top.png";
  raw.addEventListener("load", () => {
    const targetW = 480;
    const targetH = Math.round(targetW * (raw.naturalHeight / raw.naturalWidth));
    const off = document.createElement("canvas");
    off.width = targetW;
    off.height = targetH;
    const octx = off.getContext("2d");
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(raw, 0, 0, targetW, targetH);
    carSprite = off;
  });
}

const MINIMAP_MARGIN = 20;
const MINIMAP_RADIUS_PX = 144;
const MINIMAP_METERS = 150; // real-world radius shown on the minimap

let raf = null;
let keysDown = new Set();
let onKeyDown, onKeyUp;

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

function normalizeKey(e) {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "ArrowUp" || k === "w") return "up";
  if (k === "ArrowDown" || k === "s") return "down";
  if (k === "ArrowLeft" || k === "a") return "left";
  if (k === "ArrowRight" || k === "d") return "right";
  return null;
}

function readKeyboardInput() {
  const throttle = (keysDown.has("up") ? 1 : 0) - (keysDown.has("down") ? 1 : 0);
  const steer = (keysDown.has("right") ? 1 : 0) - (keysDown.has("left") ? 1 : 0);
  return { throttle, steer };
}

function readGamepadInput() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && pads[0];
  if (!gp) return { throttle: 0, steer: 0 };

  let steer = gp.axes[0] || 0;
  if (Math.abs(steer) < GAMEPAD_DEADZONE) steer = 0;

  let throttle = 0;
  const stickY = gp.axes[1] || 0;
  if (Math.abs(stickY) > GAMEPAD_DEADZONE) throttle = -stickY;
  const rt = gp.buttons[7] ? gp.buttons[7].value : 0;
  const lt = gp.buttons[6] ? gp.buttons[6].value : 0;
  if (rt > 0.05 || lt > 0.05) throttle = rt - lt;

  return { throttle: Math.max(-1, Math.min(1, throttle)), steer: Math.max(-1, Math.min(1, steer)) };
}

export function startDrive({ roadData, car, endLocal, endLatLng, startLatLng, distanceKm }, { onBack }) {
  const canvas = document.getElementById("gamecanvas");
  const ctx = canvas.getContext("2d");
  const hudTime = document.getElementById("hud-time");
  const hudSpeed = document.getElementById("hud-speed");
  const hudRemaining = document.getElementById("hud-remaining");
  const hudBest = document.getElementById("hud-best");
  const offroadBadge = document.getElementById("offroad-badge");
  const backBtn = document.getElementById("back-btn");
  const resultEl = document.getElementById("result");
  const resultHeading = document.getElementById("result-heading");
  const resultTimeEl = document.getElementById("result-time");
  const resultBestEl = document.getElementById("result-best");
  const raceAgainBtn = document.getElementById("race-again-btn");
  const saveThisRouteBtn = document.getElementById("save-this-route-btn");
  const ghostToggleWrap = document.getElementById("ghost-toggle-wrap");
  const ghostToggleInput = document.getElementById("ghost-toggle");
  const ghostToggleLabel = document.getElementById("ghost-toggle-label");
  const importGhostBtn = document.getElementById("import-ghost-btn");
  const copyGhostBtn = document.getElementById("copy-ghost-btn");
  const collectToast = document.getElementById("collect-toast");
  const collectToastIcon = document.getElementById("collect-toast-icon");
  const collectToastName = document.getElementById("collect-toast-name");
  const collectToastRarity = document.getElementById("collect-toast-rarity");
  const collectProgressBadge = document.getElementById("collect-progress");
  const landmarkBanner = document.getElementById("landmark-banner");

  const previousBest = findBest(startLatLng.lat, startLatLng.lng, endLatLng.lat, endLatLng.lng);
  hudBest.textContent = previousBest ? fmtTime(previousBest.timeSeconds) : "–";
  resultEl.classList.remove("show");
  saveThisRouteBtn.disabled = false;
  saveThisRouteBtn.textContent = "Save this route";
  copyGhostBtn.classList.remove("show");
  copyGhostBtn.textContent = "📋 Copy ghost code";

  if (endLatLng.name) {
    landmarkBanner.textContent = `🏛 Destination: ${endLatLng.name}`;
    landmarkBanner.classList.add("show");
  } else {
    landmarkBanner.classList.remove("show");
  }

  let ghost = getGhost(startLatLng.lat, startLatLng.lng, endLatLng.lat, endLatLng.lng);
  let importedGhost = null;
  let showGhost = false;
  ghostToggleInput.checked = false;

  function activeGhost() { return importedGhost || ghost; }

  function refreshGhostToggle() {
    const g = activeGhost();
    if (g && g.path && g.path.length > 1) {
      ghostToggleWrap.classList.add("show");
      ghostToggleLabel.textContent = importedGhost
        ? `👻 Show ghost (imported, ${fmtTime(g.timeSeconds)})`
        : `👻 Show ghost (your best, ${fmtTime(g.timeSeconds)})`;
    } else {
      ghostToggleWrap.classList.remove("show");
    }
  }
  ghostToggleInput.onchange = () => { showGhost = ghostToggleInput.checked; };
  refreshGhostToggle();

  importGhostBtn.onclick = () => {
    const code = window.prompt("Paste a friend's ghost code:", "");
    if (!code) return;
    const decoded = decodeGhost(code);
    if (!decoded) { window.alert("That doesn't look like a valid ghost code."); return; }
    const TOLERANCE_DEG = 0.01; // ~1km — generous since road-snapping can nudge the exact point a little
    const matches = Math.abs(decoded.startLat - startLatLng.lat) < TOLERANCE_DEG &&
      Math.abs(decoded.startLng - startLatLng.lng) < TOLERANCE_DEG &&
      Math.abs(decoded.endLat - endLatLng.lat) < TOLERANCE_DEG &&
      Math.abs(decoded.endLng - endLatLng.lng) < TOLERANCE_DEG;
    if (!matches) { window.alert("That ghost code is for a different route."); return; }
    importedGhost = decoded;
    showGhost = true;
    ghostToggleInput.checked = true;
    refreshGhostToggle();
  };

  let recordedPath = [];
  let lastSampleT = -Infinity;
  let wasColliding = false;

  const collectedIds = getCollectedIds();
  const collectables = projectCollectables(roadData).filter(c => !collectedIds.has(c.id));
  const toastQueue = [];
  let toastTimer = null;

  const baseMap = new BaseMap(roadData);
  const bots = spawnBots(roadData, car.x, car.y);
  const COLLISION_DIST_M = CAR_HITBOX_RADIUS_M + BOT_RADIUS_M;
  const CRASH_COMBINED_KMH = 200;

  // Shared-world multiplayer (see multiplayer.js) — a no-op if not configured.
  // Other players are purely cosmetic: real-world position broadcast over the
  // network is too laggy/jittery to referee a fair collision against.
  startBroadcasting(() => {
    const ll = roadData.unproject(car.x, car.y);
    return { lat: ll.lat, lng: ll.lng, heading: car.heading, speed: car.speed };
  });

  let raceStartTime = null;
  let finished = false;
  let showOverview = false;
  let offRoad = false;
  let explosion = null; // { x, y, startedAt } while the crash animation plays
  let explosionTimeout = null;

  let dprWatcher = null;

  // Browser page-zoom (ctrl+scroll / ctrl+plus) changes devicePixelRatio but,
  // in Chrome-family browsers, does NOT fire a window "resize" event — so
  // relying on "resize" alone leaves the canvas's backing-store resolution
  // and transform stale after a zoom, which the browser then stretches
  // (blurry sprites, and anything positioned off canvas.clientWidth/Height
  // math drifting relative to what's actually visible). A self-re-arming
  // matchMedia listener is the standard cross-browser way to catch a DPR-only
  // change that "resize" misses.
  function watchDpr() {
    const dpr = window.devicePixelRatio || 1;
    dprWatcher = matchMedia(`(resolution: ${dpr}dppx)`);
    dprWatcher.addEventListener("change", onDprChange, { once: true });
  }
  function onDprChange() {
    resize();
    watchDpr();
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return; // layout not settled yet (e.g. right after display:none->flex) — the observer fires again once it is
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ResizeObserver (not a window "resize" listener) because it fires once the
  // canvas's actual layout size is settled, including the very first time —
  // a window resize listener plus a single synchronous resize() call at
  // startup can measure clientWidth/Height before the display:none->flex
  // transition finishes laying out, permanently undersizing the backing store.
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  onKeyDown = (e) => {
    const k = normalizeKey(e);
    if (k) { keysDown.add(k); e.preventDefault(); }
    if (e.key === "m" || e.key === "M") { showOverview = true; e.preventDefault(); }
  };
  onKeyUp = (e) => {
    const k = normalizeKey(e);
    if (k) keysDown.delete(k);
    if (e.key === "m" || e.key === "M") showOverview = false;
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  watchDpr();

  function cleanup() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (explosionTimeout) clearTimeout(explosionTimeout);
    if (toastTimer) clearTimeout(toastTimer);
    stopBroadcasting();
    keysDown.clear();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    resizeObserver.disconnect();
    if (dprWatcher) dprWatcher.removeEventListener("change", onDprChange);
    backBtn.onclick = null;
    raceAgainBtn.onclick = null;
    saveThisRouteBtn.onclick = null;
    ghostToggleInput.onchange = null;
    importGhostBtn.onclick = null;
    copyGhostBtn.onclick = null;
  }

  backBtn.onclick = () => { cleanup(); onBack(); };
  raceAgainBtn.onclick = () => { cleanup(); onBack(); };
  saveThisRouteBtn.onclick = () => {
    const name = window.prompt("Name this route:", "");
    if (name === null) return; // cancelled
    saveRoute({
      name: name.trim() || undefined,
      startLat: startLatLng.lat, startLng: startLatLng.lng,
      endLat: endLatLng.lat, endLng: endLatLng.lng,
      distanceKm,
    });
    saveThisRouteBtn.disabled = true;
    saveThisRouteBtn.textContent = "Saved!";
  };

  function finish() {
    finished = true;
    const timeSeconds = (performance.now() - raceStartTime) / 1000;
    saveRace({
      startLat: startLatLng.lat, startLng: startLatLng.lng,
      endLat: endLatLng.lat, endLng: endLatLng.lng,
      distanceKm, timeSeconds,
    });
    saveGhostIfBest(startLatLng.lat, startLatLng.lng, endLatLng.lat, endLatLng.lng, timeSeconds, recordedPath);
    ghost = getGhost(startLatLng.lat, startLatLng.lng, endLatLng.lat, endLatLng.lng);
    refreshGhostToggle();
    resultHeading.textContent = endLatLng.name ? `Arrived at ${endLatLng.name}!` : "Finished!";
    resultTimeEl.textContent = fmtTime(timeSeconds);
    resultBestEl.textContent = (!previousBest || timeSeconds < previousBest.timeSeconds)
      ? "New personal best!"
      : `Previous best: ${fmtTime(previousBest.timeSeconds)}`;
    resultEl.classList.add("show");

    copyGhostBtn.classList.add("show");
    copyGhostBtn.onclick = () => {
      const code = encodeGhost({
        startLat: startLatLng.lat, startLng: startLatLng.lng,
        endLat: endLatLng.lat, endLng: endLatLng.lng,
        timeSeconds, path: recordedPath,
      });
      navigator.clipboard.writeText(code).then(() => {
        copyGhostBtn.textContent = "Copied!";
        setTimeout(() => { copyGhostBtn.textContent = "📋 Copy ghost code"; }, 1800);
      }).catch(() => window.alert("Couldn't copy to clipboard — your browser may be blocking it."));
    };
  }

  // Ghost playback position at `elapsed` seconds into the race, or null once
  // the ghost's recorded run has finished (or hasn't started/doesn't exist).
  function ghostPositionAt(elapsed) {
    const g = activeGhost();
    if (!g || !g.path || g.path.length === 0) return null;
    const path = g.path;
    if (elapsed < path[0].t) return null;
    if (elapsed >= path[path.length - 1].t) return null;
    let lo = 0, hi = path.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (path[mid].t <= elapsed) lo = mid; else hi = mid;
    }
    const a = path[lo], b = path[hi];
    const f = (b.t - a.t) > 0 ? (elapsed - a.t) / (b.t - a.t) : 0;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, heading: a.heading + (b.heading - a.heading) * f };
  }

  // Collect toast is a small queue so back-to-back pickups (two collectables
  // a few meters apart) each get their own moment instead of clobbering one
  // another's timer.
  function queueCollectToast(c) {
    toastQueue.push(c);
    if (!toastTimer) showNextToast();
  }
  function showNextToast() {
    const c = toastQueue.shift();
    if (!c) { toastTimer = null; return; }
    collectToastIcon.textContent = c.icon;
    collectToastName.textContent = c.name;
    collectToastRarity.textContent = c.rarity;
    collectToastRarity.style.color = `rgb(${RARITY_RGB[c.rarity]})`;
    collectToast.classList.add("show");
    toastTimer = setTimeout(() => {
      collectToast.classList.remove("show");
      toastTimer = setTimeout(showNextToast, 300);
    }, TOAST_DURATION_MS);
  }

  function crash(timeSeconds) {
    finished = true;
    resultHeading.textContent = "Crashed!";
    resultTimeEl.textContent = fmtTime(timeSeconds);
    resultBestEl.textContent = "Watch out for traffic — try again.";
    resultEl.classList.add("show");
  }

  // Freezes the car and plays a brief explosion animation before handing off
  // to crash() — capturing the elapsed time now, at the moment of impact,
  // rather than after the animation delay.
  function triggerCrash() {
    const timeSeconds = raceStartTime === null ? 0 : (performance.now() - raceStartTime) / 1000;
    explosion = { x: car.x, y: car.y, startedAt: performance.now() };
    car.speed = 0;
    audio.playCrash();
    explosionTimeout = setTimeout(() => crash(timeSeconds), EXPLOSION_DURATION_MS);
  }

  function drawExplosion(sx, sy, progress) {
    const maxR = CAR_LENGTH_M * PX_PER_METER * 2.2;
    ctx.save();
    ctx.translate(sx, sy);
    const layers = [
      { color: "255,224,130", from: 0, to: 0.5 },  // bright flash core, fades early
      { color: "255,152,0", from: 0.1, to: 0.8 },  // orange fireball
      { color: "239,83,80", from: 0.25, to: 1 },   // red outer
      { color: "60,60,60", from: 0.4, to: 1 },     // smoke ring, lingers longest
    ];
    for (const layer of layers) {
      const local = Math.max(0, Math.min(1, (progress - layer.from) / (layer.to - layer.from)));
      if (local <= 0) continue;
      const alpha = (1 - local) * 0.85;
      if (alpha <= 0) continue;
      ctx.beginPath();
      ctx.fillStyle = `rgba(${layer.color},${alpha})`;
      ctx.arc(0, 0, maxR * (0.3 + 0.7 * local), 0, Math.PI * 2);
      ctx.fill();
    }
    const particleCount = 8;
    const dist = maxR * 0.9 * progress;
    const alpha = (1 - progress) * 0.9;
    if (alpha > 0) {
      ctx.fillStyle = `rgba(255,193,7,${alpha})`;
      for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2 + i;
        ctx.beginPath();
        ctx.arc(Math.cos(angle) * dist, Math.sin(angle) * dist, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function draw(offRoad) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.fillStyle = "#3a3f33";
    ctx.fillRect(0, 0, w, h);

    const camX = car.x, camY = car.y;
    const toScreen = (x, y) => ({
      sx: w / 2 + (x - camX) * PX_PER_METER,
      sy: h / 2 - (y - camY) * PX_PER_METER, // world +y (north) is up on screen
    });

    const halfWm = (w / 2) / PX_PER_METER, halfHm = (h / 2) / PX_PER_METER;
    baseMap.draw(ctx, toScreen, camX - halfWm, camY - halfHm, camX + halfWm, camY + halfHm);

    const endPt = toScreen(endLocal.x, endLocal.y);
    ctx.fillStyle = "#ef5350";
    ctx.beginPath();
    ctx.arc(endPt.sx, endPt.sy, 8, 0, Math.PI * 2);
    ctx.fill();

    const bobT = performance.now() / 300;
    for (const c of collectables) {
      const p = toScreen(c.x, c.y);
      if (p.sx < -40 || p.sx > w + 40 || p.sy < -40 || p.sy > h + 40) continue;
      const bob = Math.sin(bobT + c.id) * 4;
      ctx.save();
      ctx.translate(p.sx, p.sy + bob);
      ctx.beginPath();
      ctx.fillStyle = `rgba(${RARITY_RGB[c.rarity]},.3)`;
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "20px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(c.icon, 0, 1);
      ctx.restore();
    }

    if (showGhost && raceStartTime !== null) {
      const gp = ghostPositionAt((performance.now() - raceStartTime) / 1000);
      if (gp) {
        const p = toScreen(gp.x, gp.y);
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.translate(p.sx, p.sy);
        if (carSprite) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.filter = "grayscale(1) brightness(1.6)";
          ctx.rotate(gp.heading + CAR_SPRITE_BASE_ROTATION);
          const lenPx = CAR_LENGTH_M * PX_PER_METER;
          const widPx = lenPx * (carSprite.height / carSprite.width);
          ctx.drawImage(carSprite, -lenPx / 2, -widPx / 2, lenPx, widPx);
          ctx.filter = "none";
        } else {
          ctx.rotate(gp.heading);
          ctx.fillStyle = "#eef3f7";
          ctx.beginPath();
          ctx.moveTo(0, -10);
          ctx.lineTo(6, 8);
          ctx.lineTo(-6, 8);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
    }

    for (const bot of bots) {
      const p = toScreen(bot.x, bot.y);
      if (p.sx < -50 || p.sx > w + 50 || p.sy < -50 || p.sy > h + 50) continue;
      ctx.save();
      ctx.translate(p.sx, p.sy);
      if (carSprite) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.filter = "hue-rotate(200deg) saturate(1.3)"; // distinguish traffic bots (blue tint) from the player's red car
        ctx.rotate(bot.heading + CAR_SPRITE_BASE_ROTATION);
        const lenPx = CAR_LENGTH_M * PX_PER_METER;
        const widPx = lenPx * (carSprite.height / carSprite.width);
        ctx.drawImage(carSprite, -lenPx / 2, -widPx / 2, lenPx, widPx);
        ctx.filter = "none";
      } else {
        ctx.rotate(bot.heading);
        ctx.fillStyle = "#4a90d9";
        ctx.beginPath();
        ctx.moveTo(0, -10);
        ctx.lineTo(6, 8);
        ctx.lineTo(-6, 8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // Other real players (see multiplayer.js) — each broadcasts real-world
    // lat/lng, projected here into THIS race's local frame. Purely cosmetic:
    // no collision against them (see the startBroadcasting comment above).
    for (const [, other] of getOthers()) {
      const local = roadData.project(other.lat, other.lng);
      const p = toScreen(local.x, local.y);
      if (p.sx < -50 || p.sx > w + 50 || p.sy < -50 || p.sy > h + 50) continue;
      ctx.save();
      ctx.translate(p.sx, p.sy);
      if (carSprite) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.filter = "hue-rotate(280deg) saturate(1.4)"; // distinguish real players (magenta) from ambient bots (blue)
        ctx.rotate(other.heading + CAR_SPRITE_BASE_ROTATION);
        const lenPx = CAR_LENGTH_M * PX_PER_METER;
        const widPx = lenPx * (carSprite.height / carSprite.width);
        ctx.drawImage(carSprite, -lenPx / 2, -widPx / 2, lenPx, widPx);
        ctx.filter = "none";
      } else {
        ctx.rotate(other.heading);
        ctx.fillStyle = "#e040fb";
        ctx.beginPath();
        ctx.moveTo(0, -10);
        ctx.lineTo(6, 8);
        ctx.lineTo(-6, 8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(other.name || "Driver", p.sx, p.sy - 22);
    }

    const carPt = toScreen(car.x, car.y);
    if (explosion) {
      const progress = Math.min(1, (performance.now() - explosion.startedAt) / EXPLOSION_DURATION_MS);
      drawExplosion(carPt.sx, carPt.sy, progress);
    } else {
      ctx.save();
      ctx.translate(carPt.sx, carPt.sy);
      if (carSprite) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.rotate(car.heading + CAR_SPRITE_BASE_ROTATION);
        const lenPx = CAR_LENGTH_M * PX_PER_METER;
        const widPx = lenPx * (carSprite.height / carSprite.width);
        ctx.drawImage(carSprite, -lenPx / 2, -widPx / 2, lenPx, widPx);
      } else {
        ctx.rotate(car.heading);
        ctx.fillStyle = offRoad ? "#f0a83f" : "#33e0c2";
        ctx.beginPath();
        ctx.moveTo(0, -10);
        ctx.lineTo(6, 8);
        ctx.lineTo(-6, 8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    drawMinimap();
  }

  function drawMinimap() {
    const h = canvas.clientHeight;
    const cx = MINIMAP_MARGIN + MINIMAP_RADIUS_PX;
    const cy = h - MINIMAP_MARGIN - MINIMAP_RADIUS_PX;
    const scale = MINIMAP_RADIUS_PX / MINIMAP_METERS;
    const toMini = (x, y) => ({
      mx: cx + (x - car.x) * scale,
      my: cy - (y - car.y) * scale, // north-up, same as the main view
    });

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, MINIMAP_RADIUS_PX, 0, Math.PI * 2);
    ctx.clip();

    // Real imagery instead of a flat dark disc — falls back to that dark fill
    // underneath wherever no tile has loaded yet, same as the main view.
    ctx.fillStyle = "rgba(10,14,19,.82)";
    ctx.fill();
    const toMiniScreen = (x, y) => { const p = toMini(x, y); return { sx: p.mx, sy: p.my }; };
    baseMap.draw(ctx, toMiniScreen, car.x - MINIMAP_METERS, car.y - MINIMAP_METERS, car.x + MINIMAP_METERS, car.y + MINIMAP_METERS);
    ctx.fillStyle = "rgba(10,14,19,.45)"; // dim the imagery so lines/icons stay legible
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 224, 130, 0.6)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (const s of roadData.nearbySegments(car.x, car.y)) {
      const a = toMini(s.x1, s.y1), b = toMini(s.x2, s.y2);
      ctx.beginPath();
      ctx.moveTo(a.mx, a.my);
      ctx.lineTo(b.mx, b.my);
      ctx.stroke();
    }

    for (const bot of bots) {
      if (Math.hypot(bot.x - car.x, bot.y - car.y) > MINIMAP_METERS) continue;
      const p = toMini(bot.x, bot.y);
      ctx.fillStyle = "#4a90d9";
      ctx.beginPath();
      ctx.arc(p.mx, p.my, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    const dx = endLocal.x - car.x, dy = endLocal.y - car.y;
    const distToEnd = Math.hypot(dx, dy);
    if (distToEnd <= MINIMAP_METERS) {
      const p = toMini(endLocal.x, endLocal.y);
      ctx.fillStyle = "#ef5350";
      ctx.beginPath();
      ctx.arc(p.mx, p.my, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Waypoint blip: when the destination is off the minimap, show an arrow
    // clamped to the rim pointing in its direction (GTA-style radar beacon).
    if (distToEnd > MINIMAP_METERS) {
      const angle = Math.atan2(dx, dy);
      const rim = MINIMAP_RADIUS_PX - 10;
      const bx = cx + Math.sin(angle) * rim;
      const by = cy - Math.cos(angle) * rim;
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(angle);
      ctx.fillStyle = "#ef5350";
      ctx.beginPath();
      ctx.moveTo(0, -8);
      ctx.lineTo(5, 5);
      ctx.lineTo(-5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Player marker + rim.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(car.heading);
    ctx.fillStyle = "#33e0c2";
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, MINIMAP_RADIUS_PX, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.6)";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("N", cx, cy - MINIMAP_RADIUS_PX + 12);
  }

  // Whole-route overview shown while "M" is held — real satellite imagery
  // (at whatever coarser zoom the route's span needs — a 1000km route at
  // full driving-view detail would be many thousands of tiles) plus start,
  // end, and current-position markers scaled to fit the screen.
  function drawOverview() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.fillStyle = "#12161b";
    ctx.fillRect(0, 0, w, h);

    const pad = 60;
    const xs = [0, endLocal.x, car.x], ys = [0, endLocal.y, car.y];
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    const toOverview = (x, y) => ({
      sx: w / 2 + (x - midX) * scale,
      sy: h / 2 - (y - midY) * scale,
    });

    // Standard Web Mercator resolution formula, solved for the zoom whose
    // meters-per-pixel matches what `scale` already needs to fit the route.
    const metersPerPixel = 1 / scale;
    const approxLat = startLatLng.lat * Math.PI / 180;
    const zoom = Math.max(2, Math.min(DEFAULT_ZOOM,
      Math.round(Math.log2(156543.03392 * Math.cos(approxLat) / metersPerPixel))));
    const halfWm = (w / 2) / scale, halfHm = (h / 2) / scale;
    baseMap.draw(ctx, toOverview, midX - halfWm, midY - halfHm, midX + halfWm, midY + halfHm, zoom);

    const s = toOverview(0, 0), e = toOverview(endLocal.x, endLocal.y), c = toOverview(car.x, car.y);

    ctx.strokeStyle = "rgba(255,255,255,.5)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(s.sx, s.sy);
    ctx.lineTo(e.sx, e.sy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#35c37a";
    ctx.beginPath(); ctx.arc(s.sx, s.sy, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ef5350";
    ctx.beginPath(); ctx.arc(e.sx, e.sy, 8, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.translate(c.sx, c.sy);
    ctx.rotate(car.heading);
    ctx.fillStyle = "#33e0c2";
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5, 7);
    ctx.lineTo(-5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Route overview — release M to return", w / 2, 28);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (finished) return; // result modal is up; nothing left to simulate or draw

    if (!explosion) {
      const kb = readKeyboardInput();
      const gp = readGamepadInput();
      const input = {
        throttle: Math.max(-1, Math.min(1, kb.throttle + gp.throttle)),
        steer: Math.max(-1, Math.min(1, kb.steer + gp.steer)),
      };

      if (raceStartTime === null && (input.throttle !== 0 || input.steer !== 0)) {
        raceStartTime = performance.now();
      }

      roadData.ensureLoaded(car.x, car.y);
      const distToRoad = roadData.distanceToNearestRoad(car.x, car.y);
      offRoad = distToRoad > ROAD_HALF_WIDTH_M + OFFROAD_MARGIN_M;

      stepCar(car, input, 1 / 60, !offRoad);

      const rawDriftDiff = Math.atan2(Math.sin(car.heading - car.velHeading), Math.cos(car.heading - car.velHeading));
      audio.updateEngine(car.speed, offRoad ? MAX_SPEED_OFF_ROAD : MAX_SPEED_ON_ROAD, Math.max(0, input.throttle));
      audio.updateScreech(Math.min(1, Math.abs(rawDriftDiff) / (55 * Math.PI / 180)));

      const anyHonk = stepBots(bots, roadData, 1 / 60, { x: car.x, y: car.y }, car.speed);
      if (anyHonk) audio.playHorn();

      if (raceStartTime !== null) {
        let anyCollision = false, anyFatal = false;
        for (const bot of bots) {
          if (Math.hypot(car.x - bot.x, car.y - bot.y) < COLLISION_DIST_M) {
            anyCollision = true;
            if ((Math.abs(car.speed) + Math.abs(bot.speed)) * 3.6 > CRASH_COMBINED_KMH) anyFatal = true;
          }
        }
        if (anyFatal) triggerCrash();
        else if (anyCollision) {
          car.speed = 0;
          if (!wasColliding) audio.playBump();
        }
        wasColliding = anyCollision;
      }

      if (raceStartTime !== null) {
        const elapsed = (performance.now() - raceStartTime) / 1000;
        if (elapsed - lastSampleT >= GHOST_SAMPLE_INTERVAL_S) {
          recordedPath.push({ t: elapsed, x: car.x, y: car.y, heading: car.heading });
          lastSampleT = elapsed;
        }
      }

      for (let i = collectables.length - 1; i >= 0; i--) {
        const c = collectables[i];
        if (Math.hypot(car.x - c.x, car.y - c.y) < COLLECT_RADIUS_M) {
          markCollected(c.id);
          collectables.splice(i, 1);
          collectProgressBadge.textContent = `${getCollectedIds().size} / 1000`;
          queueCollectToast(c);
        }
      }

      const dx = endLocal.x - car.x, dy = endLocal.y - car.y;
      const remainingM = Math.hypot(dx, dy);
      if (raceStartTime !== null && remainingM < FINISH_RADIUS_M) {
        finish();
        return;
      }

      hudTime.textContent = fmtTime(raceStartTime === null ? 0 : (performance.now() - raceStartTime) / 1000);
      hudSpeed.textContent = Math.round(Math.abs(car.speed) * 3.6);
      hudRemaining.textContent = (remainingM / 1000).toFixed(2);
      offroadBadge.classList.toggle("show", offRoad);
    }

    if (showOverview) drawOverview();
    else draw(offRoad);
  }

  tick();
}
