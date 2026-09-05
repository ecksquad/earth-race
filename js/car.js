// Arcade car physics: pure state + math, no DOM/canvas. Position/velocity are
// in the same local meters space as roads.js. Heading 0 = facing +y (north).

export const MAX_SPEED_ON_ROAD = 83.33; // m/s (300 km/h)
export const MAX_SPEED_OFF_ROAD = 8.33; // m/s (30 km/h) — the "damage" slowdown
const REVERSE_FRACTION = 0.4;
const ACCEL_ON_ROAD = 37.5;            // m/s^2
const ACCEL_OFF_ROAD = 5;
// Speed-proportional drag; steady-state top speed under full throttle is
// ACCEL_*_ROAD / DRAG_*_ROAD, which must land near the matching MAX_SPEED_*
// or the car plateaus well short of the nominal cap long before reaching it.
const DRAG_ON_ROAD = ACCEL_ON_ROAD / MAX_SPEED_ON_ROAD;
const DRAG_OFF_ROAD = ACCEL_OFF_ROAD / MAX_SPEED_OFF_ROAD;
const FRICTION = 6;                    // m/s^2, applied when coasting (no throttle)
const TURN_RATE = 2.6;                 // rad/s at full steer and speed

// Drift: normally the car's actual travel direction snaps onto wherever it's
// pointed almost instantly (GRIP_RATE is huge relative to TURN_RATE). Steering
// hard at speed while off the throttle cuts that grip way down, so travel
// direction lags behind the facing direction instead — the car slides through
// the turn nose-first, then hooks back in line once you're back on the gas
// or off the wheel. MAX_DRIFT_ANGLE caps how far that slip can build up so a
// sustained hard drift settles into a steady slide instead of spinning out.
const GRIP_RATE = 14;                          // rad/s, travel-direction catch-up rate at full grip
const MAX_DRIFT_ANGLE = 55 * Math.PI / 180;    // cap on how far travel direction can lag facing direction
// Drift intensity is scaled against a realistic cornering speed, NOT MAX_SPEED_ON_ROAD (300 km/h) —
// scaling against the car's top speed made any normal 40-80 km/h corner only 15-25% "fast enough",
// so the effect rounded down to nothing. 12 m/s (~43 km/h) is a speed you'd actually brake for a corner at.
const DRIFT_SPEED_REF = 12; // m/s
const HANDBRAKE_DECEL = 14; // m/s^2 extra deceleration while the handbrake is held

// Vehicle classes reuse the same sprite (tinted/rescaled in drive.js) with
// different handling stats — a cheap way to get a "bike" and "truck" without
// new art. Multipliers apply on top of the car/road-surface constants above.
export const VEHICLE_CLASSES = {
  car: { label: "Car", speedMul: 1, accelMul: 1, turnMul: 1, spriteScale: 1 },
  bike: { label: "Bike", speedMul: 1.05, accelMul: 1.35, turnMul: 1.5, spriteScale: 0.6 },
  truck: { label: "Truck", speedMul: 0.72, accelMul: 0.55, turnMul: 0.65, spriteScale: 1.7 },
};

const NITRO_ACCEL_MUL = 1.8;
const NITRO_SPEED_MUL = 1.35;

function normalizeAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function createCar(x, y, headingRad = 0) {
  return { x, y, heading: headingRad, velHeading: headingRad, speed: 0, nitroTime: 0 };
}

export function giveNitro(car, seconds) {
  car.nitroTime = Math.max(car.nitroTime, seconds);
}

export function stepCar(car, input, dt, onRoad, vehicleClass = "car") {
  const vc = VEHICLE_CLASSES[vehicleClass] || VEHICLE_CLASSES.car;
  const nitro = car.nitroTime > 0;
  if (nitro) car.nitroTime = Math.max(0, car.nitroTime - dt);

  const maxSpeed = (onRoad ? MAX_SPEED_ON_ROAD : MAX_SPEED_OFF_ROAD) * vc.speedMul * (nitro ? NITRO_SPEED_MUL : 1);
  const accel = (onRoad ? ACCEL_ON_ROAD : ACCEL_OFF_ROAD) * vc.accelMul * (nitro ? NITRO_ACCEL_MUL : 1);
  const drag = (onRoad ? DRAG_ON_ROAD : DRAG_OFF_ROAD) * vc.speedMul; // keep steady-state top speed matching maxSpeed

  if (input.throttle !== 0) {
    car.speed += input.throttle * accel * dt;
  } else if (car.speed !== 0) {
    const dec = Math.sign(car.speed) * FRICTION * dt;
    car.speed = Math.abs(dec) >= Math.abs(car.speed) ? 0 : car.speed - dec;
  }
  if (input.handbrake && car.speed !== 0) {
    const dec = Math.sign(car.speed) * HANDBRAKE_DECEL * dt;
    car.speed = Math.abs(dec) >= Math.abs(car.speed) ? 0 : car.speed - dec;
  }
  car.speed -= car.speed * drag * dt;

  const maxReverse = maxSpeed * REVERSE_FRACTION;
  car.speed = Math.max(-maxReverse, Math.min(maxSpeed, car.speed));

  if (Math.abs(car.speed) > 0.05) {
    const dir = car.speed >= 0 ? 1 : -1;
    car.heading += input.steer * TURN_RATE * vc.turnMul * dt * dir;
  }

  const speedFactor = Math.min(1, Math.abs(car.speed) / DRIFT_SPEED_REF);
  // Handbrake locks the rear wheels regardless of throttle — always maximum
  // drift bias while held, same as a real handbrake turn.
  const brakeFactor = input.handbrake ? 1 : input.throttle < 0 ? 1 : input.throttle === 0 ? 0.85 : 0;
  const driftIntensity = Math.abs(input.steer) * speedFactor * brakeFactor;
  const catchUpRate = GRIP_RATE * Math.max(0.06, 1 - driftIntensity); // never fully zero, so it always recovers

  let diff = normalizeAngle(car.heading - car.velHeading);
  const maxCatch = catchUpRate * dt;
  car.velHeading += Math.abs(diff) <= maxCatch ? diff : Math.sign(diff) * maxCatch;

  diff = normalizeAngle(car.heading - car.velHeading);
  if (Math.abs(diff) > MAX_DRIFT_ANGLE) {
    car.velHeading = car.heading - Math.sign(diff) * MAX_DRIFT_ANGLE;
  }

  car.x += Math.sin(car.velHeading) * car.speed * dt;
  car.y += Math.cos(car.velHeading) * car.speed * dt;
}
