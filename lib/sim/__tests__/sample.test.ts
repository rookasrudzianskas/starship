import { describe, expect, it } from 'vitest';
import { createTrackSample, sampleTrack } from '../sample';
import { simulateFlight } from '../simulate';
import { Phase, type Track } from '../types';

const result = simulateFlight(10, { asFlown: true, interventions: [] });

function checkTrack(tr: Track): void {
  expect(tr.n).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < tr.n; i++) expect(tr.t[i]).toBeGreaterThan(tr.t[i - 1]);
  expect(tr.start).toBe(tr.t[0]);
  expect(tr.end).toBe(tr.t[tr.n - 1]);
}

describe('sampleTrack', () => {
  it('reproduces stored samples exactly and interpolates between them', () => {
    const tr = result.ship;
    checkTrack(tr);
    const s = createTrackSample();
    const i = Math.floor(tr.n / 3);
    sampleTrack(tr, tr.t[i], s);
    expect(s.pos.x).toBeCloseTo(tr.pos[3 * i], 6);
    expect(s.vel.z).toBeCloseTo(tr.vel[3 * i + 2], 6);
    expect(s.alt).toBeCloseTo(tr.alt[i], 3);
    expect(s.phase).toBe(tr.phase[i]);
    // Midpoint: between the neighbours, phase of the earlier sample, unit quaternion.
    const tm = (tr.t[i] + tr.t[i + 1]) / 2;
    sampleTrack(tr, tm, s);
    const lo = Math.min(tr.alt[i], tr.alt[i + 1]) - 1;
    const hi = Math.max(tr.alt[i], tr.alt[i + 1]) + 1;
    expect(s.alt).toBeGreaterThanOrEqual(lo);
    expect(s.alt).toBeLessThanOrEqual(hi);
    expect(s.phase).toBe(tr.phase[i]);
    expect(Math.hypot(s.quat.x, s.quat.y, s.quat.z, s.quat.w)).toBeCloseTo(1, 6);
    // Hermite position is consistent with the velocity: a tiny step moves by v·dt.
    const p0 = { ...s.pos };
    const v0 = { ...s.vel };
    sampleTrack(tr, tm + 1e-3, s);
    expect((s.pos.x - p0.x) / 1e-3).toBeCloseTo(v0.x, 0);
  });

  it('clamps to the track and reports whether the vehicle is alive', () => {
    const tr = result.booster;
    checkTrack(tr);
    const s = createTrackSample();
    sampleTrack(tr, -100, s);
    expect(s.t).toBe(tr.start);
    expect(s.alive).toBe(false);
    expect(s.phase).toBe(Phase.Pad);
    sampleTrack(tr, 100, s);
    expect(s.alive).toBe(true);
    sampleTrack(tr, 1e6, s);
    expect(s.t).toBe(tr.end);
    expect(s.alive).toBe(false);
    expect(s.phase).toBe(Phase.Splashed);
  });

  it('runs fast enough for per-frame use', () => {
    const s = createTrackSample();
    const tr = result.ship;
    const t0 = performance.now();
    for (let k = 0; k < 100_000; k++) sampleTrack(tr, tr.start + ((k * 7.3) % (tr.end - tr.start)), s);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
