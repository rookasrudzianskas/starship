import { describe, expect, it } from 'vitest';
import { ENGINE_LIT, ENGINE_OFF } from '../../../sim/types';
import { EngineSmoother } from '../runtime';
import { FbmLattice, NoiseLattice, tileFbm, tileNoise } from '../procedural';

const lit = new Uint8Array([ENGINE_LIT]);
const off = new Uint8Array([ENGINE_OFF]);

/** Plays `seconds` of simulation time in frames of `dt`. */
function play(s: EngineSmoother, engines: Uint8Array, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds - 1e-9; t += dt) s.update(engines, 1, dt);
}

describe('EngineSmoother (simulation time)', () => {
  it('eases the plume in during playback and snaps on seeks', () => {
    const s = new EngineSmoother(1);
    s.update(off, 1, 1 / 60);
    play(s, lit, 0.1);
    expect(s.intensity[0]).toBeGreaterThan(0.1);
    expect(s.intensity[0]).toBeLessThan(0.5);
    s.update(lit, 1, 3); // forward seek
    expect(s.intensity[0]).toBe(1);
    s.update(off, 1, -10); // backwards seek
    expect(s.intensity[0]).toBe(0);
  });

  it('heats the RVac extension over a burn and cools it in simulation time after shutdown', () => {
    const s = new EngineSmoother(1);
    s.update(off, 1, 1 / 60);
    play(s, lit, 60);
    expect(s.heat[0]).toBeGreaterThan(0.95);
    play(s, off, 30);
    expect(s.heat[0]).toBeGreaterThan(0.3);
    expect(s.heat[0]).toBeLessThan(0.45);
    // A long forward seek past shutdown (T+515 -> T+2112) leaves the bells cold.
    s.update(off, 1, 1597);
    expect(s.heat[0]).toBeLessThan(1e-6);
  });

  it('holds everything while paused (dt = 0) and integrates large forward steps exactly', () => {
    const a = new EngineSmoother(1);
    const b = new EngineSmoother(1);
    for (const s of [a, b]) {
      s.update(off, 1, 1 / 60);
      play(s, lit, 20);
    }
    const before = a.heat[0];
    for (let i = 0; i < 100; i++) a.update(lit, 1, 0);
    expect(a.heat[0]).toBe(before);
    // Fast playback in 2 s steps cools the bell like 1/60 s steps do.
    for (let i = 0; i < 10; i++) a.update(off, 1, 2);
    play(b, off, 20);
    expect(Math.abs(a.heat[0] - b.heat[0])).toBeLessThan(1e-3);
  });

  it('starts from a typical heat when the burn history is unknown', () => {
    const s = new EngineSmoother(2);
    s.update(new Uint8Array([ENGINE_LIT, ENGINE_OFF]), 1, 0);
    expect(s.heat[0]).toBeCloseTo(0.7);
    expect(s.heat[1]).toBe(0);
    play(s, new Uint8Array([ENGINE_LIT, ENGINE_LIT]), 5);
    s.update(new Uint8Array([ENGINE_LIT, ENGINE_LIT]), 1, -100);
    expect(s.heat[0]).toBeCloseTo(0.7);
    expect(s.heat[1]).toBeCloseTo(0.7);
  });
});

describe('noise lattices', () => {
  it('sample exactly what tileNoise and tileFbm return', () => {
    const n = new NoiseLattice(-3, -2, 9, 7, 24, 16, 5);
    const f = new FbmLattice(-3, -2, 9, 7, 64, 64, 4, 9);
    for (let i = 0; i < 2000; i++) {
      const x = -3 + ((i * 0.6180339) % 1) * 12;
      const y = -2 + ((i * 0.4142135) % 1) * 9;
      expect(n.sample(x, y)).toBe(tileNoise(x, y, 24, 16, 5));
      expect(f.sample(x, y)).toBe(tileFbm(x, y, 64, 64, 4, 9));
    }
  });
});
