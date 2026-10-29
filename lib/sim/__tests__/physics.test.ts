import { describe, expect, it } from 'vitest';
import { atmosphere } from '../atmosphere';
import { propagateBallistic } from '../ballistic';
import { engineLayout, engineStatesAt } from '../engines';
import { ecefToLatLonAlt, latLonAltToEcef, localEnuBasis } from '../geo';
import { gravityAccel, rk4 } from '../physics';
import { scenarioKey } from '../scenario';
import { EARTH_MU, EARTH_RADIUS, ENGINE_FAILED, ENGINE_LIT, ENGINE_OFF, type EngineTimeline, type Scenario } from '../types';

describe('atmosphere (US Standard Atmosphere 1976)', () => {
  it.each([
    // altitude m, pressure Pa, density kg/m^3, temperature K
    [0, 101_325, 1.225, 288.15],
    [11_000, 22_700, 0.3648, 216.77],
    [20_000, 5_529, 0.08891, 216.65],
    [32_000, 889.1, 0.013555, 228.49],
    [50_000, 79.78, 1.027e-3, 270.65],
    [80_000, 1.0524, 1.846e-5, 198.64],
    [86_000, 0.3734, 6.958e-6, 186.87],
  ])('matches the tables at %i m', (alt, p, rho, T) => {
    const a = atmosphere(alt);
    expect(a.pressure).toBeCloseTo(p, -Math.floor(Math.log10(p)) + 2);
    expect(Math.abs(a.density - rho) / rho).toBeLessThan(0.005);
    expect(Math.abs(a.temperature - T)).toBeLessThan(0.5);
  });

  it('gives the sea-level speed of sound and a smooth, falling thermosphere', () => {
    expect(atmosphere(0).speedOfSound).toBeCloseTo(340.29, 1);
    let prev = atmosphere(86_000).density;
    for (let h = 90_000; h <= 1_000_000; h += 10_000) {
      const d = atmosphere(h).density;
      expect(d).toBeLessThan(prev);
      expect(Number.isFinite(d)).toBe(true);
      prev = d;
    }
    expect(atmosphere(200_000).density).toBeCloseTo(2.541e-10, 12);
    // Continuous across the 86 km seam.
    expect(Math.abs(atmosphere(85_999).density / atmosphere(86_001).density - 1)).toBeLessThan(0.01);
  });
});

describe('two-body propagation', () => {
  it('conserves energy and returns to the start after one circular-orbit period (J2 off)', () => {
    const r0 = EARTH_RADIUS + 400_000;
    const v0 = Math.sqrt(EARTH_MU / r0);
    const period = 2 * Math.PI * Math.sqrt((r0 * r0 * r0) / EARTH_MU);
    const r = new Float64Array([r0, 0, 0]);
    const v = new Float64Array([0, v0 * Math.cos(0.5), v0 * Math.sin(0.5)]);
    const energy = () => (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) / 2 - EARTH_MU / Math.hypot(r[0], r[1], r[2]);
    const e0 = energy();
    const steps = Math.round(period / 2);
    const dt = period / steps;
    for (let i = 0; i < steps; i++) rk4(r, v, null, dt, false);
    expect(Math.abs((energy() - e0) / e0)).toBeLessThan(1e-9);
    expect(Math.hypot(r[0] - r0, r[1], r[2])).toBeLessThan(1);
  });

  it('includes the J2 term (stronger pull at the equator than a point mass at the same radius)', () => {
    const g = new Float64Array(3);
    const r = EARTH_RADIUS + 300_000;
    gravityAccel(r, 0, 0, g, true);
    expect(-g[0]).toBeGreaterThan(EARTH_MU / (r * r));
  });
});

describe('geo helpers', () => {
  it('round-trips lat/lon/alt through ECEF and builds an orthonormal ENU basis', () => {
    const p = latLonAltToEcef(25.99683, -97.1542, 1234);
    const g = ecefToLatLonAlt(p);
    expect(g.lat).toBeCloseTo(25.99683, 9);
    expect(g.lon).toBeCloseTo(-97.1542, 9);
    expect(g.alt).toBeCloseTo(1234, 4);
    const { east, north, up } = localEnuBasis(25.99683, -97.1542);
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(east, north)).toBeCloseTo(0, 12);
    expect(dot(east, up)).toBeCloseTo(0, 12);
    expect(dot(up, p) / Math.hypot(...p)).toBeCloseTo(1, 12);
    expect(north[2]).toBeGreaterThan(0);
  });
});

