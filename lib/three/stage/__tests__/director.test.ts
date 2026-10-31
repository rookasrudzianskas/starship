import { describe, expect, it } from 'vitest';
import { Phase, type FlightResult, type Track } from '../../../sim/types';
import { autoShot, pickedShot, pipVehicle, planDirector, type DirectorPlan } from '../director';

/** The plan of a nominal flight like Flight 14: the booster lands (at sea) long before the ship's engine cutoff. */
const nominal: DirectorPlan = {
  sep: 139.4,
  hotStage: 135.8,
  boostbackEnd: 176,
  boosterLanding: 396.8,
  boosterEnd: 415.3,
  boosterCatch: false,
  boosterTouchdown: 406.4,
  shipSeco: 508.1,
  shipEntry: 9590.3,
  shipLanding: 11254.6,
  shipTouchdown: 11285.4,
  releases: [2114.9, 2182.7, 2250.6],
  shipEnd: 11293.2,
  shipLands: true,
  boosterLands: true,
  boosterBreaksUp: false,
  shipBreaksUp: false,
};

/** Flight 1: no separation, and the stack is terminated at T+241. */
const terminated: DirectorPlan = {
  ...nominal,
  sep: null,
  hotStage: null,
  boostbackEnd: 0,
  boosterLanding: 221,
  boosterEnd: 241,
  boosterTouchdown: null,
  shipEntry: Infinity,
  shipLanding: 216,
  shipTouchdown: null,
  releases: [],
  shipEnd: 241,
  shipLands: false,
  boosterLands: false,
  boosterBreaksUp: true,
  shipBreaksUp: true,
};

describe('picture in picture follows the resolved main camera', () => {
  it('shows the booster when a ship-mounted shot overrides the booster follow selection', () => {
    const shot = pickedShot('ship-aft', 300, nominal, 'booster');
    expect(shot.vehicle).toBe('ship');
    expect(pipVehicle('webcast', 'booster', true, shot)).toBe('booster');
  });

  it('shows the ship during a director cut to booster hot staging, even when following the ship', () => {
    const shot = autoShot(140, nominal, 'ship');
    expect(shot.vehicle).toBe('booster');
    expect(pipVehicle('webcast', 'ship', true, shot)).toBe('ship');
  });

  it('preserves follow-based chase, free and globe insets regardless of the previous webcast shot', () => {
    const staleShot = pickedShot('ship-aft', 300, nominal, 'booster');
    for (const camera of ['chase', 'free'] as const) {
      expect(pipVehicle(camera, 'booster', true, staleShot)).toBe('ship');
      expect(pipVehicle(camera, 'ship', true, staleShot)).toBe('booster');
      expect(pipVehicle(camera, 'both', true, staleShot)).toBeNull();
    }
    expect(pipVehicle('globe', 'booster', true, staleShot)).toBe('booster');
    expect(pipVehicle('globe', 'ship', true, staleShot)).toBe('ship');
    expect(pipVehicle('globe', 'both', false, staleShot)).toBe('booster');
    expect(pipVehicle('webcast', 'ship', false, staleShot)).toBeNull();
  });
});

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

  it('leaves the debris of a vehicle lost in flight for the other vehicle after a few seconds', () => {
    // Flight 7: the ship breaks up after the booster has been caught.
    const lost: DirectorPlan = { ...nominal, boosterCatch: true, shipEntry: Infinity, shipEnd: 476, shipLands: false, shipBreaksUp: true, shipTouchdown: null };
    expect(autoShot(480, lost, 'both')).toEqual({ id: 'ship-aft', vehicle: 'ship' });
    expect(autoShot(485, lost, 'both')).toEqual({ id: 'tower', vehicle: 'booster' });
  });

  it("never cuts to the entry camera for a ship that doesn't come back", () => {
    const lost: DirectorPlan = { ...nominal, shipEntry: Infinity, shipEnd: 476, shipLands: false };
    for (let t = 150; t < 500; t += 5) expect(autoShot(t, lost, 'ship').id).not.toBe('ship-nose');
  });

  it('shows staging from the booster looking up, then from alongside as the two part, whichever is followed', () => {
    for (const follow of ['both', 'booster', 'ship'] as const) {
      expect(autoShot(133, nominal, follow).id).toBe('tracking');
      // From shortly before the ship's engines light until it has just pulled clear of the booster...
      expect(autoShot(133.4, nominal, follow).id).toBe('booster-top');
      expect(autoShot(141.1, nominal, follow).id).toBe('booster-top');
      // ...then a long lens on both, before the booster's engine camera takes over for its boostback.
      expect(autoShot(141.3, nominal, follow).id).toBe('separation');
      expect(autoShot(151.3, nominal, follow).id).toBe('separation');
    }
    expect(autoShot(151.5, nominal, 'both')).toEqual({ id: 'booster-aft', vehicle: 'booster' });
    expect(autoShot(151.5, nominal, 'ship')).toEqual({ id: 'ship-aft', vehicle: 'ship' });
    // Without hot staging the booster's camera comes up a few seconds before separation.
    expect(autoShot(nominal.sep! - 4.4, { ...nominal, hotStage: null }, 'both').id).toBe('booster-top');
  });

  it("watches each satellite leave the ship's payload door", () => {
    for (const follow of ['both', 'ship'] as const) {
      expect(autoShot(2110, nominal, follow).id).toBe('ship-aft');
      expect(autoShot(2112, nominal, follow)).toEqual({ id: 'payload', vehicle: 'ship' });
      expect(autoShot(2136, nominal, follow).id).toBe('payload');
      expect(autoShot(2140, nominal, follow).id).toBe('ship-aft');
      expect(autoShot(2250, nominal, follow).id).toBe('payload');
    }
    expect(pickedShot('payload', 2112, nominal, 'both')).toBe(autoShot(2112, nominal, 'both'));
  });

  it('stays on the tracker once a stack that never separated has broken up', () => {
    for (let t = 230; t < 260; t += 0.5) {
      const shot = autoShot(t, terminated, 'both');
      expect(shot.id === 'tracking' || t < terminated.boosterEnd).toBe(true);
    }
    expect(autoShot(250, terminated, 'both').id).toBe('tracking');
  });

  it('reuses its shots instead of making new ones every frame', () => {
    expect(autoShot(300, nominal, 'both')).toBe(autoShot(301, nominal, 'both'));
    expect(pickedShot('tower', 300, nominal, 'both')).toBe(autoShot(nominal.boosterLanding, { ...nominal, boosterCatch: true }, 'both'));
  });
});

