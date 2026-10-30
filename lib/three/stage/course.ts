import type { Track } from '@/lib/sim/types';
// Relative so the course can be unit tested (vitest has no @/ alias).
import { sampleIndex } from '../../telemetry';
import type { V3 } from './geo';

/** Below this horizontal speed (m/s) the heading means nothing (on the pad, hovering, flipping): it is held. */
const HOLD_SPEED = 20;
/** From this horizontal speed on, the heading follows the velocity fully. */
const FOLLOW_SPEED = 120;
/** How quickly the heading turns to follow the velocity (seconds of flight time). */
const FOLLOW_TAU = 1.5;

/** Horizontal velocity at one sample (x, y, z) and its length. */
const hv = new Float64Array(4);

function horizontal(p: Float64Array, v: Float64Array, i: number): void {
  const r = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) || 1;
  const ux = p[i * 3] / r;
  const uy = p[i * 3 + 1] / r;
  const uz = p[i * 3 + 2] / r;
  const vu = v[i * 3] * ux + v[i * 3 + 1] * uy + v[i * 3 + 2] * uz;
  hv[0] = v[i * 3] - vu * ux;
  hv[1] = v[i * 3 + 1] - vu * uy;
  hv[2] = v[i * 3 + 2] - vu * uz;
  hv[3] = Math.hypot(hv[0], hv[1], hv[2]);
}

function smoothstep(a: number, b: number, x: number): number {
  const k = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return k * k * (3 - 2 * k);
}

/**
 * Where a vehicle is heading over the ground, for cameras that frame it from the side: one horizontal unit vector
 * per sample (x, y, z interleaved), made once per result so a camera's place is a pure function of time.
 *
 * It is the horizontal part of the velocity, smoothed, and held while the vehicle moves too slowly over the ground
 * for that to mean anything (on the pad, climbing straight up, flipping, hovering, floating). It never reverses:
 * when the vehicle turns back (the booster's boostback) it keeps pointing the way it was, so a camera beside the
 * vehicle stays on the same side of it. Before the vehicle first gets going it already points where it will go.
 */
export function computeCourse(track: Track): Float32Array {
  const n = track.n;
  const out = new Float32Array(n * 3);
  const p = track.pos;
  const v = track.vel;
  // Start from the heading at the first sample that moves fast enough over the ground; a vehicle that never
  // does (an abort on the pad) faces east.
  let first = -1;
  for (let i = 0; i < n && first < 0; i++) {
    horizontal(p, v, i);
    if (hv[3] >= FOLLOW_SPEED) first = i;
  }
  let cx = 1;
  let cy = 0;
  let cz = 0;
  if (first >= 0) {
    cx = hv[0] / hv[3];
    cy = hv[1] / hv[3];
    cz = hv[2] / hv[3];
  } else if (n > 0 && Math.hypot(p[0], p[1]) > 1) {
    const r = Math.hypot(p[0], p[1]);
    cx = -p[1] / r;
    cy = p[0] / r;
  }
  for (let i = 0; i < n; i++) {
    // Carry the heading round the curve of the Earth: keep it horizontal here.
    const r = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) || 1;
    const ux = p[i * 3] / r;
    const uy = p[i * 3 + 1] / r;
    const uz = p[i * 3 + 2] / r;
    const vertical = cx * ux + cy * uy + cz * uz;
    cx -= vertical * ux;
    cy -= vertical * uy;
    cz -= vertical * uz;
    if (first >= 0 && i > first) {
      horizontal(p, v, i);
      const w = smoothstep(HOLD_SPEED, FOLLOW_SPEED, hv[3]);
      if (w > 0) {
        // The same line of travel, whichever way along it the vehicle is going.
        const k = hv[0] * cx + hv[1] * cy + hv[2] * cz < 0 ? -1 / hv[3] : 1 / hv[3];
        const a = w * (1 - Math.exp(-(track.t[i] - track.t[i - 1]) / FOLLOW_TAU));
        cx += (hv[0] * k - cx) * a;
        cy += (hv[1] * k - cy) * a;
        cz += (hv[2] * k - cz) * a;
      }
    }
    const len = Math.hypot(cx, cy, cz) || 1;
    cx /= len;
    cy /= len;
    cz /= len;
    out[i * 3] = cx;
    out[i * 3 + 1] = cy;
    out[i * 3 + 2] = cz;
  }
  return out;
}

/** The course at time t (clamped to the track), made horizontal at `pos` and unit length, into `out`. */
export function courseAt(track: Track, course: Float32Array, t: number, pos: V3, out: V3): V3 {
  const tc = Math.min(Math.max(t, track.start), track.end);
  const i = sampleIndex(track.t, track.n, tc);
  const j = Math.min(track.n - 1, i + 1);
  const h = track.t[j] - track.t[i];
  const s = h > 0 ? Math.min(1, Math.max(0, (tc - track.t[i]) / h)) : 0;
  let x = course[i * 3] + (course[j * 3] - course[i * 3]) * s;
  let y = course[i * 3 + 1] + (course[j * 3 + 1] - course[i * 3 + 1]) * s;
  let z = course[i * 3 + 2] + (course[j * 3 + 2] - course[i * 3 + 2]) * s;
  const r = Math.hypot(pos[0], pos[1], pos[2]) || 1;
  const vertical = (x * pos[0] + y * pos[1] + z * pos[2]) / r;
  x -= (vertical * pos[0]) / r;
  y -= (vertical * pos[1]) / r;
  z -= (vertical * pos[2]) / r;
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) return out;
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  return out;
}
