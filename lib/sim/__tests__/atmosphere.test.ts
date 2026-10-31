import { describe, expect, it } from 'vitest';
import { airDensity, atmosphereInto, type AtmosphereState } from '../atmosphere';

function expectSameDensity(altitudes: Iterable<number>): void {
  const state: AtmosphereState = { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 };
  for (const alt of altitudes) {
    // toBe uses Object.is: no tolerance, and NaN and signed zero stay observable.
    expect(airDensity(alt), `density at ${alt} m`).toBe(atmosphereInto(alt, state).density);
  }
}

/** The immediate representable neighbours, including at zero and negative boundaries. */
function neighbours(value: number): number[] {
  if (value === 0) return [-Number.MIN_VALUE, -0, 0, Number.MIN_VALUE];
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, bits - BigInt(1));
  const before = view.getFloat64(0);
  view.setBigUint64(0, bits + BigInt(1));
  return [before, value, view.getFloat64(0)];
}

describe('airDensity exact equivalence', () => {
  it('matches at every table node and multiple interior points of every cell', () => {
    for (let alt = 0; alt < 200_000; alt += 50) {
      expectSameDensity([alt, alt + 0.125, alt + 25, alt + 49.875]);
    }
    expectSameDensity(neighbours(200_000));
  });

  it('matches on both sides of geopotential layers and thermosphere knots', () => {
    const radius = 6_356_766;
    const geopotential = [0, 11_000, 20_000, 32_000, 47_000, 51_000, 71_000];
    const thermosphereKm = [86, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200, 250, 300, 400, 500, 600, 700, 800, 900, 1000];
    const boundaries = [
      -2000,
      ...geopotential.map(h => (radius * h) / (radius - h)),
      ...thermosphereKm.map(km => km * 1000),
    ];
    for (const alt of boundaries) {
      expectSameDensity([...neighbours(alt), alt - 0.001, alt + 0.001]);
    }
  });

  it('matches a bounded deterministic sample within and outside the table', () => {
    let seed = 0x76a17;
    for (let i = 0; i < 512; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const fraction = seed / 0x1_0000_0000;
      expectSameDensity([
        fraction * 200_000,
        -fraction * 4000,
        200_000 + fraction * 800_000,
        1_000_000 + fraction * 100_000_000,
      ]);
    }
  });

  it('preserves clamping, extrapolation, underflow and non-finite fallback behaviour', () => {
    expectSameDensity([
      -Infinity, -Number.MAX_VALUE, -6_356_766, -2001, -2000, -1999.5, -1,
      -Number.MIN_VALUE, -0, 0, Number.MIN_VALUE,
      200_000, 200_000.125, 1_000_000, 1_000_000.125,
      10_000_000, 100_000_000, Number.MAX_VALUE, Infinity, NaN,
    ]);
    expect(airDensity(-Infinity)).toBe(airDensity(-2000));
    expect(airDensity(Number.MAX_VALUE)).toBe(0);
    expect(airDensity(Infinity)).toBe(0);
    expect(airDensity(NaN)).toBeNaN();
  });
});
