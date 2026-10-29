import { EARTH_RADIUS, ENGINE_OFF, ENGINE_LIT, Phase, type EngineTimeline, type FlightResult, type Track, type VehicleId } from './sim/types';

/** One vehicle's HUD values at an instant. */
export interface Reading {
  /** The vehicle's flight has ended (t is past the end of its track). */
  ended: boolean;
  speed: number;
  /** HUD altitude of the vehicle's base, m: above the launch mount's deck near the pad, above the sea elsewhere. */
  alt: number;
  vspeed: number;
  accel: number;
  mach: number;
  q: number;
  pitch: number;
  throttle: number;
  lox: number;
  ch4: number;
  heating: number;
  phase: number;
}

export function emptyReading(): Reading {
  return { ended: false, speed: 0, alt: 0, vspeed: 0, accel: 0, mach: 0, q: 0, pitch: 90, throttle: 0, lox: 1, ch4: 1, heating: 0, phase: Phase.Pad };
}

/** Largest index i with times[i] <= t, clamped to [0, n - 2] so i + 1 is valid. */
export function sampleIndex(times: Float64Array, n: number, t: number): number {
  if (n < 2 || t <= times[0]) return 0;
  if (t >= times[n - 1]) return n - 2;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Interpolate an angle in degrees the short way round, result in (-180, 180]. */
function lerpAngle(a: number, b: number, f: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  let r = a + d * f;
  if (r > 180) r -= 360;
  else if (r <= -180) r += 360;
  return r;
}

/** Fraction of the way from sample i to sample i + 1 at time tc, which is already clamped to the track. */
function sampleFraction(track: Track, i: number, tc: number): number {
  const t0 = track.t[i];
  const t1 = track.t[i + 1] ?? t0;
  return t1 > t0 ? Math.min(1, Math.max(0, (tc - t0) / (t1 - t0))) : 0;
}

/** Everything but the altitude, which needs the whole flight (see readVehicle). */
function readTrack(track: Track, t: number, out: Reading): Reading {
  const n = track.n;
  const tc = Math.min(Math.max(t, track.start), track.end);
  const i = sampleIndex(track.t, n, tc);
  const f = sampleFraction(track, i, tc);
  out.ended = t > track.end;
  out.speed = lerp(track.speed[i], track.speed[i + 1] ?? track.speed[i], f);
  out.vspeed = lerp(track.vspeed[i], track.vspeed[i + 1] ?? track.vspeed[i], f);
  out.accel = lerp(track.accel[i], track.accel[i + 1] ?? track.accel[i], f);
  out.mach = lerp(track.mach[i], track.mach[i + 1] ?? track.mach[i], f);
  out.q = lerp(track.q[i], track.q[i + 1] ?? track.q[i], f);
  out.pitch = lerpAngle(track.pitch[i], track.pitch[i + 1] ?? track.pitch[i], f);
  out.throttle = lerp(track.throttle[i], track.throttle[i + 1] ?? track.throttle[i], f);
  out.lox = lerp(track.lox[i], track.lox[i + 1] ?? track.lox[i], f);
  out.ch4 = lerp(track.ch4[i], track.ch4[i + 1] ?? track.ch4[i], f);
  out.heating = lerp(track.heating[i], track.heating[i + 1] ?? track.heating[i], f);
  out.phase = track.phase[f < 1 ? i : Math.min(n - 1, i + 1)];
  return out;
}

/** Height of the vehicle's base (its engine plane) above the sea-level sphere at sample i, m. */
function baseAltitude(track: Track, i: number): number {
  const qx = track.quat[4 * i];
  const qy = track.quat[4 * i + 1];
  const qz = track.quat[4 * i + 2];
  const qw = track.quat[4 * i + 3];
  const px = track.pos[3 * i];
  const py = track.pos[3 * i + 1];
  const pz = track.pos[3 * i + 2];
  // Body +Y (base to nose) in ECEF, dotted with the local vertical: 1 nose up, 0 level, -1 nose down.
  const up = (2 * (qx * qy - qz * qw) * px + (1 - 2 * (qx * qx + qz * qz)) * py + 2 * (qy * qz + qx * qw) * pz) / Math.hypot(px, py, pz);
  return track.alt[i] - track.com[i] * up;
}

/** Ground distance from sample i of a track to where the booster stood on the launch mount, m (chord; only short distances matter). */
function distanceFromMount(track: Track, i: number, booster: Track): number {
  const px = track.pos[3 * i];
  const py = track.pos[3 * i + 1];
  const pz = track.pos[3 * i + 2];
  const r = Math.hypot(px, py, pz);
  const mx = booster.pos[0];
  const my = booster.pos[1];
  const mz = booster.pos[2];
  const rm = Math.hypot(mx, my, mz);
  return EARTH_RADIUS * Math.hypot(px / r - mx / rm, py / r - my / rm, pz / r - mz / rm);
}

/** Near the launch mount altitude is measured from its deck; this far away (m) from sea level, blending in between. */
const MOUNT_NEAR = 2000;
const MOUNT_FAR = 5000;

/**
 * Altitude as the HUD shows it: the height of the vehicle's base above the water, or above the launch mount's deck
 * while it is near the pad. Like the webcast it reads 0 on the mount at liftoff, and it reaches 0 when the vehicle
 * touches the water rather than when its centre of mass gets as low as it was on the pad.
 */
function hudAltitude(track: Track, booster: Track, t: number): number {
  const tc = Math.min(Math.max(t, track.start), track.end);
  const i = sampleIndex(track.t, track.n, tc);
  const j = Math.min(i + 1, track.n - 1);
  const f = sampleFraction(track, i, tc);
  const base = lerp(baseAltitude(track, i), baseAltitude(track, j), f);
  const d = lerp(distanceFromMount(track, i, booster), distanceFromMount(track, j, booster), f);
  const x = Math.min(1, Math.max(0, (d - MOUNT_NEAR) / (MOUNT_FAR - MOUNT_NEAR)));
  const deck = baseAltitude(booster, 0) * (1 - x * x * (3 - 2 * x));
  return Math.max(0, base - deck);
}

export function readVehicle(result: FlightResult, vehicle: VehicleId, t: number, out: Reading): Reading {
  readTrack(vehicle === 'booster' ? result.booster : result.ship, t, out);
  // While stacked both vehicles report the stack's altitude, which is the booster's.
  out.alt = hudAltitude(vehicle === 'ship' && !isStacked(result, t) ? result.ship : result.booster, result.booster, t);
  return out;
}

/** How many of the timeline's engine changes have happened by time t. Equal counts mean equal engine states. */
export function engineChangesBy(timeline: EngineTimeline, t: number): number {
  const changes = timeline.changes;
  let lo = 0;
  let hi = changes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (changes[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Engine states once the first `count` changes have happened (no allocation when `out` is reused). */
export function engineStatesAfter(timeline: EngineTimeline, count: number, out: Uint8Array): Uint8Array {
  out.fill(ENGINE_OFF);
  const changes = timeline.changes;
  for (let k = 0; k < count; k++) {
    const c = changes[k];
    if (c.engine < out.length) out[c.engine] = c.state;
  }
  return out;
}

/** Engine states at time t (no allocation when `out` is reused). */
export function engineStates(timeline: EngineTimeline, t: number, out: Uint8Array): Uint8Array {
  return engineStatesAfter(timeline, engineChangesBy(timeline, t), out);
}

export function countLit(states: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < states.length; i++) if (states[i] === ENGINE_LIT) n++;
  return n;
}

/** True while the stack is still one vehicle. */
export function isStacked(result: FlightResult, t: number): boolean {
  return result.separationT === null || t < result.separationT;
}

/** Ambient pressure for an altitude (exponential fit, Pa); good enough for visuals. */
export function ambientPressureApprox(altM: number): number {
  return 101325 * Math.exp(-Math.max(0, altM) / 7200);
}
