// World map + distance picker screen. Leaflet handles the map; this module
// just wires the UI and hands (startLat, startLng, distanceKm, manualEnd) to
// the caller. Click once for a start point, click again to optionally choose
// an exact end point too — or skip that and just pick a distance instead,
// which generates a random end point at that distance. Whichever was picked
// most recently (a distance button vs. a second map click) wins; a third
// click starts over with a new start point.
//
// A route with both an exact start and end point can be saved (named) and
// reloaded later from the chip list, instead of re-clicking the map.

import { saveRoute, loadRoutes, deleteRoute } from "./storage.js";
import { haversineDistanceKm } from "./geo.js";
import { resumeAudio } from "./audio.js";
import { REGIONS } from "./collectables.js";

// A handful of well-known real drives, as instant-start presets — approximate
// city-level coordinates, not the exact famous alignment/track in every case
// (the actual Nürburgring circuit isn't a public "highway"-tagged road OSM
// exposes, for instance) but a real, recognizable drive through the area.
const FAMOUS_ROUTES = [
  { name: "🇺🇸 Route 66: Santa Monica → Barstow", startLat: 34.0092, startLng: -118.4966, endLat: 34.8958, endLng: -117.0173 },
  { name: "🇺🇸 Big Sur (PCH)", startLat: 36.5552, startLng: -121.9233, endLat: 35.6397, endLng: -121.1892 },
  { name: "🇩🇪 Nürburgring area", startLat: 50.3356, startLng: 6.9475, endLat: 50.3606, endLng: 6.9469 },
  { name: "🇺🇸 Golden Gate Crossing", startLat: 37.8591, startLng: -122.4852, endLat: 37.8078, endLng: -122.4177 },
  { name: "🇩🇪 Autobahn: Munich → Nuremberg", startLat: 48.1351, startLng: 11.5820, endLat: 49.4521, endLng: 11.0767 },
];

