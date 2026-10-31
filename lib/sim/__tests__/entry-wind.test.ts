import { describe, expect, it, vi } from 'vitest';
import { atmosphere } from '../atmosphere';
import { inertialToEcef, latLonAltToEcef, localEnuBasis } from '../geo';
import * as entry from '../guidance/entry';
import { aeroForce, airVelocity, gravityAccel } from '../physics';
import { simulateWithOptions } from '../simulate';
import { EARTH_OMEGA, EARTH_RADIUS, Phase } from '../types';
import { cross3, dot3, normalize3, v3 } from '../vec';
import { vehicleSpec } from '../vehicles';

const cfg = vehicleSpec('ship', 'b2').aero;
const mass = 145_000;
const t0 = 1234;
const output = (): entry.EntryPrediction => ({ end: v3(), t: 0 });

function state(alt: number, vertical: number, east: number, north = 0, lat = 0, lon = 0) {
  const r = Float64Array.from(latLonAltToEcef(lat, lon, alt));
  const axes = localEnuBasis(lat, lon);
  const v = Float64Array.from(r, (_, i) => vertical * axes.up[i] + east * axes.east[i] + north * axes.north[i]);
  v[0] -= EARTH_OMEGA * r[1];
  v[1] += EARTH_OMEGA * r[0];
  return { r, v };
}

/** Independent force check: use the live body's airVelocity/aeroForce, rather than trimCoefficients. */
function acceleration(r: Float64Array, v: Float64Array, wind: number, cosBank: number, sign: number) {
  const alt = Math.hypot(...r) - EARTH_RADIUS;
  const atm = atmosphere(alt);
  const va = airVelocity(v3(), r, v, alt, wind);
  const mach = Math.hypot(...va) / atm.speedOfSound;
  const u = normalize3(v3(), va);
  const up = normalize3(v3(), r);
  const d = dot3(up, u);
  const liftUp = normalize3(v3(), Float64Array.from(up, (x, i) => x - d * u[i]));
  const side = cross3(v3(), u, liftUp);
  const sinBank = sign * Math.sqrt(1 - cosBank * cosBank);
  const aoa = entry.entryAoA(65, mach);
  const yAxis = Float64Array.from(u, (x, i) => Math.cos(aoa) * x + Math.sin(aoa) * (cosBank * liftUp[i] + sinBank * side[i]));
  const force = aeroForce(v3(), { q: 0, mach: 0, aoa: 0, airspeed: 0 }, yAxis, va, atm.density, atm.speedOfSound, cfg);
  const gravity = gravityAccel(r[0], r[1], r[2], v3(), false);
  return Float64Array.from(gravity, (x, i) => x + force[i] / mass);
}

