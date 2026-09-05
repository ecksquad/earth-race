// Fixed achievement definitions + the pure function that decides which ones
// a given stats snapshot satisfies. Persistence (which ids are already
// unlocked) lives in storage.js; this module only knows the rules.

export const ACHIEVEMENTS = [
  { id: "first_finish", name: "First Finish", icon: "🏁", desc: "Complete your first race.", skin: null },
  { id: "century_club", name: "Century Club", icon: "💯", desc: "Find 100 collectables.", skin: null },
  { id: "legend_hunter", name: "Legend Hunter", icon: "👑", desc: "Find all 10 legendary collectables.", skin: "gold" },
  { id: "completionist", name: "Completionist", icon: "🌍", desc: "Find all 1000 collectables.", skin: "prismatic" },
  { id: "road_warrior", name: "Road Warrior", icon: "🛣️", desc: "Drive 1000km lifetime.", skin: null },
  { id: "globe_trotter", name: "Globe Trotter", icon: "🌐", desc: "Finish races starting on 4 different continents.", skin: "chrome" },
  { id: "crash_test_dummy", name: "Crash Test Dummy", icon: "💥", desc: "Crash 10 times.", skin: null },
  { id: "speed_demon", name: "Speed Demon", icon: "⚡", desc: "Hit 250 km/h.", skin: "matte-black" },
  { id: "drift_king", name: "Drift King", icon: "🌀", desc: "Hold a drift for 3 seconds straight.", skin: null },
  { id: "nitro_addict", name: "Nitro Addict", icon: "🚀", desc: "Use 20 nitro boosts.", skin: "flame" },
];

const BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));
export function getAchievement(id) { return BY_ID[id]; }

// Returns the ids of achievements `stats`/`collectedCount` now satisfy —
// callers still need to check against already-unlocked ids themselves
// (see storage.js's unlockAchievement, which reports true only the first time).
export function checkAchievements(stats, collectedCount, legendaryCount) {
  const earned = [];
  if (stats.totalRaces >= 1) earned.push("first_finish");
  if (collectedCount >= 100) earned.push("century_club");
  if (legendaryCount >= 10) earned.push("legend_hunter");
  if (collectedCount >= 1000) earned.push("completionist");
  if (stats.totalKm >= 1000) earned.push("road_warrior");
  if (stats.regionsVisited.length >= 4) earned.push("globe_trotter");
  if (stats.totalCrashes >= 10) earned.push("crash_test_dummy");
  if (stats.topSpeedKmh >= 250) earned.push("speed_demon");
  if (stats.maxDriftSeconds >= 3) earned.push("drift_king");
  if (stats.nitroUses >= 20) earned.push("nitro_addict");
  return earned;
}
