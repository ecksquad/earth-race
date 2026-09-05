// Simple AI traffic: each bot follows a road segment at a steady cruising
// speed, and continues onto whichever segment is nearest once it reaches the
// end of the current one. roads.js only exposes flat line segments per tile,
// not a connected routing graph, so this is "looks alive" wandering rather
// than real pathfinding — good enough for ambient traffic.

// Bots drive offset to one side of the road centerline instead of straight
// down the middle of it — a fixed lane, not a real left/right-hand-traffic
// simulation (that would need per-country data OSM doesn't give us cheaply),
// but enough that the other side of the road reads as open space to pass
// through instead of every bot sitting exactly on your racing line.
export const LANE_OFFSET_M = 1.8;

export function botWorldPos(bot) {
  const rightX = Math.cos(bot.heading), rightY = -Math.sin(bot.heading);
  return { x: bot.x + rightX * LANE_OFFSET_M, y: bot.y + rightY * LANE_OFFSET_M };
}

const BOT_SPEED_MIN = 8;  // m/s (~29 km/h)
const BOT_SPEED_MAX = 16; // m/s (~58 km/h)
const BOT_ACCEL = 6;      // m/s^2, easing toward cruising speed
export const BOT_COUNT = 14;
export const BOT_RADIUS_M = 0.9; // bot half-width for collision against the player — real car half-width, not half-length
const BOT_RESPAWN_DIST_M = 600; // beyond this from the player, recycle the bot near them instead — must
                                 // stay comfortably above BOT_SPAWN_MAX_DIST_M or a freshly (re)spawned
                                 // bot could immediately qualify for another recycle next frame
const BOT_SPAWN_MIN_DIST_M = 200; // never spawn/recycle closer than this — otherwise a bot can
const BOT_SPAWN_MAX_DIST_M = 450; // materialize right on top of the player, hidden under their own sprite

function randomOffset(x, y, minDist, maxDist) {
  const angle = Math.random() * Math.PI * 2;
  const dist = minDist + Math.random() * (maxDist - minDist);
  return { x: x + Math.cos(angle) * dist, y: y + Math.sin(angle) * dist };
}

// Always the geometrically NEAREST segment to (x, y) — never a random pick.
// nearbySegments() returns everything in a whole 3x3-tile block (up to ~6.6km
// across) with no spatial ordering; picking randomly among those (or even
// among a "close enough" subset that falls back to the full list when empty,
// which is common wherever road segments are longer than that radius apart —
// i.e. most rural/suburban roads) let a bot "continuing onto the next
// segment" jump anywhere in that block. That caused both the original
// invisible-bot-crash bug and bots visibly popping in and out of view during
// ordinary driving. Nearest-only guarantees the jump is never more than the
// true nearest-road distance, which can never be an arbitrary cross-map leap.
// `excludeSeg` skips the segment the bot is already on, so finishing a
// segment can't just re-pick the same one (distance 0 back to itself) and
// sit there forever.
function pickSegmentNear(roadData, x, y, excludeSeg) {
  const segs = roadData.nearbySegments(x, y);
  let best = null, bestDist = Infinity;
  for (const seg of segs) {
    if (seg === excludeSeg) continue;
    const d = Math.min(Math.hypot(seg.x1 - x, seg.y1 - y), Math.hypot(seg.x2 - x, seg.y2 - y));
    if (d < bestDist) { bestDist = d; best = seg; }
  }
  return best;
}

function segmentHeading(seg, dir) {
  const dx = (seg.x2 - seg.x1) * dir, dy = (seg.y2 - seg.y1) * dir;
  return Math.atan2(dx, dy); // same convention as car.js: heading 0 = +y (north)
}

// Places the bot at whichever endpoint of `seg` is closer to (nearX, nearY),
// heading toward the far endpoint.
function initOnSegment(seg, nearX, nearY, speedTarget, accel) {
  const d1 = Math.hypot(seg.x1 - nearX, seg.y1 - nearY);
  const d2 = Math.hypot(seg.x2 - nearX, seg.y2 - nearY);
  const dir = d1 <= d2 ? 1 : -1;
  return {
    x: dir === 1 ? seg.x1 : seg.x2,
    y: dir === 1 ? seg.y1 : seg.y2,
    heading: segmentHeading(seg, dir),
    speed: 0,
    speedTarget, accel,
    seg, dir, t: 0,
    speedBoost: 0, reactionCooldown: 0,
    // Deliberately NOT included here: totalDistanceM. This object gets
    // Object.assign'd onto an existing bot every time it continues onto a
    // new segment (see stepBot) — if totalDistanceM were set here, every
    // segment change would reset it to 0. Leaving it out means Object.assign
    // never touches it, so it accumulates across a bot's whole lifetime
    // (used by Grand Prix mode's lap counting, see drive.js).
  };
}

const SPAWN_ATTEMPTS = 6;

// randomOffset() only bounds the anchor point `p` — initOnSegment() then
// snaps to the nearest ENDPOINT of whatever segment pickSegmentNear() finds
// near p, and OSM way segments can be long, so that endpoint can land much
// closer to (refX, refY) than p ever was (occasionally right on top of the
// player, appearing with zero warning — a bot that "wasn't there" the frame
// before). Retry a few times against the real reference point before giving
// up and parking off-road, rather than trusting p's distance alone.
function spawnAwayFrom(roadData, refX, refY, speedTarget, accel) {
  let lastP = null;
  for (let i = 0; i < SPAWN_ATTEMPTS; i++) {
    const p = randomOffset(refX, refY, BOT_SPAWN_MIN_DIST_M, BOT_SPAWN_MAX_DIST_M);
    lastP = p;
    const seg = pickSegmentNear(roadData, p.x, p.y);
    if (!seg) continue;
    const bot = initOnSegment(seg, p.x, p.y, speedTarget, accel);
    bot.totalDistanceM = 0;
    if (Math.hypot(bot.x - refX, bot.y - refY) >= BOT_SPAWN_MIN_DIST_M) return bot;
  }
  return {
    x: lastP.x, y: lastP.y, heading: 0, speed: 0, speedTarget, accel, seg: null, dir: 1, t: 0,
    speedBoost: 0, reactionCooldown: 0, totalDistanceM: 0,
  };
}

