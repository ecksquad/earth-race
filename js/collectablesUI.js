// Collectables gallery modal, reachable from the header button on any screen:
// shows all 1000 fixed collectables (see collectables.js) as a grid, dimmed
// with "?" until found. Purely a browsing/bragging view — collection itself
// happens by driving near one (see drive.js), which updates the same
// header progress badge live.

import { getAllCollectables, RARITY_RGB, RARITY_LABELS } from "./collectables.js";
import { getCollectedIds } from "./storage.js";

export function initCollectablesUI() {
  const btn = document.getElementById("collectables-btn");
  const progressBadge = document.getElementById("collect-progress");
  const modal = document.getElementById("collectables-modal");
  const closeBtn = document.getElementById("collectables-close");
  const grid = document.getElementById("collectables-grid");
  const modalProgress = document.getElementById("modal-progress");
  const filterButtons = Array.from(document.querySelectorAll(".filter-btn"));

  const all = getAllCollectables();
  let filter = "all";
  let tiles = [];

  function refreshProgressBadge() {
    progressBadge.textContent = `${getCollectedIds().size} / ${all.length}`;
  }

  function buildGrid() {
    const collected = getCollectedIds();
    grid.innerHTML = "";
    tiles = [];
    for (const c of all) {
      const found = collected.has(c.id);
      const tile = document.createElement("div");
      tile.className = "collect-tile" + (found ? " found" : "");
      if (found) {
        tile.style.background = `rgba(${RARITY_RGB[c.rarity]},.22)`;
        tile.style.borderColor = `rgba(${RARITY_RGB[c.rarity]},.6)`;
        tile.textContent = c.icon;
        tile.title = `${c.name}\n${RARITY_LABELS[c.rarity]}`;
      } else {
        tile.textContent = "?";
        tile.title = "Not found yet";
      }
      tile.dataset.found = found ? "1" : "0";
      grid.appendChild(tile);
      tiles.push(tile);
    }
  }

  function applyFilter() {
    for (const tile of tiles) {
      const found = tile.dataset.found === "1";
      const visible = filter === "all" || (filter === "found" && found) || (filter === "missing" && !found);
      tile.style.display = visible ? "" : "none";
    }
  }

  function openModal() {
    buildGrid();
    modalProgress.innerHTML = `<b>${getCollectedIds().size}</b> / ${all.length} found`;
    applyFilter();
    modal.classList.add("show");
  }

  btn.addEventListener("click", openModal);
  closeBtn.addEventListener("click", () => modal.classList.remove("show"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("show"); });

  filterButtons.forEach(fb => {
    fb.addEventListener("click", () => {
      filterButtons.forEach(b => b.classList.remove("selected"));
      fb.classList.add("selected");
      filter = fb.dataset.filter;
      applyFilter();
    });
  });

  refreshProgressBadge();
}
