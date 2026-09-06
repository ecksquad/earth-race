// Screen switching + wiring between the picker, geo/road/car state, and the
// drive renderer.

import { initPicker } from "./picker.js";
import { generateEndpoint, snapToNearestRoad, haversineDistanceKm } from "./geo.js";
import { RoadData } from "./roads.js";
import { createCar } from "./car.js";
import { startDrive } from "./drive.js";
import { initCollectablesUI } from "./collectablesUI.js";
import { isMuted, setMuted } from "./audio.js";
import { connect as connectMultiplayer, isMultiplayerAvailable, getOnlineCount, getPlayerName, setPlayerName } from "./multiplayer.js";
import { initGarageUI } from "./garageUI.js";
import { initStatsUI } from "./statsUI.js";
import { buildTrackWaypoints } from "./grandprix.js";

const pickerScreen = document.getElementById("screen-picker");
const driveScreen = document.getElementById("screen-drive");

function showPicker() {
  driveScreen.classList.remove("active");
  pickerScreen.classList.add("active");
  picker.onShow();
}

function showDrive() {
  pickerScreen.classList.remove("active");
  driveScreen.classList.add("active");
}

async function onConfirmStart(startLat, startLng, distanceKm, manualEnd) {
  // Snap the start point onto a real road too — otherwise a click that lands
  // just off a road (a park, a block interior, open field) spawns the car
  // somewhere with no nearby road tiles to load, and the drive screen has
  // nothing to render.
  const snappedStart = await snapToNearestRoad(startLat, startLng);
  if (!snappedStart) {
    throw new Error("No road found near your start point — try clicking somewhere else.");
  }

  let end, actualDistanceKm;
  if (manualEnd) {
    end = await snapToNearestRoad(manualEnd.lat, manualEnd.lng);
    if (!end) {
      throw new Error("No road found near your chosen end point — try clicking somewhere else.");
    }
    actualDistanceKm = haversineDistanceKm(snappedStart.lat, snappedStart.lng, end.lat, end.lng);
  } else {
    end = await generateEndpoint(snappedStart.lat, snappedStart.lng, distanceKm);
    actualDistanceKm = distanceKm;
  }

  const roadData = new RoadData(snappedStart.lat, snappedStart.lng);
  const car = createCar(0, 0, 0);
  const endLocal = roadData.project(end.lat, end.lng);

  showDrive();
  startDrive(
    {
      roadData, car, endLocal,
      endLatLng: end,
      startLatLng: { lat: snappedStart.lat, lng: snappedStart.lng },
      distanceKm: actualDistanceKm,
    },
    { onBack: showPicker }
  );
}

// Snaps each raw (geometric-circle) waypoint onto the nearest real road once
// its tile has loaded, so the minimap's Grand Prix track guide (see
// drive.js) hugs actual streets instead of a straight line through whatever
// happens to be in the way. Loading is fire-and-forget (roads.js), so this
// polls, re-nudging any tile that hasn't arrived yet, until every waypoint
// has *something* nearby or the timeout is hit — whichever waypoints never
// get a nearby road just keep their raw circle position as a fallback.
async function buildGpTrackPoints(roadData, circuit, timeoutMs = 6000) {
  const raw = buildTrackWaypoints(circuit);
  const deadline = Date.now() + timeoutMs;
  let pending = raw;
  while (pending.length > 0 && Date.now() < deadline) {
    for (const p of pending) roadData.ensureLoaded(p.x, p.y);
    await new Promise((r) => setTimeout(r, 200));
    pending = pending.filter((p) => roadData.nearbySegments(p.x, p.y).length === 0);
  }
  return raw.map((p) => {
    const snapped = roadData.nearestPointOnRoad(p.x, p.y);
    return snapped && snapped.dist < 120 ? { x: snapped.x, y: snapped.y } : p;
  });
}

async function onConfirmGrandPrix(circuit, laps) {
  const snapped = await snapToNearestRoad(circuit.lat, circuit.lng);
  if (!snapped) {
    throw new Error("No road found at this circuit right now — try another one.");
  }

  const roadData = new RoadData(snapped.lat, snapped.lng);
  const car = createCar(0, 0, circuit.heading * Math.PI / 180);
  const trackPoints = await buildGpTrackPoints(roadData, circuit);

  showDrive();
  startDrive(
    {
      roadData, car,
      endLocal: { x: 0, y: 0 }, // the start/finish line — see drive.js's Grand Prix lap logic
      endLatLng: { lat: snapped.lat, lng: snapped.lng },
      startLatLng: { lat: snapped.lat, lng: snapped.lng },
      distanceKm: circuit.lapKm * laps,
      raceMode: { type: "gp", circuit, laps, trackPoints },
    },
    { onBack: showPicker }
  );
}

const picker = initPicker(onConfirmStart, onConfirmGrandPrix);
initCollectablesUI();
initGarageUI();
initStatsUI();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service worker registration failed", err));
}

const muteBtn = document.getElementById("mute-btn");
function refreshMuteBtn() { muteBtn.textContent = isMuted() ? "🔇" : "🔊"; }
muteBtn.addEventListener("click", () => { setMuted(!isMuted()); refreshMuteBtn(); });
refreshMuteBtn();

const onlineBadge = document.getElementById("online-badge");
if (isMultiplayerAvailable()) {
  // Auto-generate a name instead of blocking page load with a prompt() — the
  // badge itself is clickable any time to pick something else.
  if (!getPlayerName()) {
    setPlayerName(`Driver${Math.floor(1000 + Math.random() * 9000)}`);
  }
  onlineBadge.classList.add("show");
  onlineBadge.title = `You're "${getPlayerName()}" — click to change your name`;
  onlineBadge.addEventListener("click", () => {
    const name = window.prompt("Pick a name other drivers will see you as:", getPlayerName());
    if (name === null) return; // cancelled
    setPlayerName(name.trim().slice(0, 20) || "Driver");
    onlineBadge.title = `You're "${getPlayerName()}" — click to change your name`;
  });
  connectMultiplayer().then((ok) => {
    if (!ok) onlineBadge.classList.remove("show");
  });
  setInterval(() => { onlineBadge.textContent = `👥 ${getOnlineCount()} online`; }, 1000);
}
