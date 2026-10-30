import { describe, expect, it } from 'vitest';
import { simulateFlight } from '../sim/simulate';
import { ENGINE_FAILED, ENGINE_LIT, ENGINE_OFF, Phase, type EngineTimeline, type FlightResult, type VehicleId } from '../sim/types';
import { formatAltitude, formatClock, formatDate, formatEventTime, formatSpeed, formatVerticalSpeed } from '../format';
import { emptyReading, engineChangesBy, engineStates, engineStatesAfter, readVehicle, sideBySide } from '../telemetry';
import { buildTimeAxis, quietGaps } from '../timeAxis';

describe('quietGaps', () => {
  it('finds long event-free stretches with margins', () => {
    const gaps = quietGaps([0, 69, 139, 508, 1520, 7938, 9591, 11292], -10, 11320);
    expect(gaps).toEqual([
      [568, 1460],
      [1580, 7878],
      [7998, 9531],
      [9651, 11232],
    ]);
  });

  it('returns nothing for a busy flight', () => {
    expect(quietGaps([0, 60, 120, 180, 240], -10, 260)).toEqual([]);
  });
});

describe('buildTimeAxis', () => {
  it('maps the ends to 0 and 1 and is monotonic', () => {
    const axis = buildTimeAxis(-10, 11320, [
      [700, 1500],
      [4000, 7800],
    ]);
    expect(axis.toX(-10)).toBe(0);
    expect(axis.toX(11320)).toBe(1);
    let prev = -1;
    for (let t = -10; t <= 11320; t += 7) {
      const x = axis.toX(t);
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
  });

  it('inverts toX with toT', () => {
    const axis = buildTimeAxis(-10, 4000, [[1600, 2400]]);
    for (const t of [-10, 0, 69, 160, 900, 1600, 2000, 2400, 3999, 4000]) {
      expect(axis.toT(axis.toX(t))).toBeCloseTo(t, 6);
    }
  });

  it('gives long coasts a small fixed share of the width', () => {
    const axis = buildTimeAxis(0, 10000, [[1000, 9000]]);
    const coastWidth = axis.toX(9000) - axis.toX(1000);
    expect(coastWidth).toBeLessThan(0.15);
    expect(axis.breaks).toHaveLength(1);
  });

  it('ignores coasts outside the range or too short to matter', () => {
    const axis = buildTimeAxis(0, 600, [
      [700, 900],
      [100, 130],
    ]);
    expect(axis.breaks).toHaveLength(0);
    expect(axis.toX(300)).toBeCloseTo(0.5, 6);
  });
});

describe('formatting', () => {
  it('formats the mission clock', () => {
    expect(formatClock(-10)).toEqual({ sign: 'T−', hms: '00:00:10' });
    expect(formatClock(-0.4)).toEqual({ sign: 'T−', hms: '00:00:01' });
    expect(formatClock(0)).toEqual({ sign: 'T+', hms: '00:00:00' });
    expect(formatClock(3725.9)).toEqual({ sign: 'T+', hms: '01:02:05' });
  });

  it('formats event times compactly', () => {
    expect(formatEventTime(69)).toBe('T+1:09');
    expect(formatEventTime(11292)).toBe('T+3:08:12');
    expect(formatEventTime(-10)).toBe('T−0:10');
  });

  it('formats speeds and altitudes in each unit', () => {
    expect(formatSpeed(1000, 'kmh')).toEqual({ value: '3,600', unit: 'km/h' });
    expect(formatSpeed(1000, 'mph')).toEqual({ value: '2,237', unit: 'mph' });
    expect(formatSpeed(-5, 'ms')).toEqual({ value: '0', unit: 'm/s' });
    expect(formatAltitude(5234, 'km')).toEqual({ value: '5.2', unit: 'km' });
    expect(formatAltitude(1609.344, 'mi')).toEqual({ value: '1.0', unit: 'mi' });
    expect(formatAltitude(100, 'ft')).toEqual({ value: '328', unit: 'ft' });
    expect(formatVerticalSpeed(-557, 'kmh')).toBe('↓ 557 m/s');
    expect(formatVerticalSpeed(253.4, 'mph')).toBe('↑ 567 mph');
  });

  it('drops the vertical-speed arrow when the speed rounds to zero', () => {
    expect(formatVerticalSpeed(-0.3, 'kmh')).toBe('0 m/s');
    expect(formatVerticalSpeed(0, 'ms')).toBe('0 m/s');
    expect(formatVerticalSpeed(0.6, 'kmh')).toBe('↑ 1 m/s');
    expect(formatVerticalSpeed(-0.6, 'kmh')).toBe('↓ 1 m/s');
  });

  it('formats dates the way the site writes them', () => {
    expect(formatDate('2026-09-28')).toBe('28 Sept 2026');
    expect(formatDate('2023-04-20')).toBe('20 Apr 2023');
  });
});

describe('engine states', () => {
  const tl: EngineTimeline = {
    slots: [0, 1, 2].map((k) => ({ x: k, z: 0, exitRadius: 0.65, ring: 'center' as const, vacuum: false })),
    changes: [
      { t: 1, engine: 0, state: ENGINE_LIT },
      { t: 1, engine: 1, state: ENGINE_LIT },
      { t: 2, engine: 1, state: ENGINE_OFF },
      { t: 3, engine: 2, state: ENGINE_FAILED },
    ],
  };

  it('counts the changes that have happened, including those exactly at t', () => {
    expect([0, 0.99, 1, 1.5, 2, 2.99, 3, 9].map((t) => engineChangesBy(tl, t))).toEqual([0, 0, 2, 2, 3, 3, 4, 4]);
  });

  it('gives the same states from a change count as from a time', () => {
    const a = new Uint8Array(3);
    const b = new Uint8Array(3);
    for (const t of [0, 1, 1.5, 2, 2.5, 3, 4]) {
      expect(Array.from(engineStates(tl, t, a))).toEqual(Array.from(engineStatesAfter(tl, engineChangesBy(tl, t), b)));
    }
    expect(Array.from(engineStates(tl, 2.5, a))).toEqual([ENGINE_LIT, ENGINE_OFF, ENGINE_OFF]);
    expect(engineStates(tl, 9, a)).toBe(a);
    expect(Array.from(a)).toEqual([ENGINE_LIT, ENGINE_OFF, ENGINE_FAILED]);
  });
});

describe('HUD altitude', () => {
  const r = emptyReading();
  const alt = (result: FlightResult, vehicle: VehicleId, t: number) => readVehicle(result, vehicle, t, r).alt;
  /** First time the vehicle is in the water or in the tower's arms. */
  const touchdown = (result: FlightResult, vehicle: VehicleId) => {
    const track = vehicle === 'booster' ? result.booster : result.ship;
    for (let i = 0; i < track.n; i++) if (track.phase[i] === Phase.Splashed || track.phase[i] === Phase.Caught) return track.t[i];
    throw new Error(`Flight ${result.flight} ${vehicle} never touches down`);
  };
  const flight5 = simulateFlight(5, { asFlown: true, interventions: [] });
  const flight10 = simulateFlight(10, { asFlown: true, interventions: [] });

  it('reads 0 on the mount, and the same for both vehicles while they are stacked', () => {
    expect(alt(flight5, 'booster', flight5.tStart)).toBe(0);
    expect(alt(flight5, 'ship', flight5.tStart)).toBe(0);
    for (let t = 0; t < (flight5.separationT ?? 0); t += 7) expect(alt(flight5, 'ship', t)).toBe(alt(flight5, 'booster', t));
    expect(alt(flight5, 'ship', 60)).toBeGreaterThan(5000);
  });

  it('stays above 0 until the vehicle touches the water', () => {
    for (const [result, vehicle] of [
      [flight5, 'ship'],
      [flight10, 'booster'],
    ] as const) {
      const t = touchdown(result, vehicle);
      expect(alt(result, vehicle, t - 1)).toBeGreaterThan(2);
      expect(alt(result, vehicle, t)).toBeLessThan(0.5);
    }
  });

  it('measures a tower catch from the mount deck', () => {
    const t = touchdown(flight5, 'booster');
    expect(alt(flight5, 'booster', t - 5)).toBeGreaterThan(alt(flight5, 'booster', t));
    expect(alt(flight5, 'booster', t)).toBeLessThan(10);
  });
});

describe('split view', () => {
  const flight10 = simulateFlight(10, { asFlown: true, interventions: [] });
  const sep = flight10.separationT ?? NaN;
  /** Middle of a vehicle's model at t (as the stage frames it), from its centre of mass and attitude. */
  const middle = (track: FlightResult['booster'], length: number, t: number) => {
    let i = 0;
    while (i < track.n - 2 && track.t[i + 1] <= t) i++;
    const f = Math.min(1, Math.max(0, (t - track.t[i]) / (track.t[i + 1] - track.t[i])));
    const at = (a: ArrayLike<number>, size: number, k: number) => a[size * i + k] + (a[size * (i + 1) + k] - a[size * i + k]) * f;
    const [qx, qy, qz, qw] = [0, 1, 2, 3].map((k) => at(track.quat, 4, k));
    const axis = [2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw)];
    return [0, 1, 2].map((k) => at(track.pos, 3, k) + axis[k] * (length / 2 - at(track.com, 1, 0)));
  };

  it('starts once the vehicles are 3 km apart, never after the stage splits', () => {
    expect(sideBySide(flight10, sep - 1)).toBe(false);
    expect(sideBySide(flight10, sep + 5)).toBe(false);
    let on = NaN;
    for (let t = sep; t < sep + 60 && Number.isNaN(on); t += 0.01) if (sideBySide(flight10, t)) on = t;
    // Flight 10 flies Block 2 vehicles, 70.8 m and 52.1 m long.
    let apart = NaN;
    for (let t = sep; t < sep + 60 && Number.isNaN(apart); t += 0.01) {
      const b = middle(flight10.booster, 70.8, t);
      const s = middle(flight10.ship, 52.1, t);
      if (Math.hypot(b[0] - s[0], b[1] - s[1], b[2] - s[2]) >= 3000) apart = t;
    }
    expect(on).toBeLessThanOrEqual(apart);
    expect(apart - on).toBeLessThan(0.3);
  });

  it('ends when the booster has left the view after its splashdown', () => {
    const end = flight10.booster.end;
    expect(sideBySide(flight10, end + 30)).toBe(true);
    expect(sideBySide(flight10, end + 46)).toBe(false);
  });
});
