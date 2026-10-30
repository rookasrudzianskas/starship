import { describe, expect, it } from 'vitest';
import { createCoastPrediction, predictCoast } from '../coast';
import { EARTH_J2, EARTH_J2_RADIUS, EARTH_MU, EARTH_OMEGA, EARTH_RADIUS } from '../../../sim/types';

type V = [number, number, number];

/** ECEF state at a latitude/longitude, `alt` above the sphere, velocity given in local east/north/up (m/s). */
function stateAt(latDeg: number, lonDeg: number, alt: number, east: number, north: number, up: number): { pos: V; vel: V } {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const u: V = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const e: V = [-Math.sin(lon), Math.cos(lon), 0];
  const n: V = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const r = EARTH_RADIUS + alt;
  return {
    pos: [u[0] * r, u[1] * r, u[2] * r],
    vel: [e[0] * east + n[0] * north + u[0] * up, e[1] * east + n[1] * north + u[1] * up, e[2] * east + n[2] * north + u[2] * up],
  };
}

/** Reference: the same dynamics with tiny fixed steps, returning the ECEF impact point or null. */
function referenceImpact(pos: V, vel: V, maxSeconds: number, h = 0.01): V | null {
  const w = EARTH_OMEGA;
  const acc = (x: number, y: number, z: number): V => {
    const r2 = x * x + y * y + z * z;
    const r = Math.sqrt(r2);
    const m = EARTH_MU / (r2 * r);
    const k = 1.5 * EARTH_J2 * (EARTH_J2_RADIUS * EARTH_J2_RADIUS) / r2;
    const zr2 = (z * z) / r2;
    return [-m * x * (1 + k * (1 - 5 * zr2)), -m * y * (1 + k * (1 - 5 * zr2)), -m * z * (1 + k * (3 - 5 * zr2))];
  };
  const d = (s: number[]): number[] => {
    const a = acc(s[0], s[1], s[2]);
    return [s[3], s[4], s[5], a[0], a[1], a[2]];
  };
  let s = [pos[0], pos[1], pos[2], vel[0] - w * pos[1], vel[1] + w * pos[0], vel[2]];
  for (let t = 0; t < maxSeconds; t += h) {
    const a = d(s);
    const b = d(s.map((v, i) => v + (a[i] * h) / 2));
    const c = d(s.map((v, i) => v + (b[i] * h) / 2));
    const e = d(s.map((v, i) => v + c[i] * h));
    const next = s.map((v, i) => v + (h / 6) * (a[i] + 2 * b[i] + 2 * c[i] + e[i]));
    const r = Math.hypot(next[0], next[1], next[2]);
    if (r <= EARTH_RADIUS) {
      const pr = Math.hypot(s[0], s[1], s[2]);
      const f = (pr - EARTH_RADIUS) / (pr - r);
      const x = s[0] + (next[0] - s[0]) * f;
      const y = s[1] + (next[1] - s[1]) * f;
      const z = s[2] + (next[2] - s[2]) * f;
      const ang = -w * (t + f * h);
      return [x * Math.cos(ang) - y * Math.sin(ang), x * Math.sin(ang) + y * Math.cos(ang), z];
    }
    s = next;
  }
  return null;
}

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('predictCoast', () => {
  const out = createCoastPrediction(520);

  it('puts the impact of a short hop next to the vehicle (booster just after liftoff)', () => {
    // About T+8: 173 m up, climbing at 30 m/s.
    const { pos, vel } = stateAt(25.997, -97.157, 173, 0, 0, 30);
    predictCoast(pos, vel, 7200, out);
    const ref = referenceImpact(pos, vel, 60);
    expect(out.impact).not.toBeNull();
    expect(ref).not.toBeNull();
    expect(dist(out.impact!, ref!)).toBeLessThan(2);
    // Straight up and down: it lands within a few metres of where it started (the Earth turns under it).
    expect(dist(out.impact!, pos)).toBeLessThan(200);
    // A short arc is drawn with many points, not a two-point line.
    expect(out.n).toBeGreaterThan(10);
  });

  it('matches a fine-step reference for a long ballistic arc', () => {
    // Suborbital: 120 km up, 6 km/s east, falling at 500 m/s.
    const { pos, vel } = stateAt(10, -60, 120_000, 6000, 300, -500);
    predictCoast(pos, vel, 7200, out);
    const ref = referenceImpact(pos, vel, 7200, 0.05);
    expect(out.impact).not.toBeNull();
    expect(ref).not.toBeNull();
    expect(dist(out.impact!, ref!)).toBeLessThan(100);
    // The last point is the impact point and every point is in ECEF near the Earth's surface or above.
    const last = out.points.subarray((out.n - 1) * 3, out.n * 3);
    expect(dist(last, out.impact!)).toBe(0);
    for (let i = 0; i < out.n; i++) {
      const r = Math.hypot(out.points[i * 3], out.points[i * 3 + 1], out.points[i * 3 + 2]);
      expect(r).toBeGreaterThan(EARTH_RADIUS - 1);
    }
  });

  it('follows an orbit without an impact', () => {
    const v = Math.sqrt(EARTH_MU / (EARTH_RADIUS + 200_000));
    // Orbital speed in the inertial frame, minus the ground's eastward speed at the equator.
    const { pos, vel } = stateAt(0, 0, 200_000, v - EARTH_OMEGA * (EARTH_RADIUS + 200_000), 0, 0);
    predictCoast(pos, vel, 7200, out);
    expect(out.impact).toBeNull();
    expect(out.n).toBeGreaterThan(400);
    for (let i = 0; i < out.n; i++) {
      const alt = Math.hypot(out.points[i * 3], out.points[i * 3 + 1], out.points[i * 3 + 2]) - EARTH_RADIUS;
      expect(alt).toBeGreaterThan(150_000);
      expect(alt).toBeLessThan(250_000);
    }
  });
});