describe('engines', () => {
  it('lays out the booster and ship rings as specified', () => {
    const b = engineLayout('booster', 'b1');
    expect(b).toHaveLength(33);
    expect(b.filter((s) => s.ring === 'center')).toHaveLength(3);
    expect(b.filter((s) => s.ring === 'inner')).toHaveLength(10);
    expect(b.filter((s) => s.ring === 'outer')).toHaveLength(20);
    expect(Math.hypot(b[13].x, b[13].z)).toBeCloseTo(4.05, 6);
    expect(b[0].x).toBeCloseTo(0, 6); // θ0 = 90°: first slot on +Z
    expect(b[0].z).toBeCloseTo(0.95, 6);
    const s = engineLayout('ship', 'v3');
    expect(s).toHaveLength(6);
    expect(s[3].vacuum).toBe(true);
    expect(s[3].exitRadius).toBeCloseTo(1.15, 6);
    expect(Math.atan2(s[3].z, s[3].x) * (180 / Math.PI)).toBeCloseTo(30, 6);
    expect(s[0].exitRadius).toBeCloseTo(0.65, 6);
  });

  it('replays an engine timeline without allocating', () => {
    const tl: EngineTimeline = {
      slots: engineLayout('ship', 'b2'),
      changes: [
        { t: 1, engine: 0, state: ENGINE_LIT },
        { t: 2, engine: 3, state: ENGINE_LIT },
        { t: 3, engine: 0, state: ENGINE_OFF },
        { t: 4, engine: 3, state: ENGINE_FAILED },
      ],
    };
    const out = new Uint8Array(6);
    expect(Array.from(engineStatesAt(tl, 0, out))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Array.from(engineStatesAt(tl, 2.5, out))).toEqual([1, 0, 0, 1, 0, 0]);
    expect(engineStatesAt(tl, 10, out)).toBe(out);
    expect(Array.from(out)).toEqual([0, 0, 0, 2, 0, 0]);
  });
});

describe('scenarioKey', () => {
  it('is stable, order-independent and sensitive to content', () => {
    const a: Scenario = {
      asFlown: true,
      interventions: [
        { id: 'x', t: 30, kind: 'engine-out', vehicle: 'booster', engine: 14 },
        { id: 'y', t: 100, kind: 'throttle', vehicle: 'ship', value: 0.6 },
      ],
    };
    const b: Scenario = { asFlown: true, interventions: [...a.interventions].reverse() };
    expect(scenarioKey(a)).toBe(scenarioKey(b));
    expect(scenarioKey({ ...a, wind: 0 })).toBe(scenarioKey(a));
    expect(scenarioKey({ ...a, wind: 40 })).not.toBe(scenarioKey(a));
    expect(scenarioKey({ ...a, asFlown: false })).not.toBe(scenarioKey(a));
  });
});

describe('propagateBallistic', () => {
  it('predicts an impact quickly and stays on the surface track', () => {
    const pos = latLonAltToEcef(26, -96, 100_000);
    const { east, up } = localEnuBasis(26, -96);
    const vel = [0, 1, 2].map((i) => 1500 * east[i] + 300 * up[i]);
    propagateBallistic(pos, vel, 600); // warm-up
    const t0 = performance.now();
    const res = propagateBallistic(pos, vel, 1200, { ballisticCoeff: 4000 });
    const ms = performance.now() - t0;
    expect(res.impact).not.toBeNull();
    expect(res.impactT).toBeGreaterThan(100);
    expect(res.points.length % 3).toBe(0);
    expect(res.points.length / 3).toBeLessThanOrEqual(302);
    const g = ecefToLatLonAlt(res.impact as [number, number, number]);
    expect(Math.abs(g.alt)).toBeLessThan(1);
    expect(g.lon).toBeGreaterThan(-96);
    expect(ms).toBeLessThan(2);
  });

  it('keeps an orbit (no impact) for a circular orbital state', () => {
    const r = EARTH_RADIUS + 300_000;
    const pos = { x: r, y: 0, z: 0 };
    // ECEF velocity for an inertial circular orbit: subtract the Earth's rotation.
    const vel = { x: 0, y: Math.sqrt(EARTH_MU / r) - 7.2921159e-5 * r, z: 0 };
    const res = propagateBallistic(pos, vel, 5400);
    expect(res.impact).toBeNull();
    for (let i = 0; i < res.points.length; i += 3) {
      const alt = Math.hypot(res.points[i], res.points[i + 1], res.points[i + 2]) - EARTH_RADIUS;
      expect(alt).toBeGreaterThan(250_000);
    }
  });
});