describe('pickedShot', () => {
  it('hands an onboard camera over to the buoy once its vehicle is down in the water', () => {
    expect(pickedShot('ship-aft', nominal.shipTouchdown! - 1, nominal, 'both')).toEqual({ id: 'ship-aft', vehicle: 'ship' });
    expect(pickedShot('ship-aft', nominal.shipTouchdown! + 1, nominal, 'both')).toEqual({ id: 'buoy', vehicle: 'ship' });
    expect(pickedShot('ship-nose', nominal.shipEnd + 5, nominal, 'ship')).toEqual({ id: 'buoy', vehicle: 'ship' });
    expect(pickedShot('booster-aft', nominal.boosterTouchdown! + 1, nominal, 'both')).toEqual({ id: 'buoy', vehicle: 'booster' });
    // Long after, the director's shot.
    expect(pickedShot('booster-top', nominal.boosterEnd + 30, nominal, 'both')).toBe(autoShot(nominal.boosterEnd + 30, nominal, 'both'));
  });

  it('shows the director instead of the tower camera while the launch steam surrounds it', () => {
    expect(pickedShot('tower', 5, nominal, 'both').id).toBe('tower');
    expect(pickedShot('tower', 60, nominal, 'both')).toBe(autoShot(60, nominal, 'both'));
    expect(pickedShot('tower', 300, nominal, 'both').id).toBe('tower');
  });

  it('points the pad and the tracker at the vehicle the director follows when following both', () => {
    expect(pickedShot('tracking', 160, nominal, 'both').vehicle).toBe('booster');
    expect(pickedShot('tracking', 300, nominal, 'both').vehicle).toBe('ship');
    expect(pickedShot('pad', 400, nominal, 'both').vehicle).toBe('booster');
    expect(pickedShot('tracking', 300, nominal, 'booster').vehicle).toBe('booster');
  });

  it('points the splashdown buoy at the vehicle that comes down next when following both', () => {
    expect(pickedShot('buoy', 60, nominal, 'both').vehicle).toBe('booster');
    expect(pickedShot('buoy', nominal.boosterEnd + 30, nominal, 'both').vehicle).toBe('ship');
    expect(pickedShot('buoy', 60, { ...nominal, boosterLands: false }, 'both').vehicle).toBe('ship');
    expect(pickedShot('buoy', 60, nominal, 'ship').vehicle).toBe('ship');
    expect(pickedShot('buoy', nominal.boosterEnd + 30, nominal, 'booster').vehicle).toBe('booster');
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
      payload: [],
      booster: track(415.9, 'catch', [[0, Phase.Ascent], [161.7, Phase.Flip], [390.6, Phase.LandingBurn], [410.9, Phase.Caught]]),
      ship: track(476, 'lost', [[0, Phase.Ascent], [163, Phase.Ascent], [476, Phase.Destroyed]]),
    } as unknown as FlightResult;
    expect(planDirector(r).shipEntry).toBe(Infinity);
  });
});
