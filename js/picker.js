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
import { haversineDistanceKm, geocodePlace } from "./geo.js";
import { resumeAudio } from "./audio.js";
import { REGIONS } from "./collectables.js";
import { GRAND_PRIX_CIRCUITS, LAP_OPTIONS } from "./grandprix.js";

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

export function initPicker(onConfirm, onConfirmGp) {
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
  const gpToggleBtn = document.getElementById("gp-toggle-btn");
  const gpPanel = document.getElementById("gp-panel");
  const gpCircuitsEl = document.getElementById("gp-circuits");
  const gpLapButtons = [];
  const gpGoBtn = document.getElementById("gp-go-btn");
  const planToggleBtn = document.getElementById("plan-toggle-btn");
  const planPanel = document.getElementById("plan-panel");
  const startPlaceInput = document.getElementById("start-place-input");
  const startPlaceBtn = document.getElementById("start-place-btn");
  const endPlaceInput = document.getElementById("end-place-input");
  const endPlaceBtn = document.getElementById("end-place-btn");

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

  // Shared by a map click and the Plan Route panel's "Find" button — a fresh
  // start point clears everything downstream of it (end point, distance),
  // since it was only ever meaningful relative to the old one.
  function setStart(pt) {
    start = pt;
    clearEnd();
    distButtons.forEach(b => b.classList.remove("selected"));
    distanceKm = null;
    customKmEl.value = "";
    if (marker) marker.remove();
    marker = L.marker(start).addTo(map);
  }

  function setEnd(pt) {
    end = pt;
    if (endMarker) endMarker.remove();
    endMarker = L.circleMarker(end, { radius: 9, color: "#fff", weight: 2, fillColor: "#ef5350", fillOpacity: 0.9 }).addTo(map);
    distButtons.forEach(b => b.classList.remove("selected"));
    distanceKm = null;
  }

  // Jumps straight back into a previously saved (start, end) pair instead of
  // re-clicking the map — mirrors the "exact end point" state a manual
  // second click would produce.
  function loadRoute(route) {
    setStart({ lat: route.startLat, lng: route.startLng });
    setEnd({ lat: route.endLat, lng: route.endLng });
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
    // Fresh start (either the very first click, or starting over after both
    // were set) vs. setting the end point — same two cases setStart/setEnd
    // handle for the Plan Route panel's typed inputs.
    if (!start || end) setStart(pt);
    else setEnd(pt);
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

  // Grand Prix: pick one of the top-10 real circuits (see grandprix.js) plus
  // a lap count, then race a lap-based loop through real roads there instead
  // of the usual point-to-point drive — separate flow/callback (onConfirmGp)
  // since it needs neither a map click nor a distance.
  let selectedCircuit = null;
  let selectedLaps = null;

  function updateGpUI() {
    gpGoBtn.disabled = !(selectedCircuit && selectedLaps);
  }

  gpToggleBtn.addEventListener("click", () => gpPanel.classList.toggle("show"));

  for (const circuit of GRAND_PRIX_CIRCUITS) {
    const chip = document.createElement("div");
    chip.className = "route-chip gp-chip";
    chip.title = `${circuit.lapKm.toFixed(2)} km per lap`;
    chip.textContent = circuit.name;
    chip.addEventListener("click", () => {
      selectedCircuit = circuit;
      Array.from(gpCircuitsEl.children).forEach(c => c.classList.remove("selected"));
      chip.classList.add("selected");
      updateGpUI();
    });
    gpCircuitsEl.appendChild(chip);
  }

  for (const laps of LAP_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "dist-btn lap-btn";
    btn.textContent = laps === 1 ? "1 lap" : `${laps} laps`;
    btn.addEventListener("click", () => {
      selectedLaps = laps;
      gpLapButtons.forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      updateGpUI();
    });
    gpLapButtons.push(btn);
    document.getElementById("gp-laps").appendChild(btn);
  }

  gpGoBtn.addEventListener("click", async () => {
    if (!selectedCircuit || !selectedLaps || !onConfirmGp) return;
    resumeAudio();
    gpGoBtn.disabled = true;
    statusEl.textContent = "Setting up the circuit…";
    try {
      await onConfirmGp(selectedCircuit, selectedLaps);
    } catch (err) {
      console.error(err);
      statusEl.textContent = err.message || "Something went wrong — try another circuit.";
      gpGoBtn.disabled = false;
    }
  });

  // Plan Route: type real place names for the start/end point instead of
  // clicking the map — geocoded through Nominatim (geo.js). Each typed place
  // also drops a marker on the map exactly like a click would, so both input
  // methods stay interchangeable (type a start then click to adjust the end,
  // etc). The actual best route between them (green overlay, ferries and
  // all) is computed automatically once the race starts — see main.js's
  // fetchRoute call and drive.js's rendering.
  planToggleBtn.addEventListener("click", () => planPanel.classList.toggle("show"));

  async function findPlace(input, btn, onFound) {
    const q = input.value.trim();
    if (!q) return;
    btn.disabled = true;
    statusEl.textContent = "Finding place…";
    try {
      const place = await geocodePlace(q);
      if (!place) { statusEl.textContent = `Couldn't find "${q}".`; return; }
      onFound(place);
      statusEl.textContent = "";
    } catch (err) {
      console.error(err);
      statusEl.textContent = err.message || "Place search failed — try again.";
    } finally {
      btn.disabled = false;
    }
  }

  startPlaceBtn.addEventListener("click", () => findPlace(startPlaceInput, startPlaceBtn, (place) => {
    setStart({ lat: place.lat, lng: place.lng });
    map.setView([place.lat, place.lng], 13);
    updateUI();
  }));

  endPlaceBtn.addEventListener("click", () => findPlace(endPlaceInput, endPlaceBtn, (place) => {
    if (!start) { statusEl.textContent = "Set a start point first."; return; }
    setEnd({ lat: place.lat, lng: place.lng });
    map.fitBounds([[start.lat, start.lng], [place.lat, place.lng]], { padding: [40, 40] });
    updateUI();
  }));

  for (const [input, btn] of [[startPlaceInput, startPlaceBtn], [endPlaceInput, endPlaceBtn]]) {
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") btn.click(); });
  }

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
