import { EARTH_RADIUS, ENGINE_OFF, ENGINE_LIT, Phase, type EngineTimeline, type FlightResult, type Track, type VehicleId } from './sim/types';
import { createTrackSample, sampleTrack } from './sim/sample';
import { rollFromPose } from './attitude-reading';

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
  /** Body +Z roll relative to local down; undefined when the nose is nearly vertical. */
  roll: number | null;
  /** Actual surface angles: forward left/right, aft left/right. */
  aero: [number, number, number, number];
  throttle: number;
  lox: number;
  ch4: number;
  heating: number;
  phase: number;
}

export function emptyReading(): Reading {
  return { ended: false, speed: 0, alt: 0, vspeed: 0, accel: 0, mach: 0, q: 0, pitch: 90, roll: null, aero: [0, 0, 0, 0], throttle: 0, lox: 1, ch4: 1, heating: 0, phase: Phase.Pad };
}
const noSample = emptyReading();

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

/** Fraction of the way from sample i to sample i + 1 at time tc, which is already clamped to the track. */
function sampleFraction(track: Track, i: number, tc: number): number {
  const t0 = track.t[i];
  const t1 = track.t[i + 1] ?? t0;
  return t1 > t0 ? Math.min(1, Math.max(0, (tc - t0) / (t1 - t0))) : 0;
}

/** Everything but the altitude, which needs the whole flight (see readVehicle). */
const readingSample = createTrackSample();
function readTrack(track: Track, t: number, out: Reading): Reading {
  // Reuse the same quaternion interpolation as the rendered vehicle. Interpolating Euler
  // roll samples instead would disagree around ±180° and near a vertical nose.
  const s = sampleTrack(track, t, readingSample);
  out.ended = t > track.end;
  out.speed = s.speed;
  out.vspeed = s.vspeed;
  out.accel = s.accel;
  out.mach = s.mach;
  out.q = s.q;
  out.pitch = s.pitch;
  out.roll = rollFromPose(s.pos, s.quat);
  for (let k = 0; k < 4; k++) out.aero[k] = s.aero[k];
  out.throttle = s.throttle;
  out.lox = s.lox;
  out.ch4 = s.ch4;
  out.heating = s.heating;
  out.phase = s.phase;
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
  const track = vehicle === 'booster' ? result.booster : result.ship;
  if (track.n === 0) {
    const aero = out.aero;
    Object.assign(out, noSample);
    out.aero = aero;
    aero.fill(0);
    out.ended = true;
    return out;
  }
  readTrack(track, t, out);
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

// The split view, as lib/three/stage/index.ts decides it: keep these in step with it.
/** Vehicles this far apart (m, between the middles of their models) are shown side by side. */
const SPLIT_APART = 3000;
/** Between centres of mass instead, the distance can differ by up to half of each vehicle's length (72 m and 52 m). */
const SPLIT_SLACK = 65;
/** A vehicle that splashed down stays in view this long after its track ends, s; one caught or in orbit stays. */
const SPLASHED_IN_VIEW = 45;

function inView(track: Track, t: number): boolean {
  if (t <= track.end) return true;
  return track.endKind === 'catch' || track.endKind === 'orbit' || (track.endKind === 'splashdown' && t < track.end + SPLASHED_IN_VIEW);
}

/** Distance between two vehicles' centres of mass at t, m. */
function distanceBetween(a: Track, b: Track, t: number): number {
  const ta = Math.min(Math.max(t, a.start), a.end);
  const tb = Math.min(Math.max(t, b.start), b.end);
  const i = sampleIndex(a.t, a.n, ta);
  const j = sampleIndex(b.t, b.n, tb);
  const fa = sampleFraction(a, i, ta);
  const fb = sampleFraction(b, j, tb);
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const pa = lerp(a.pos[3 * i + k], a.pos[3 * (i + 1) + k] ?? a.pos[3 * i + k], fa);
    const pb = lerp(b.pos[3 * j + k], b.pos[3 * (j + 1) + k] ?? b.pos[3 * j + k], fb);
    d2 += (pa - pb) * (pa - pb);
  }
  return Math.sqrt(d2);
}

/**
 * Whether the chase and free cameras, following both vehicles, show them side by side at t: from when they are 3 km
 * apart while both are in view. Measured between the centres of mass, it may start a moment early, never late.
 */
export function sideBySide(result: FlightResult, t: number): boolean {
  if (isStacked(result, t) || !inView(result.booster, t) || !inView(result.ship, t)) return false;
  return distanceBetween(result.booster, result.ship, t) >= SPLIT_APART - SPLIT_SLACK;
}

/** The simulation's time step near the ground and in the air, s (lib/sim: stack.ts, booster.ts, ship.ts). */
const SIM_STEP = 0.02;

/**
 * Until when a command can still reach a vehicle, s. The simulation takes no more commands once the vehicle's flight
 * is over: from its end event (down in the water or in the arms, or lost), not the end of its track, which runs on
 * for a tip-over in the water or a few seconds held in the arms. A touchdown is found at the end of a step, so the
 * vehicle may already be down a step earlier: commands in that last step would come too late as well.
 */
export function commandsUntil(result: FlightResult, vehicle: VehicleId): number {
  const key = vehicle === 'booster' ? 'booster-end' : 'ship-end';
  for (const e of result.events) if (e.key === key) return e.t - SIM_STEP;
  return (vehicle === 'booster' ? result.booster : result.ship).end - SIM_STEP;
}

/** Ambient pressure for an altitude (exponential fit, Pa); good enough for visuals. */
export function ambientPressureApprox(altM: number): number {
  return 101325 * Math.exp(-Math.max(0, altM) / 7200);
}
