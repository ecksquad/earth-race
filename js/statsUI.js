// Stats & Achievements modal — lifetime totals (see storage.js's getStats())
// plus the fixed achievement list (see achievements.js), locked ones dimmed.

import { getStats, getUnlockedAchievements, getCollectedIds } from "./storage.js";
import { ACHIEVEMENTS } from "./achievements.js";
import { COLLECTABLE_COUNT } from "./collectables.js";

export function initStatsUI() {
  const btn = document.getElementById("stats-btn");
  const modal = document.getElementById("stats-modal");
  const closeBtn = document.getElementById("stats-close");
  const statsGrid = document.getElementById("stats-grid");
  const achList = document.getElementById("achievements-list");
  if (!btn) return;

  function render() {
    const stats = getStats();
    const collected = getCollectedIds().size;
    statsGrid.innerHTML = `
      <div class="stat-tile"><b>${stats.totalKm.toFixed(1)}</b><span>km driven</span></div>
      <div class="stat-tile"><b>${stats.totalRaces}</b><span>races finished</span></div>
      <div class="stat-tile"><b>${stats.totalCrashes}</b><span>crashes</span></div>
      <div class="stat-tile"><b>${Math.round(stats.topSpeedKmh)}</b><span>top km/h</span></div>
      <div class="stat-tile"><b>${collected} / ${COLLECTABLE_COUNT}</b><span>collectables</span></div>
      <div class="stat-tile"><b>${stats.regionsVisited.length}</b><span>regions visited</span></div>
    `;

    const unlocked = getUnlockedAchievements();
    achList.innerHTML = "";
    for (const a of ACHIEVEMENTS) {
      const isUnlocked = unlocked.has(a.id);
      const row = document.createElement("div");
      row.className = "achievement-row" + (isUnlocked ? " unlocked" : "");
      row.innerHTML = `<span class="achievement-icon">${isUnlocked ? a.icon : "🔒"}</span>
        <div><div class="achievement-name">${a.name}</div><div class="achievement-desc">${a.desc}</div></div>`;
      achList.appendChild(row);
    }
  }

  btn.addEventListener("click", () => { render(); modal.classList.add("show"); });
  closeBtn.addEventListener("click", () => modal.classList.remove("show"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("show"); });
}
