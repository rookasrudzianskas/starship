import { describe, expect, it } from 'vitest';
import { createTrackSample, sampleTrack } from '../sample';
import { simulateFlight } from '../simulate';
import type { Intervention, Track } from '../types';

const nominal = { asFlown: true, interventions: [] };
const flap = (t: number, index: 0 | 1 | 2 | 3, deg: number | null): Intervention => ({ id: `${t}-${index}`, kind: 'flap', vehicle: 'ship', flap: index, deg, t });
function at(track: Track, t: number) { return sampleTrack(track, t, createTrackSample()); }

describe('flap commands through the flight integrator', () => {
  it('moves one surface in vacuum, holds its command, then returns smoothly to automatic without changing the coast', () => {
    const baseline = simulateFlight(5, nominal);
    const changed = simulateFlight(5, { ...nominal, interventions: [flap(600, 2, 0), flap(620, 2, null)] });
    const before = at(changed.ship, 600), halfway = at(changed.ship, 601), held = at(changed.ship, 615), released = at(changed.ship, 620), restored = at(changed.ship, 630);
    expect(before.aero).toEqual([75, 75, 75, 75]);
    expect(halfway.aero[2]).toBeGreaterThan(0);
    expect(halfway.aero[2]).toBeLessThan(75);
    expect(held.aero).toEqual([75, 75, 0, 75]);
    expect(released.aero[2]).toBe(0);
    expect(restored.aero).toEqual([75, 75, 75, 75]);
    const sameTime = at(baseline.ship, 630);
    expect(restored.alt).toBeGreaterThan(140_000);
    expect(restored.q).toBeLessThan(0.05);
    // Actuator movement refines coast timesteps; gravity integration remains equivalent to sub-mm precision.
    for (const key of ['x', 'y', 'z'] as const) {
      expect(restored.pos[key]).toBeCloseTo(sameTime.pos[key], 3);
      expect(restored.vel[key]).toBeCloseTo(sameTime.vel[key], 5);
    }
    expect(changed.events.filter(e => e.short === 'FLAP')).toHaveLength(2);
  });

  it('changes both trajectory and attitude in air, preserving the exact past and continuous surface motion', () => {
    const baseline = simulateFlight(5, nominal);
    const entry = baseline.events.find(e => e.key === 'entry')!.t;
    let index = 0;
    while (baseline.ship.t[index] < entry || baseline.ship.q[index] < 1000) index++;
    const time = Math.ceil(baseline.ship.t[index]);
    const changed = simulateFlight(5, { ...nominal, interventions: [flap(time, 2, 90)] });
    const past = at(baseline.ship, time - 1), changedPast = at(changed.ship, time - 1);
    expect(changedPast).toEqual(past);
    const a = at(baseline.ship, time + 10), b = at(changed.ship, time + 10);
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z)).toBeGreaterThan(1);
    const dot = Math.abs(a.quat.x * b.quat.x + a.quat.y * b.quat.y + a.quat.z * b.quat.z + a.quat.w * b.quat.w);
    expect(dot).toBeLessThan(0.999);
    expect(b.aero[2]).toBe(90);
    let maxRate = 0;
    for (let i = 1; i < changed.ship.n; i++) {
      const dt = changed.ship.t[i] - changed.ship.t[i - 1];
      for (let k = 0; k < 4; k++) {
        const value = changed.ship.aero[4 * i + k];
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(90);
        if (dt > 0) maxRate = Math.max(maxRate, Math.abs(value - changed.ship.aero[4 * (i - 1) + k]) / dt);
      }
    }
    // Stored float32 angles introduce small quantization at short event-boundary intervals.
    expect(maxRate).toBeLessThan(30.02);
  });

  it('ignores imported commands before separation and after flight termination', () => {
    const baseline = simulateFlight(5, nominal);
    const end = baseline.events.find(e => e.key === 'ship-end')!.t;
    const changed = simulateFlight(5, { ...nominal, interventions: [flap(0, 0, 0), flap(end + 1, 0, 90)] });
    expect(changed.ship.aero).toEqual(baseline.ship.aero);
    expect(changed.events.filter(e => e.short === 'FLAP')).toHaveLength(0);
  });
});
