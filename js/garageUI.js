// Garage modal: pick a vehicle class (car/bike/truck — same sprite,
// different handling, see car.js's VEHICLE_CLASSES) and a skin (a CSS filter
// applied to that same sprite — see drive.js's SKIN_FILTERS). Skins unlock
// via achievements; locked ones show a lock and which achievement grants them.

import { VEHICLE_CLASSES } from "./car.js";
import { getGarage, setGarage, getUnlockedAchievements } from "./storage.js";
import { ACHIEVEMENTS } from "./achievements.js";

const SKIN_LABELS = {
  default: "Default", gold: "Gold", prismatic: "Prismatic",
  chrome: "Chrome", "matte-black": "Matte Black", flame: "Flame",
};

// Bike/truck exist as tuned handling profiles (see car.js's VEHICLE_CLASSES)
// but aren't released yet — shown so people know they're coming, not
// selectable so nobody's mid-race handling changes out from under them
// later when they do actually ship.
const RELEASED_VEHICLE_CLASSES = ["car"];

export function initGarageUI() {
  const btn = document.getElementById("garage-btn");
  const modal = document.getElementById("garage-modal");
  const closeBtn = document.getElementById("garage-close");
  const classesEl = document.getElementById("garage-classes");
  const skinsEl = document.getElementById("garage-skins");
  if (!btn) return;

  function render() {
    const garage = getGarage();
    const unlocked = getUnlockedAchievements();

    classesEl.innerHTML = "";
    for (const [id, vc] of Object.entries(VEHICLE_CLASSES)) {
      const isReleased = RELEASED_VEHICLE_CLASSES.includes(id);
      const card = document.createElement("button");
      card.className = "garage-option" + (garage.vehicleClass === id ? " selected" : "") + (isReleased ? "" : " locked");
      if (isReleased) {
        card.innerHTML = `<div class="garage-option-title">${vc.label}</div>
          <div class="garage-option-sub">speed ${Math.round(vc.speedMul * 100)}% · accel ${Math.round(vc.accelMul * 100)}% · turn ${Math.round(vc.turnMul * 100)}%</div>`;
        card.addEventListener("click", () => { setGarage({ vehicleClass: id }); render(); });
      } else {
        card.innerHTML = `<div class="garage-option-title">🚧 ${vc.label}</div>
          <div class="garage-option-sub">Coming soon</div>`;
        card.disabled = true;
      }
      classesEl.appendChild(card);
    }

    skinsEl.innerHTML = "";
    for (const skinId of garage.unlockedSkins.length ? Object.keys(SKIN_LABELS) : ["default"]) {
      const isUnlocked = garage.unlockedSkins.includes(skinId);
      const card = document.createElement("button");
      card.className = "garage-option" + (garage.skin === skinId ? " selected" : "") + (isUnlocked ? "" : " locked");
      if (isUnlocked) {
        card.innerHTML = `<div class="garage-option-title">${SKIN_LABELS[skinId]}</div>`;
        card.addEventListener("click", () => { setGarage({ skin: skinId }); render(); });
      } else {
        const unlockedBy = ACHIEVEMENTS.find(a => a.skin === skinId);
        card.innerHTML = `<div class="garage-option-title">🔒 ${SKIN_LABELS[skinId]}</div>
          <div class="garage-option-sub">${unlockedBy ? `Unlock: ${unlockedBy.name}` : "Locked"}</div>`;
        card.disabled = true;
      }
      skinsEl.appendChild(card);
    }
  }

  btn.addEventListener("click", () => { render(); modal.classList.add("show"); });
  closeBtn.addEventListener("click", () => modal.classList.remove("show"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("show"); });
}
