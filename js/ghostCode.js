// Compact shareable text codes for a ghost run. There's no server, so "race
// your friend's ghost" works by literally copy-pasting a blob of text —
// coordinates/timings are rounded before encoding to keep it as short as
// something meant to be pasted by hand reasonably can be.

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function encodeGhost({ startLat, startLng, endLat, endLng, timeSeconds, path }) {
  const compact = {
    sLa: round(startLat, 5), sLn: round(startLng, 5),
    eLa: round(endLat, 5), eLn: round(endLng, 5),
    t: round(timeSeconds, 1),
    p: path.map(pt => [round(pt.t, 2), round(pt.x, 1), round(pt.y, 1), round(pt.heading, 3)]),
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(compact))));
}

export function decodeGhost(code) {
  try {
    const compact = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
    if (!compact || !Array.isArray(compact.p) || compact.p.length === 0) return null;
    return {
      startLat: compact.sLa, startLng: compact.sLn,
      endLat: compact.eLa, endLng: compact.eLn,
      timeSeconds: compact.t,
      path: compact.p.map(([t, x, y, heading]) => ({ t, x, y, heading })),
    };
  } catch {
    return null;
  }
}
