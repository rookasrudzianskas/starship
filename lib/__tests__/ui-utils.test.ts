import { describe, expect, it } from 'vitest';
import { formatAltitude, formatClock, formatDate, formatEventTime, formatSpeed, formatVerticalSpeed } from '../format';
import { buildTimeAxis } from '../timeAxis';

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
  });

  it('formats dates the way the site writes them', () => {
    expect(formatDate('2026-09-28')).toBe('28 Sept 2026');
    expect(formatDate('2023-04-20')).toBe('20 Apr 2023');
  });
});
