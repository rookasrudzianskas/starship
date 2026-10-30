import { describe, expect, it } from 'vitest';
import type { InterleavedBufferAttribute } from 'three';
import type { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import type { FlightResult, Track } from '../../../sim/types';
import { createCoastPrediction, predictCoast } from '../coast';
import { impactFade, TrajectoryLines } from '../paths';

const R = 6_371_000;

/** A track along a great circle at 100 km, one sample per second from t = 0. */
function track(n: number): Track {
  const pos = new Float64Array(n * 3);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = i * 1e-3;
    pos[i * 3] = (R + 100_000) * Math.cos(a);
    pos[i * 3 + 1] = (R + 100_000) * Math.sin(a);
    pos[i * 3 + 2] = 0;
    t[i] = i;
  }
  return { n, pos, t, start: 0, end: n - 1 } as unknown as Track;
}

function at(tr: Track, time: number): [number, number, number] {
  const a = time * 1e-3;
  return [(R + 100_000) * Math.cos(a), (R + 100_000) * Math.sin(a), 0];
}

/** Segment k of a line as [start xyz, end xyz]. */
function segment(g: LineGeometry, k: number): number[] {
  const s = g.attributes.instanceStart as InterleavedBufferAttribute;
  const e = g.attributes.instanceEnd as InterleavedBufferAttribute;
  return [s.getX(k), s.getY(k), s.getZ(k), e.getX(k), e.getY(k), e.getZ(k)];
}

describe('TrajectoryLines', () => {
  const booster = track(7001);
  const ship = track(7001);
  const result = { booster, ship, scenarioKey: 'a' } as unknown as FlightResult;
  const origin: [number, number, number] = [R, 0, 0];
  const lines = new TrajectoryLines(origin);
  lines.setResult(result, null);
  const show = { flown: true, planned: true, coast: true };
  const flown = lines.flown.booster.line.geometry as LineGeometry;
  const rel = (p: number[]) => [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]].map(Math.fround);

  it('ends the flown line at the vehicle, between decimated points', () => {
    // 7001 samples keep every other one (3501 points): t = 1235.5 lies inside the segment from 1234 to 1236.
    lines.update(1235.5, origin, show, { booster: at(booster, 1235.5), ship: null });
    expect(flown.instanceCount).toBe(618);
    const last = segment(flown, 617);
    expect(last.slice(0, 3)).toEqual(rel(at(booster, 1234)));
    expect(last.slice(3)).toEqual(rel(at(booster, 1235.5)));
  });

  it('puts the replaced end back when the vehicle moves on', () => {
    lines.update(2000.2, origin, show, { booster: at(booster, 2000.2), ship: null });
    expect(segment(flown, 617).slice(3)).toEqual(rel(at(booster, 1236)));
    expect(flown.instanceCount).toBe(1001);
    expect(segment(flown, 1000).slice(3)).toEqual(rel(at(booster, 2000.2)));
  });

  it('draws the whole path after the end and none before the start', () => {
    lines.update(8000, origin, show, { booster: null, ship: null });
    expect(flown.instanceCount).toBe(3500);
    expect(segment(flown, 1000).slice(3)).toEqual(rel(at(booster, 2002)));
    lines.update(-5, origin, show, { booster: null, ship: null });
    expect(flown.instanceCount).toBe(0);
  });

  it('rewrites the coast line in place, with dashes measured along it', () => {
    const p = createCoastPrediction(560);
    const s0 = at(booster, 100);
    predictCoast(s0, [0, 7800, 0], 7200, p);
    lines.setCoast('booster', p);
    const g = lines.coast.booster.line.geometry as LineGeometry;
    const buffer = (g.attributes.instanceStart as InterleavedBufferAttribute).data;
    expect(g.instanceCount).toBe(p.n - 1);
    predictCoast(at(booster, 200), [0, 7700, 100], 7200, p);
    lines.setCoast('booster', p);
    expect(lines.coast.booster.line.geometry).toBe(g);
    expect((g.attributes.instanceStart as InterleavedBufferAttribute).data).toBe(buffer);
    const d0 = g.attributes.instanceDistanceStart as InterleavedBufferAttribute;
    const d1 = g.attributes.instanceDistanceEnd as InterleavedBufferAttribute;
    for (let k = 1; k < g.instanceCount; k++) {
      expect(d0.getX(k)).toBe(d1.getX(k - 1));
      expect(d1.getX(k)).toBeGreaterThan(d0.getX(k));
    }
    // Hidden with the setting, and shown again by the next prediction.
    lines.update(200, origin, { ...show, coast: false }, { booster: null, ship: null });
    expect(lines.coast.booster.line.visible).toBe(false);
    lines.setCoast('booster', p);
    expect(lines.coast.booster.line.visible).toBe(true);
  });
});

describe('impactFade', () => {
  it('hides the impact ring from cameras close to it and shows it in full from afar', () => {
    expect(impactFade(300)).toBe(0);
    expect(impactFade(1999)).toBe(0);
    expect(impactFade(5000)).toBeGreaterThan(0.3);
    expect(impactFade(5000)).toBeLessThan(0.7);
    expect(impactFade(9000)).toBe(1);
    expect(impactFade(5e6)).toBe(1);
  });
});