export function initPicker(onConfirm) {
  const map = L.map("map", { worldCopyJump: true }).setView([20, 0], 3);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  }).addTo(map);

  let marker = null;
  let endMarker = null;
  let start = null;
  let end = null;
  let distanceKm = null;

  const statusEl = document.getElementById("picker-status");
  const hintEl = document.querySelector("#picker-panel .hint");
  const goBtn = document.getElementById("go-btn");
  const customKmEl = document.getElementById("custom-km");
  const distButtons = Array.from(document.querySelectorAll(".dist-btn"));
  const saveRouteBtn = document.getElementById("save-route-btn");
  const savedRoutesEl = document.getElementById("saved-routes");
  const surpriseBtn = document.getElementById("surprise-me-btn");
  const famousRoutesEl = document.getElementById("famous-routes");

  function updateUI() {
    goBtn.disabled = !(start && (end || distanceKm > 0));
    saveRouteBtn.disabled = !(start && end);
    if (!start) hintEl.textContent = "Click the map to drop your start point.";
    else if (!end) hintEl.textContent = "Pick a distance below, or click the map again to choose an exact end point instead.";
    else hintEl.textContent = "End point set — distance buttons are ignored. Click the map again to start over.";
  }

  function clearEnd() {
    if (endMarker) { endMarker.remove(); endMarker = null; }
    end = null;
  }

  // Jumps straight back into a previously saved (start, end) pair instead of
  // re-clicking the map — mirrors the "exact end point" state a manual
  // second click would produce.
  function loadRoute(route) {
    start = { lat: route.startLat, lng: route.startLng };
    end = { lat: route.endLat, lng: route.endLng };
    distanceKm = null;
    distButtons.forEach(b => b.classList.remove("selected"));
    customKmEl.value = "";
    if (marker) marker.remove();
    marker = L.marker(start).addTo(map);
    if (endMarker) endMarker.remove();
    endMarker = L.circleMarker(end, { radius: 9, color: "#fff", weight: 2, fillColor: "#ef5350", fillOpacity: 0.9 }).addTo(map);
    map.fitBounds([[start.lat, start.lng], [end.lat, end.lng]], { padding: [40, 40] });
    statusEl.textContent = "";
    updateUI();
  }

  function renderSavedRoutes() {
    savedRoutesEl.innerHTML = "";
    for (const route of loadRoutes()) {
      const chip = document.createElement("div");
      chip.className = "route-chip";
      chip.title = "Load this route";

      const label = document.createElement("span");
      label.textContent = route.name || `${route.distanceKm.toFixed(1)} km route`;
      chip.appendChild(label);

      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Delete route";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteRoute(route.id);
        renderSavedRoutes();
      });
      chip.appendChild(del);

      chip.addEventListener("click", () => loadRoute(route));
      savedRoutesEl.appendChild(chip);
    }
  }

  map.on("click", (e) => {
    const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (!start || end) {
      // Fresh start (either the very first click, or starting over after both were set).
      start = pt;
      clearEnd();
      distButtons.forEach(b => b.classList.remove("selected"));
      distanceKm = null;
      customKmEl.value = "";
      if (marker) marker.remove();
      marker = L.marker(start).addTo(map);
    } else {
      end = pt;
      if (endMarker) endMarker.remove();
      endMarker = L.circleMarker(end, { radius: 9, color: "#fff", weight: 2, fillColor: "#ef5350", fillOpacity: 0.9 }).addTo(map);
      distButtons.forEach(b => b.classList.remove("selected"));
      distanceKm = null;
    }
    statusEl.textContent = "";
    updateUI();
  });

  distButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      clearEnd();
      distButtons.forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      customKmEl.value = "";
      distanceKm = Number(btn.dataset.km);
      updateUI();
    });
  });

  customKmEl.addEventListener("input", () => {
    clearEnd();
    distButtons.forEach(b => b.classList.remove("selected"));
    const v = Number(customKmEl.value);
    distanceKm = v > 0 ? v : null;
    updateUI();
  });

  async function confirmStart(startLat, startLng, km, manualEnd) {
    goBtn.disabled = true;
    statusEl.textContent = manualEnd ? "Finding a road near your end point…" : "Finding an end point on real roads…";
    try {
      await onConfirm(startLat, startLng, km, manualEnd);
    } catch (err) {
      console.error(err);
      statusEl.textContent = err.message || "Something went wrong — try a different point/distance.";
      goBtn.disabled = false;
    }
  }

  goBtn.addEventListener("click", () => {
    if (!start || !(end || distanceKm)) return;
    resumeAudio(); // must happen synchronously in this gesture handler, before any await
    confirmStart(start.lat, start.lng, distanceKm, end);
  });

  // Fully random race, zero input: a random real land point (reusing the
  // same weighted continent list the 1000 collectables spread across, so
  // it's reachable-by-road-biased too) plus a random distance tier.
  const SURPRISE_DISTANCES = [1, 1, 10, 10, 10, 100, 100, 1000];
  const totalRegionWeight = REGIONS.reduce((s, r) => s + r.w, 0);
  surpriseBtn.addEventListener("click", () => {
    resumeAudio();
    let roll = Math.random() * totalRegionWeight, region = REGIONS[REGIONS.length - 1];
    for (const r of REGIONS) { if ((roll -= r.w) <= 0) { region = r; break; } }
    const lat = region.lat[0] + Math.random() * (region.lat[1] - region.lat[0]);
    const lng = region.lng[0] + Math.random() * (region.lng[1] - region.lng[0]);
    const km = SURPRISE_DISTANCES[Math.floor(Math.random() * SURPRISE_DISTANCES.length)];
    confirmStart(lat, lng, km, null);
  });

  function renderFamousRoutes() {
    for (const route of FAMOUS_ROUTES) {
      const chip = document.createElement("div");
      chip.className = "route-chip";
      chip.title = "Load this route";
      const label = document.createElement("span");
      label.textContent = route.name;
      chip.appendChild(label);
      chip.addEventListener("click", () => loadRoute(route));
      famousRoutesEl.appendChild(chip);
    }
  }

  saveRouteBtn.addEventListener("click", () => {
    if (!start || !end) return;
    const name = window.prompt("Name this route:", "");
    if (name === null) return; // cancelled
    saveRoute({
      name: name.trim() || undefined,
      startLat: start.lat, startLng: start.lng,
      endLat: end.lat, endLng: end.lng,
      distanceKm: haversineDistanceKm(start.lat, start.lng, end.lat, end.lng),
    });
    renderSavedRoutes();
  });

  updateUI();
  renderSavedRoutes();
  renderFamousRoutes();

  return {
    onShow() {
      // Leaflet needs a nudge after its container was hidden (display:none)
      // and is now shown again, otherwise tiles can be laid out wrong.
      setTimeout(() => map.invalidateSize(), 0);
    },
  };
}