describe('entry prediction wind', () => {
  // Captured from the unmodified predictor: exact equality protects the calibrated calm-air arithmetic,
  // including different time steps, bank signs, the altitude exit and the subsonic exit.
  it.each([
    { alt: 120_000, vertical: -250, east: 7200, north: 50, bank: 0.6, sign: 1, end: [6055095.00130158, 2007104.7325517014, -234558.6789815023], t: 1830 },
    { alt: 40_000, vertical: -500, east: 2000, north: -120, bank: -0.2, sign: -1, end: [6361425.174539389, -525756.6999779007, 9284.184496868791], t: 1318 },
    { alt: 11_500, vertical: -350, east: 300, north: 20, bank: 0.6, sign: 1, end: [6354772.998527187, -571737.1441728058, -65.02468521993092], t: 1244 },
    { alt: 3050, vertical: -300, east: 100, north: 0, bank: 0.6, sign: -1, end: [6347876.115928444, -572611.3245713115, 25.00016795536127], t: 1236 },
    { alt: 11_000, vertical: -100, east: 0, north: 0, bank: 1, sign: 1, end: [6356179.111640355, -573507.7163795029, 0], t: 1234 },
  ])('preserves the original zero-wind prediction from $alt m', ({ alt, vertical, east, north, bank, sign, end, t }) => {
    const { r, v } = state(alt, vertical, east, north);
    for (const wind of [undefined, 0, -0]) {
      const result = entry.predictEntry(r, v, t0, mass, cfg, 65, bank, sign, output(), wind);
      expect(Array.from(result.end)).toEqual(end);
      expect(result.t).toBe(t);
    }
  });

  it.each([-150, -60, 60, 150])('matches live aerodynamic forces at both midpoint stages with wind %s m/s', (wind) => {
    const initial = state(3650, -300, 100, 30, 26, -97);
    const r = initial.r.slice(), v = initial.v.slice();
    const bank = 0.6, sign = -1, dt = 2;
    // This descent crosses 3 km after exactly two steps. The second step's position depends on
    // the first step's midpoint force, so omitting wind from either derivative call is detectable.
    for (let step = 0; step < 2; step++) {
      const a = acceleration(r, v, wind, bank, sign);
      const midR = Float64Array.from(r, (x, i) => x + 0.5 * dt * v[i]);
      const midV = Float64Array.from(v, (x, i) => x + 0.5 * dt * a[i]);
      const midA = acceleration(midR, midV, wind, bank, sign);
      for (let i = 0; i < 3; i++) {
        r[i] += dt * midV[i];
        v[i] += dt * midA[i];
      }
    }
    const expected = inertialToEcef(v3(), r, t0 + 2 * dt);
    const result = entry.predictEntry(initial.r, initial.v, t0, mass, cfg, 65, bank, sign, output(), wind);
    expect(result.t).toBe(t0 + 2 * dt);
    for (let i = 0; i < 3; i++) expect(result.end[i]).toBeCloseTo(expected[i], 7);
    const calm = entry.predictEntry(initial.r, initial.v, t0, mass, cfg, 65, bank, sign, output());
    expect(Math.hypot(...result.end.map((x, i) => x - calm.end[i]))).toBeGreaterThan(1);
  });

  it('keeps inertial position transport unchanged when aerodynamic forces are disabled', () => {
    const { r, v } = state(11_500, -1000, 500, 100, -20, 110);
    const noAero = { ...cfg, refArea: 0 };
    const calm = entry.predictEntry(r, v, t0, mass, noAero, 65, 0.6, 1, output());
    expect(calm.t).toBeGreaterThan(t0);
    for (const wind of [-150, 150]) {
      const windy = entry.predictEntry(r, v, t0, mass, noAero, 65, 0.6, 1, output(), wind);
      expect(windy).toEqual(calm);
    }
  });

  it('uses air-relative Mach for the subsonic exit, including headwinds and tailwinds', () => {
    const { r, v } = state(11_500, -50, 240);
    const tailwind = entry.predictEntry(r, v, t0, mass, cfg, 65, 1, 1, output(), 150);
    expect(tailwind.t).toBe(t0);
    expect(tailwind.end).toEqual(inertialToEcef(v3(), r, t0));
    for (const wind of [0, -150]) {
      const result = entry.predictEntry(r, v, t0, mass, cfg, 65, 1, 1, output(), wind);
      expect(result.t).toBeGreaterThan(t0);
      expect(Array.from(result.end).every(Number.isFinite)).toBe(true);
    }
  });

  it('remains finite for either wind direction at and near both poles', () => {
    for (const pole of [-1, 1]) for (const offset of [0, 0.25, 2]) for (const wind of [-150, 150]) {
      const r = new Float64Array([offset, 0, pole * (EARTH_RADIUS + 3650)]);
      const v = new Float64Array([100, 30, pole * -300]);
      const result = entry.predictEntry(r, v, t0, mass, cfg, 65, -0.2, -1, output(), wind);
      expect(result.t).toBeGreaterThan(t0);
      expect(Number.isFinite(result.t)).toBe(true);
      expect(Array.from(result.end).every(Number.isFinite)).toBe(true);
    }
  });

  it('reuses the output, preserves inputs and stays deterministic across interleaved winds', () => {
    const { r, v } = state(11_500, -350, 300, 20);
    const originalR = r.slice(), originalV = v.slice();
    const out = output(), end = out.end;
    const expected = entry.predictEntry(r, v, t0, mass, cfg, 65, 0.6, 1, output(), 90);
    for (const wind of [-90, 0, 90]) entry.predictEntry(r, v, t0, mass, cfg, 65, 0.6, 1, out, wind);
    expect(entry.predictEntry(r, v, t0, mass, cfg, 65, 0.6, 1, out, 90)).toBe(out);
    expect(out.end).toBe(end);
    expect(out).toEqual(expected);
    expect(r).toEqual(originalR);
    expect(v).toEqual(originalV);
  });
});

describe('ship entry wind guidance', () => {
  it('passes scenario wind to both bank predictions and changes the commanded bank', () => {
    const predict = entry.predictEntry;
    const spy = vi.spyOn(entry, 'predictEntry');
    try {
      const scenario = { asFlown: true, interventions: [], wind: 90 };
      const aware = simulateWithOptions(5, scenario, { skipBooster: true });
      const calls = spy.mock.calls;
      expect(calls.length).toBeGreaterThan(2);
      expect(calls.every((args) => args[9] === scenario.wind)).toBe(true);
      // The first correction predicts both the current bank and its finite-difference perturbation.
      expect(calls[0][2]).toBe(calls[1][2]);
      expect(calls[0][6]).not.toBe(calls[1][6]);

      // Hold the actual flight's wind fixed and disable only the predictor's wind. This isolates
      // guidance's response from the wind forces that already existed in the live flight.
      spy.mockImplementation((...args) => {
        args[9] = 0;
        return predict(...args);
      });
      const unaware = simulateWithOptions(5, scenario, { skipBooster: true });
      const start = aware.ship.phase.indexOf(Phase.Entry);
      expect(start).toBeGreaterThan(0);
      expect(aware.ship.pos.slice(0, start * 3)).toEqual(unaware.ship.pos.slice(0, start * 3));
      expect(aware.ship.aero.slice(start * 4)).not.toEqual(unaware.ship.aero.slice(start * 4));
      expect(Array.from(aware.ship.pos).every(Number.isFinite)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