// `speedMul` scales the whole BOT_SPEED_MIN..MAX cruising range — Grand Prix
// mode (see drive.js) uses this to make racer bots feel like actual
// competitors instead of ambient traffic, without needing a second AI system.
export function spawnBots(roadData, aroundX, aroundY, count = BOT_COUNT, speedMul = 1) {
  const bots = [];
  for (let i = 0; i < count; i++) {
    const speedTarget = (BOT_SPEED_MIN + Math.random() * (BOT_SPEED_MAX - BOT_SPEED_MIN)) * speedMul;
    bots.push(spawnAwayFrom(roadData, aroundX, aroundY, speedTarget, BOT_ACCEL));
  }
  return bots;
}

// How bots notice the player: this is deliberately NOT lane-based overtaking
// (bots and the player share a single centerline per road, so there's no
// lateral offset to actually pull into) — it's a lighter "personality" layer
// on top of the existing follow-the-segment driving: honk / brake-tap / speed
// up when the player is closing in tight from behind, on a cooldown so one
// tailgate doesn't spam three reactions in three frames.
const TAILGATE_DIST_M = 14;
const TAILGATE_COOLDOWN_S = 5;
const SPEED_BOOST_DECAY_TAU_S = 0.6;

function maybeReact(bot, dt, player) {
  bot.reactionCooldown = Math.max(0, bot.reactionCooldown - dt);
  if (bot.reactionCooldown > 0 || !player) return false;

  const pos = botWorldPos(bot);
  const dist = Math.hypot(pos.x - player.x, pos.y - player.y);
  if (dist > TAILGATE_DIST_M) return false;

  // Is the player behind the bot? Project (player - bot) onto the bot's own
  // facing direction — negative means the player is on the bot's tail.
  const facingX = Math.sin(bot.heading), facingY = Math.cos(bot.heading);
  const forwardDot = facingX * (player.x - pos.x) + facingY * (player.y - pos.y);
  if (forwardDot > -1) return false;
  if (player.speed <= bot.speed + 2) return false; // only react when actually closing in

  bot.reactionCooldown = TAILGATE_COOLDOWN_S;
  const roll = Math.random();
  if (roll < 0.15) bot.speedBoost = -4;      // brake-tap
  else if (roll < 0.35) bot.speedBoost = 3;  // speeds up to clear out of the way
  return true; // honk, regardless of which (or neither) speed reaction fired
}

// Road tiles are only ever loaded around the player (see roads.js), so a bot
// left behind as the player drives on has nothing new nearby to wander onto.
// Rather than let it sit frozen, recycle it onto a fresh nearby segment near
// the player — this is what makes traffic appear throughout a long route
// instead of only near the start.
export function stepBots(bots, roadData, dt, playerPos, playerSpeed) {
  let honks = 0;
  const player = playerPos ? { x: playerPos.x, y: playerPos.y, speed: playerSpeed ?? 0 } : null;
  for (const bot of bots) {
    if (playerPos && Math.hypot(bot.x - playerPos.x, bot.y - playerPos.y) > BOT_RESPAWN_DIST_M) {
      Object.assign(bot, spawnAwayFrom(roadData, playerPos.x, playerPos.y, bot.speedTarget, bot.accel));
      continue;
    }
    if (maybeReact(bot, dt, player)) honks++;
    stepBot(bot, roadData, dt);
  }
  return honks > 0;
}

function stepBot(bot, roadData, dt) {
  if (bot.speedBoost !== 0) bot.speedBoost *= Math.exp(-dt / SPEED_BOOST_DECAY_TAU_S);

  if (!bot.seg) {
    // Spawned before any road tile was loaded nearby — keep trying.
    const seg = pickSegmentNear(roadData, bot.x, bot.y);
    if (seg) Object.assign(bot, initOnSegment(seg, bot.x, bot.y, bot.speedTarget, bot.accel));
    return;
  }

  const diff = (bot.speedTarget + bot.speedBoost) - bot.speed;
  bot.speed += Math.sign(diff) * Math.min(Math.abs(diff), bot.accel * dt);
  bot.totalDistanceM = (bot.totalDistanceM || 0) + Math.abs(bot.speed) * dt;

  const seg = bot.seg;
  const x1 = bot.dir === 1 ? seg.x1 : seg.x2, y1 = bot.dir === 1 ? seg.y1 : seg.y2;
  const x2 = bot.dir === 1 ? seg.x2 : seg.x1, y2 = bot.dir === 1 ? seg.y2 : seg.y1;
  const segLen = Math.hypot(x2 - x1, y2 - y1) || 1;
  bot.t += (bot.speed * dt) / segLen;

  if (bot.t >= 1) {
    const next = pickSegmentNear(roadData, x2, y2, seg);
    if (next) Object.assign(bot, initOnSegment(next, x2, y2, bot.speedTarget, bot.accel));
    else bot.t = 1; // stuck at the end until a nearby segment loads
    return;
  }

  bot.x = x1 + (x2 - x1) * bot.t;
  bot.y = y1 + (y2 - y1) * bot.t;
  bot.heading = segmentHeading(seg, bot.dir);
}
