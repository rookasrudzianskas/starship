import { describe, expect, it } from 'vitest';
import { soundLevels, type SoundInput } from '../audio/levels';

const full: SoundInput = { throttle: 1, lit: 33, engines: 33, altitude: 0, dynamicPressure: 0, ended: false };

describe('simulation sound', () => {
  it('cuts the engine rumble when engines shut down and reduces it with lost engines or throttle', () => {
    const nominal = soundLevels(full);
    expect(soundLevels({ ...full, lit: 0 }).rumble).toBe(0);
    expect(soundLevels({ ...full, throttle: 0 }).rumble).toBe(0);
    expect(soundLevels({ ...full, lit: 20 }).rumble).toBeLessThan(nominal.rumble);
    expect(soundLevels({ ...full, throttle: 0.5 }).rumble).toBeLessThan(nominal.rumble);
  });

  it('keeps entry airflow without engines, and no atmospheric roar in vacuum', () => {
    expect(soundLevels({ ...full, lit: 0, dynamicPressure: 30_000 }).air).toBeGreaterThan(0);
    expect(soundLevels({ ...full, altitude: 300_000 }).air).toBeLessThan(0.00001);
    expect(soundLevels({ ...full, altitude: 300_000 }).rumble).toBeGreaterThan(0);
  });

  it('silences a vehicle after impact, catch or splashdown', () => {
    const levels = soundLevels({ ...full, ended: true, dynamicPressure: 60_000 });
    expect(levels.rumble).toBe(0);
    expect(levels.air).toBe(0);
  });
});
