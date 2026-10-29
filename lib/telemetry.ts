import { ENGINE_OFF, ENGINE_LIT, Phase, type EngineTimeline, type FlightResult, type Track, type VehicleId } from '@/lib/sim/types';

/** One vehicle's HUD values at an instant. */
export interface Reading {
  /** The vehicle's flight has ended (t is past the end of its track). */
  ended: boolean;
  speed: number;
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

export function readTrack(track: Track, t: number, out: Reading): Reading {
  const n = track.n;
  const tc = Math.min(Math.max(t, track.start), track.end);
  const i = sampleIndex(track.t, n, tc);
  const t0 = track.t[i];
  const t1 = track.t[i + 1] ?? t0;
  const f = t1 > t0 ? Math.min(1, Math.max(0, (tc - t0) / (t1 - t0))) : 0;
  out.ended = t > track.end;
  out.speed = lerp(track.speed[i], track.speed[i + 1] ?? track.speed[i], f);
  out.alt = lerp(track.alt[i], track.alt[i + 1] ?? track.alt[i], f);
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

export function readVehicle(result: FlightResult, vehicle: VehicleId, t: number, out: Reading): Reading {
  return readTrack(vehicle === 'booster' ? result.booster : result.ship, t, out);
}

/** Engine states at time t (no allocation when `out` is reused). */
export function engineStates(timeline: EngineTimeline, t: number, out: Uint8Array): Uint8Array {
  out.fill(ENGINE_OFF);
  const changes = timeline.changes;
  for (let k = 0; k < changes.length; k++) {
    const c = changes[k];
    if (c.t > t) break;
    if (c.engine < out.length) out[c.engine] = c.state;
  }
  return out;
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
