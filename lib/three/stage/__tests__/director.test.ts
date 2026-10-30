import { describe, expect, it } from 'vitest';
import { Phase, type FlightResult, type Track } from '../../../sim/types';
import { autoShot, pickedShot, planDirector, type DirectorPlan } from '../director';

/** The plan of a nominal flight like Flight 14: the booster lands (at sea) long before the ship's engine cutoff. */
const nominal: DirectorPlan = {
  sep: 139.4,
  boostbackEnd: 176,
  boosterLanding: 396.8,
  boosterEnd: 415.3,
  boosterCatch: false,
  shipSeco: 508.1,
  shipEntry: 9590.3,
  shipLanding: 11254.6,
  shipEnd: 11293.2,
  shipLands: true,
  boosterLands: true,
};

describe('autoShot', () => {
  it('shows the booster land in the main view while the ship is still burning, as the broadcast does', () => {
    for (let t = nominal.boosterLanding - 12; t <= nominal.boosterEnd + 12; t += 0.5) {
      const shot = autoShot(t, nominal, 'both');
      expect(shot.vehicle).toBe('booster');
      expect(shot.id).toBe('buoy');
    }
    expect(autoShot(nominal.boosterLanding - 20, nominal, 'both').vehicle).toBe('ship');
    expect(autoShot(nominal.boosterEnd + 20, nominal, 'both').vehicle).toBe('ship');
  });

  it('cuts to the tower for a catch', () => {
    expect(autoShot(nominal.boosterLanding, { ...nominal, boosterCatch: true }, 'both').id).toBe('tower');
  });

  it("never cuts to the entry camera for a ship that doesn't come back", () => {
    const lost: DirectorPlan = { ...nominal, shipEntry: Infinity, shipEnd: 476, shipLands: false };
    for (let t = 150; t < 500; t += 5) expect(autoShot(t, lost, 'ship').id).not.toBe('ship-nose');
  });

  it('reuses its shots instead of making new ones every frame', () => {
    expect(autoShot(300, nominal, 'both')).toBe(autoShot(301, nominal, 'both'));
    expect(pickedShot('tower', 300, nominal, 'both')).toBe(autoShot(nominal.boosterLanding, { ...nominal, boosterCatch: true }, 'both'));
  });
});

describe('planDirector', () => {
  /** A track whose phases change at the given times. */
  function track(end: number, endKind: Track['endKind'], phases: [number, number][]): Track {
    const t = new Float64Array(phases.map((p) => p[0]));
    const phase = new Uint8Array(phases.map((p) => p[1]));
    return { n: phases.length, t, phase, start: 0, end, endKind } as unknown as Track;
  }

  it('gives a ship lost during its ascent no entry', () => {
    const r = {
      separationT: 161.7,
      events: [],
      booster: track(415.9, 'catch', [[0, Phase.Ascent], [161.7, Phase.Flip], [390.6, Phase.LandingBurn], [410.9, Phase.Caught]]),
      ship: track(476, 'lost', [[0, Phase.Ascent], [163, Phase.Ascent], [476, Phase.Destroyed]]),
    } as unknown as FlightResult;
    expect(planDirector(r).shipEntry).toBe(Infinity);
  });
});
