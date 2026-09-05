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

  goBtn.addEventListener("click", async () => {
    if (!start || !(end || distanceKm)) return;
    resumeAudio(); // must happen synchronously in this gesture handler, before any await
    goBtn.disabled = true;
    statusEl.textContent = end ? "Finding a road near your end point…" : "Finding an end point on real roads…";
    try {
      await onConfirm(start.lat, start.lng, distanceKm, end);
    } catch (err) {
      console.error(err);
      statusEl.textContent = err.message || "Something went wrong — try a different point/distance.";
      goBtn.disabled = false;
    }
  });

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

  return {
    onShow() {
      // Leaflet needs a nudge after its container was hidden (display:none)
      // and is now shown again, otherwise tiles can be laid out wrong.
      setTimeout(() => map.invalidateSize(), 0);
    },
  };
}
