// Optional shared-world multiplayer: every driving player periodically
// broadcasts their real lat/lng/heading/speed to a Firebase Realtime
// Database "players" node, and everyone else's positions stream back — so
// you can encounter other real people driving anywhere on Earth, not just
// ambient bot traffic. Entirely client-side: Firebase's SDK talks straight
// to Google's servers over the internet, so this needs no server of its own
// to run or host, on GitHub Pages or anywhere else.
//
// Gracefully does nothing (every export becomes a safe no-op) if
// firebaseConfig.js hasn't been filled in, so the rest of the game works
// fine without it.

import { firebaseConfig } from "./firebaseConfig.js";

const FIREBASE_SDK_VERSION = "10.14.1";
const BROADCAST_INTERVAL_MS = 300;
const STALE_AFTER_MS = 15000; // drop a player client-side if onDisconnect didn't fire (abrupt network loss/crash)
const PLAYER_ID_KEY = "earthrace.playerId";
const PLAYER_NAME_KEY = "earthrace.playerName";

let dbApi = null; // the imported firebase-database module, once loaded
let db = null;
let playerRef = null;
let playerId = null;
let others = new Map(); // id -> {lat,lng,heading,speed,name,ts}
let broadcastTimer = null;
let connected = false;

function isConfigured() {
  return !!(firebaseConfig && firebaseConfig.databaseURL);
}

function getPlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = "p" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

export function getPlayerName() {
  return localStorage.getItem(PLAYER_NAME_KEY) || "";
}

export function setPlayerName(name) {
  localStorage.setItem(PLAYER_NAME_KEY, name);
}

export function isMultiplayerAvailable() {
  return isConfigured();
}

let connectPromise = null;

// Connects once for the whole app session (not per-race) so the "online
// now" count works even on the picker screen. Safe to call multiple times —
// only the first call does anything.
export function connect() {
  if (!isConfigured()) return Promise.resolve(false);
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const [{ initializeApp }, dbModule] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-database.js`),
    ]);
    dbApi = dbModule;
    const app = initializeApp(firebaseConfig);
    db = dbApi.getDatabase(app);

    playerId = getPlayerId();
    playerRef = dbApi.ref(db, `players/${playerId}`);

    const playersRef = dbApi.ref(db, "players");
    dbApi.onValue(playersRef, (snapshot) => {
      const val = snapshot.val() || {};
      const now = Date.now();
      others.clear();
      for (const [id, p] of Object.entries(val)) {
        if (id === playerId || !p || now - p.ts > STALE_AFTER_MS) continue;
        others.set(id, p);
      }
    });

    connected = true;
    return true;
  })().catch(err => {
    console.warn("Multiplayer connect failed", err);
    return false;
  });

  return connectPromise;
}

export function isConnected() {
  return connected;
}

// Starts periodically writing this player's live position — only call this
// while actually driving (there's no meaningful "position" on the picker
// screen). getState should return {lat, lng, heading, speed} or null.
export function startBroadcasting(getState) {
  if (!connected || broadcastTimer) return;
  dbApi.onDisconnect(playerRef).remove(); // clean up automatically on tab close/crash
  broadcastTimer = setInterval(() => {
    const s = getState();
    if (!s) return;
    dbApi.set(playerRef, {
      lat: s.lat, lng: s.lng, heading: s.heading, speed: s.speed,
      name: getPlayerName() || "Driver", ts: Date.now(),
    });
  }, BROADCAST_INTERVAL_MS);
}

export function stopBroadcasting() {
  if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null; }
  if (connected && playerRef) dbApi.remove(playerRef).catch(() => {});
}

// Other currently-online players (never includes yourself), each
// {lat, lng, heading, speed, name, ts}. Callers project lat/lng into
// whatever local frame they need (see roads.js's project()) — positions here
// are always real-world coordinates, not tied to any one race's local origin.
export function getOthers() {
  return others;
}

export function getOnlineCount() {
  return others.size + (broadcastTimer ? 1 : 0);
}
