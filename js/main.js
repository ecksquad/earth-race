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

const picker = initPicker(onConfirmStart);
initCollectablesUI();
initGarageUI();
initStatsUI();

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
