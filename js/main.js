// Screen switching + wiring between the picker, geo/road/car state, and the
// drive renderer.

import { initPicker } from "./picker.js";
import { generateEndpoint, snapToNearestRoad, haversineDistanceKm, fetchRoute, simplifyRoute } from "./geo.js";
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

  // The actual best real-road route (OSRM's free public demo router), shown
  // as a green overlay on the drive screen (see drive.js) instead of just a
  // straight line to the destination. A route lookup failure (the demo
  // server is occasionally slow/unreachable, or genuinely no route exists)
  // never blocks the race from starting — it just means no overlay/ferry
  // this time, same "nice to have, not required" spirit as landmark names.
  let routePoints = null;
  let ferrySegments = [];
  for (let attempt = 0; attempt < 2 && !routePoints; attempt++) {
    try {
      const route = await fetchRoute(snappedStart.lat, snappedStart.lng, end.lat, end.lng);
      if (route) {
        routePoints = simplifyRoute(route.points).map(p => roadData.project(p.lat, p.lng));
        ferrySegments = route.ferrySegments.map(seg => seg.map(p => roadData.project(p.lat, p.lng)));
        console.log(`Route overlay: ${route.points.length} points, ${ferrySegments.length} ferry segment(s)`);
      } else {
        console.warn("Route lookup returned no route (OSRM code !== Ok) — no overlay this race");
      }
    } catch (err) {
      console.warn(`Route lookup attempt ${attempt + 1} failed`, err);
    }
  }

  showDrive();
  startDrive(
    {
      roadData, car, endLocal,
      endLatLng: end,
      startLatLng: { lat: snappedStart.lat, lng: snappedStart.lng },
      distanceKm: actualDistanceKm,
      routePoints, ferrySegments,
    },
    { onBack: showPicker }
  );
}

async function onConfirmGrandPrix(circuit, laps) {
  const snapped = await snapToNearestRoad(circuit.lat, circuit.lng);
  if (!snapped) {
    throw new Error("No road found at this circuit right now — try another one.");
  }

  const roadData = new RoadData(snapped.lat, snapped.lng);
  const car = createCar(0, 0, circuit.heading * Math.PI / 180);
  const trackPoints = buildTrackWaypoints(circuit);
  // Kick off loading for every waypoint's tile now rather than waiting for
  // the player to physically drive there — fire-and-forget (roads.js), same
  // as the car's own position. Real Overpass tile fetches are deliberately
  // throttled app-wide (see geo.js) to avoid getting rate-limited, so a full
  // lap loop's worth of tiles can take many seconds to arrive; rather than
  // block race start on that, drive.js's minimap re-snaps these waypoints
  // onto real roads live, frame by frame, as tiles land — the guide starts
  // as a plain geometric loop and sharpens onto real streets over the race.
  for (const p of trackPoints) roadData.ensureLoaded(p.x, p.y);

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
