import { describe, expect, it } from 'vitest';
import { PADS } from '../../flights/catalog';
import { latLonAltToEcef } from '../geo';
import { simulateFlight } from '../simulate';
import { EARTH_RADIUS, type FlightResult, type Intervention, type Scenario } from '../types';

const AS_FLOWN: Scenario = { asFlown: true, interventions: [] };
const PLAN: Scenario = { asFlown: false, interventions: [] };
const run = (flight: number, s: Scenario) => simulateFlight(flight, s);
const eventT = (r: FlightResult, key: string, vehicle?: string) =>
  r.events.find((e) => e.key === key && (!vehicle || e.vehicle === vehicle))?.t;
const with_ = (base: Scenario, ...ivs: Intervention[]): Scenario => ({ ...base, interventions: ivs });

describe('interventions', () => {
  it('booster engines out at T+30: the others make up for a few, more stage later but still stage', () => {
    const base = run(5, AS_FLOWN);
    const out = (engines: number[]): Intervention[] => engines.map((engine, i) => ({ id: `e${i}`, t: 30, kind: 'engine-out', vehicle: 'booster', engine }));
    const three = run(5, with_(AS_FLOWN, ...out([14, 20, 27])));
    expect(three.separationT as number).toBeCloseTo(base.separationT as number, 0);
    expect(three.events.filter((e) => e.key === 'intervention')).toHaveLength(3);
    const eight = run(5, with_(AS_FLOWN, ...out([13, 15, 18, 20, 23, 25, 28, 30])));
    expect(eight.separationT).not.toBeNull();
    expect(eight.separationT as number).toBeGreaterThan((base.separationT as number) + 2);
  });

  it('a ship throttle ceiling of 50% makes the ascent burn longer', () => {
    const base = run(10, AS_FLOWN);
    // Set once the ship is light enough to climb at half thrust (right after staging it could not).
    const r = run(10, with_(AS_FLOWN, { id: 't', t: 300, kind: 'throttle', vehicle: 'ship', value: 0.5 }));
    expect(eventT(r, 'seco')).toBeDefined();
    expect(eventT(r, 'seco') as number).toBeGreaterThan((eventT(base, 'seco') as number) + 15);
  });

  it('terminate ends the flight with a termination', () => {
    const stack = run(5, with_(AS_FLOWN, { id: 'f', t: 80, kind: 'terminate', vehicle: 'ship' }));
    expect(stack.booster.endKind).toBe('termination');
    expect(stack.ship.endKind).toBe('termination');
    expect(stack.ship.end).toBeCloseTo(80, 6);
    const ship = run(5, with_(AS_FLOWN, { id: 'f', t: 300, kind: 'terminate', vehicle: 'ship' }));
    expect(ship.ship.endKind).toBe('termination');
    expect(ship.ship.end).toBeCloseTo(300, 6);
    expect(ship.booster.endKind).toBe('catch');
    expect(ship.events.some((e) => e.key === 'ship-end' && e.short === 'FTS')).toBe(true);
  });

  it('stage-now at T+100 separates earlier and leaves a slower ship', () => {
    const base = run(5, AS_FLOWN);
    const r = run(5, with_(AS_FLOWN, { id: 's', t: 100, kind: 'stage-now' }));
    expect(r.separationT as number).toBeLessThan(110);
    expect(r.separationT as number).toBeLessThan(base.separationT as number);
    // Speed at the end of the ship's ascent burn (it runs short of propellant).
    const burnEnd = (x: FlightResult) => {
      const tr = x.ship;
      let best = 0;
      for (let i = 0; i < tr.n && tr.t[i] < 800; i++) best = Math.max(best, tr.speed[i]);
      return best;
    };
    expect(burnEnd(r)).toBeLessThan(burnEnd(base) - 150);
  });

  it('skipping the boostback sends the booster into the Gulf far downrange', () => {
    const r = run(5, with_(AS_FLOWN, { id: 'k', t: 120, kind: 'skip-burn', vehicle: 'booster' }));
    expect(eventT(r, 'boostback')).toBeUndefined();
    expect(r.booster.endKind).toBe('impact');
    const i = r.booster.n - 1;
    const p = [r.booster.pos[3 * i], r.booster.pos[3 * i + 1], r.booster.pos[3 * i + 2]];
    const pad = latLonAltToEcef(PADS.pad1.lat, PADS.pad1.lon, 0);
    const ang = Math.acos((p[0] * pad[0] + p[1] * pad[1] + p[2] * pad[2]) / (Math.hypot(...p) * Math.hypot(...pad)));
    expect(ang * EARTH_RADIUS).toBeGreaterThan(200_000);
  });

  it('a pitch bias changes the ascent', () => {
    const base = run(5, AS_FLOWN);
    const r = run(5, with_(AS_FLOWN, { id: 'p', t: 40, kind: 'pitch', vehicle: 'booster', deg: 6 }));
    expect(r.records.boosterApogee).not.toBeCloseTo(base.records.boosterApogee, -3);
  });
});

describe('scenario overrides', () => {
  it('Flight 10 with a catch gets caught', () => {
    const r = run(10, { ...AS_FLOWN, boosterRecovery: 'catch' });
    expect(r.booster.endKind).toBe('catch');
    expect(r.events.some((e) => e.key === 'booster-end' && e.short === 'BOOSTER CATCH')).toBe(true);
  });

  it('Flight 10 flown to orbit stays up for an orbit or comes back after a deorbit burn', () => {
    const r = run(10, { ...AS_FLOWN, shipMission: 'orbital' });
    expect(eventT(r, 'orbit-insertion')).toBeDefined();
    const deorbit = eventT(r, 'deorbit');
    if (deorbit === undefined) expect(r.ship.endKind).toBe('orbit');
    else expect(['splashdown', 'impact', 'lost']).toContain(r.ship.endKind);
    expect(r.ship.end).toBeGreaterThan(4_000);
  });

  it('Flight 7 flown to plan (no anomalies) splashes down', () => {
    const r = run(7, PLAN);
    expect(r.ship.endKind).toBe('splashdown');
    expect(r.events.some((e) => e.key === 'anomaly')).toBe(false);
  });

  it('a lighter booster load and a strong jet stream still fly a complete mission', () => {
    const r = run(11, { ...AS_FLOWN, boosterLoad: 0.9, wind: 60 });
    expect(r.separationT).not.toBeNull();
    expect(['splashdown', 'impact', 'lost']).toContain(r.booster.endKind);
    expect(['splashdown', 'impact', 'lost', 'orbit']).toContain(r.ship.endKind);
  });

  it('extra Starlinks are deployed and recorded', () => {
    const r = run(11, { ...AS_FLOWN, payloadCount: 12 });
    expect(r.payload).toHaveLength(12);
    expect(r.payload[0].t).toBeGreaterThan(eventT(r, 'payload-start') as number);
    const none = run(4, { ...AS_FLOWN, payloadCount: 5 });
    expect(none.payload).toHaveLength(5);
  });
});
