import { describe, expect, it } from 'vitest';
import { getFlight, PADS } from '../../flights/catalog';
import { engineStatesAt } from '../engines';
import { ecefToLatLonAlt, latLonAltToEcef, surfaceDistance } from '../geo';
import { isLand } from '../land';
import { simulateFlight } from '../simulate';
import { EARTH_MU, EARTH_RADIUS, ENGINE_LIT, G0, Phase, type EngineTimeline, type FlightResult, type Intervention, type Scenario, type Track } from '../types';

/**
 * Flight director scenarios: whatever the user does, the outcome stays physically sensible.
 */
const AS_FLOWN: Scenario = { asFlown: true, interventions: [] };
const PLAN: Scenario = { asFlown: false, interventions: [] };
const run = (flight: number, s: Scenario) => simulateFlight(flight, s);
const ev = (r: FlightResult, key: string, vehicle?: string) => r.events.find((e) => e.key === key && (!vehicle || e.vehicle === vehicle));
/** `k` outer-ring booster engines out at time t, spread around the ring. */
const outerOut = (k: number, t: number): Intervention[] =>
  Array.from({ length: k }, (_, i) => ({ id: `e${i}`, t, kind: 'engine-out' as const, vehicle: 'booster' as const, engine: 13 + Math.round((i * 20) / k) }));

function litAt(tl: EngineTimeline, t: number): number {
  const st = engineStatesAt(tl, t, new Uint8Array(tl.slots.length));
  return st.reduce((n, s) => n + (s === ENGINE_LIT ? 1 : 0), 0);
}

function indexAt(tr: Track, t: number): number {
  let i = 0;
  while (i < tr.n - 1 && tr.t[i + 1] <= t) i++;
  return i;
}

function endLatLon(tr: Track): { lat: number; lon: number } {
  const i = tr.n - 1;
  return ecefToLatLonAlt(tr.pos[3 * i], tr.pos[3 * i + 1], tr.pos[3 * i + 2]);
}

/** Highest dynamic pressure of the ship's entry (hypersonic and belly flop), Pa. */
function entryLoads(r: FlightResult): number {
  let q = 0;
  for (let i = 0; i < r.ship.n; i++) if (r.ship.phase[i] === Phase.Entry || r.ship.phase[i] === Phase.BellyFlop) q = Math.max(q, r.ship.q[i]);
  return q;
}

/** Angle (deg) between the body +Y axis and the local vertical at sample i. */
function tiltAt(tr: Track, i: number): number {
  const x = tr.quat[4 * i], y = tr.quat[4 * i + 1], z = tr.quat[4 * i + 2], w = tr.quat[4 * i + 3];
  const yx = 2 * (x * y - z * w), yy = 1 - 2 * (x * x + z * z), yz = 2 * (y * z + x * w);
  const px = tr.pos[3 * i], py = tr.pos[3 * i + 1], pz = tr.pos[3 * i + 2];
  const l = Math.hypot(px, py, pz);
  return (Math.acos(Math.min(1, (yx * px + yy * py + yz * pz) / l)) * 180) / Math.PI;
}

/** Height of the vehicle's base (the engine plane) above the sea at sample i, m. */
function baseHeight(tr: Track, i: number): number {
  const x = tr.quat[4 * i], y = tr.quat[4 * i + 1], z = tr.quat[4 * i + 2], w = tr.quat[4 * i + 3];
  const c = tr.com[i];
  const bx = tr.pos[3 * i] - 2 * (x * y - z * w) * c;
  const by = tr.pos[3 * i + 1] - (1 - 2 * (x * x + z * z)) * c;
  const bz = tr.pos[3 * i + 2] - 2 * (y * z + x * w) * c;
  return Math.hypot(bx, by, bz) - EARTH_RADIUS;
}

/**
 * Lean of a landing from time `from` (deg): the most over the last `band` metres above where the descent ends (in
 * the arms or at the water), and at that moment.
 */
function landingLean(tr: Track, from: number, band: number): { max: number; end: number } {
  let k = tr.n - 1;
  while (k > 0 && (tr.phase[k] === Phase.Caught || tr.phase[k] === Phase.Splashed || tr.phase[k] === Phase.Destroyed)) k--;
  const hEnd = baseHeight(tr, k);
  let max = 0;
  for (let i = 0; i <= k; i++) if (tr.t[i] >= from && baseHeight(tr, i) - hEnd < band) max = Math.max(max, tiltAt(tr, i));
  return { max, end: tiltAt(tr, k) };
}

/** Thrust and drag acceleration between samples i − 1 and i, in g (the frame's own terms, under 0.2 g, are left in). */
function forceG(tr: Track, i: number): number {
  const dt = tr.t[i] - tr.t[i - 1];
  const px = tr.pos[3 * i], py = tr.pos[3 * i + 1], pz = tr.pos[3 * i + 2];
  const r = Math.hypot(px, py, pz);
  const g = EARTH_MU / (r * r * r);
  const ax = (tr.vel[3 * i] - tr.vel[3 * i - 3]) / dt + g * px;
  const ay = (tr.vel[3 * i + 1] - tr.vel[3 * i - 2]) / dt + g * py;
  const az = (tr.vel[3 * i + 2] - tr.vel[3 * i - 1]) / dt + g * pz;
  return Math.hypot(ax, ay, az) / G0;
}

describe('engine-outs on the climb', () => {
  it('a V3 booster makes up for engines out by throttling up, then lofts, and never dives into thick air', () => {
    const nominal = run(14, AS_FLOWN);
    for (const k of [6, 9, 12]) {
      const r = run(14, { ...AS_FLOWN, interventions: outerOut(k, 20) });
      expect(r.separationT, `${k} out`).not.toBeNull();
      const i = indexAt(r.booster, r.separationT as number);
      expect(r.booster.alt[i], `${k} out: staging altitude`).toBeGreaterThan(45_000);
      let qMax = 0;
      for (let j = 0; j <= i; j++) qMax = Math.max(qMax, r.booster.q[j]);
      expect(qMax, `${k} out: max q`).toBeLessThan(40_000);
    }
    // Six out of 33 at a 78% throttle: the other 27 restore the planned thrust, so the climb is unchanged.
    const six = run(14, { ...AS_FLOWN, interventions: outerOut(6, 20) });
    expect(six.separationT as number).toBeCloseTo(nominal.separationT as number, 0);
  });

  it('a stack too weak to climb breaks up from aerodynamic loads instead of flying on at hypersonic speed', () => {
    const r = run(14, { ...AS_FLOWN, interventions: outerOut(16, 20) });
    expect(r.separationT).toBeNull();
    expect(r.booster.endKind).toBe('lost');
    expect(r.events.some((e) => e.key === 'anomaly' && /Aerodynamic loads/.test(e.note ?? ''))).toBe(true);
    let qMax = 0;
    for (let j = 0; j < r.booster.n; j++) qMax = Math.max(qMax, r.booster.q[j]);
    expect(qMax).toBeLessThan(85_000);
  });

  it('one event per engine the user shuts down', () => {
    const r = run(5, { ...AS_FLOWN, interventions: outerOut(3, 30) });
    expect(r.events.filter((e) => e.key === 'intervention')).toHaveLength(3);
    expect(r.events.filter((e) => e.key === 'engine-out')).toHaveLength(0);
  });

  it('a light jet stream changes the loads, not the whole ascent', () => {
    const calm = run(14, AS_FLOWN);
    const windy = run(14, { ...AS_FLOWN, wind: 30 });
    const alt = (r: FlightResult) => r.booster.alt[indexAt(r.booster, r.separationT as number)];
    expect(Math.abs(alt(windy) - alt(calm))).toBeLessThan(2_000);
    expect(Math.abs(windy.records.boosterApogee - calm.records.boosterApogee)).toBeLessThan(5_000);
  });
});

describe('booster return', () => {
  it('an ascent steering bias does not carry into the boostback, which keeps the landing propellant', () => {
    const nominal = run(10, AS_FLOWN);
    const r = run(10, { ...AS_FLOWN, interventions: [{ id: 'p', t: 30, kind: 'pitch', vehicle: 'booster', deg: -10 }] });
    const bb = ev(r, 'boostback')?.t as number;
    const end = ev(r, 'boostback-end')?.t as number;
    expect(end - bb).toBeLessThanOrEqual(120);
    expect(r.records.boosterTopSpeed).toBeLessThan(1.6 * nominal.records.boosterTopSpeed);
    const lb = ev(r, 'booster-landing-burn');
    if (lb) expect(litAt(r.boosterEngines, lb.t + 0.1)).toBeGreaterThan(0);
  });

  it('Flight 1 flown to plan boosts back, and its recovery choices take effect', () => {
    expect(ev(run(1, PLAN), 'boostback')).toBeDefined();
    expect(run(1, { ...PLAN, boosterRecovery: 'catch' }).booster.endKind).toBe('catch');
    expect(run(1, { ...PLAN, boosterRecovery: 'splashdown' }).booster.endKind).toBe('splashdown');
    const expended = run(1, { ...PLAN, boosterRecovery: 'expend' });
    expect(ev(expended, 'boostback')).toBeUndefined();
    expect(expended.booster.endKind).toBe('impact');
  });

  it('the tower takes a booster only upright and lined up, and eases it into the arms', () => {
    for (const [n, s] of [
      [5, AS_FLOWN],
      [7, AS_FLOWN],
      [8, AS_FLOWN],
      [10, { ...AS_FLOWN, boosterRecovery: 'catch' }],
      [5, { ...AS_FLOWN, wind: 90 }],
    ] as Array<[number, Scenario]>) {
      const r = run(n, s);
      const b = r.booster;
      expect(b.endKind, `F${n}`).toBe('catch');
      const caught = b.phase.indexOf(Phase.Caught);
      expect(tiltAt(b, caught - 1), `F${n} tilt at capture`).toBeLessThan(3);
      const mount = latLonAltToEcef(PADS[getFlight(n).pad].lat, PADS[getFlight(n).pad].lon, 0);
      const p = [b.pos[3 * (caught - 1)], b.pos[3 * (caught - 1) + 1], b.pos[3 * (caught - 1) + 2]];
      expect(surfaceDistance(Float64Array.from(p), Float64Array.from(mount)), `F${n} off the arms`).toBeLessThan(2);
      // No jump: consecutive samples through the settle stay within a few centimetres per step.
      for (let i = caught - 1; i < Math.min(b.n - 1, caught + 30); i++) {
        const d = Math.hypot(b.pos[3 * i + 3] - b.pos[3 * i], b.pos[3 * i + 4] - b.pos[3 * i + 1], b.pos[3 * i + 5] - b.pos[3 * i + 2]);
        expect(d, `F${n} settle step`).toBeLessThan(0.2);
      }
    }
  });

  it('a booster that cannot reach the tower, or is too heavy for it, sets down in the Gulf instead', () => {
    const short = run(13, { ...AS_FLOWN, boosterRecovery: 'catch' });
    expect(short.booster.endKind).toBe('splashdown');
    expect(ev(short, 'boostback-end')?.note).toMatch(/Out of reach/);
    const heavy = run(5, { ...AS_FLOWN, interventions: [{ id: 's', t: 60, kind: 'stage-now' }] });
    expect(heavy.booster.endKind).toBe('splashdown');
    expect(ev(heavy, 'boostback')?.note).toMatch(/Too heavy/);
    const lb = ev(heavy, 'booster-landing-burn')?.t as number;
    expect(heavy.booster.end - lb).toBeLessThan(60);
  });

  it('a boostback with no engine left to light is not called out', () => {
    // Every engine out just after the staging command: nothing can relight for the return.
    const all = Array.from({ length: 33 }, (_, e) => ({ id: `e${e}`, t: 157, kind: 'engine-out' as const, vehicle: 'booster' as const, engine: e }));
    const r = run(5, { ...AS_FLOWN, interventions: all });
    expect(ev(r, 'boostback')).toBeUndefined();
    expect(r.booster.endKind).toBe('impact');
  });

  it('Flight 12 flown to plan boosts back at full thrust, like the 13-engine boostbacks before it', () => {
    const r = run(12, PLAN);
    const bb = ev(r, 'boostback')?.t as number;
    expect((ev(r, 'boostback-end')?.t as number) - bb).toBeLessThan(60);
    expect(r.booster.endKind).toBe('splashdown');
    // As flown, the boostback is still cut after 17 s and the booster still hits the Gulf.
    const flown = run(12, AS_FLOWN);
    expect((ev(flown, 'boostback-end')?.t as number) - (ev(flown, 'boostback')?.t as number)).toBeCloseTo(17, 0);
    expect(flown.booster.endKind).toBe('impact');
  });

  it('a splashed-down booster tips over from the way it leans, without snapping upright', () => {
    const b = run(13, AS_FLOWN).booster;
    const s = b.phase.indexOf(Phase.Splashed);
    for (let i = Math.max(1, s - 2); i < s + 10; i++) expect(Math.abs(tiltAt(b, i) - tiltAt(b, i - 1)), `step ${i}`).toBeLessThan(2);
  });

  it('a landing booster leans into its divert high up and comes down the last 100 m nearly upright', () => {
    for (const [n, s, end] of [
      [5, AS_FLOWN, 'catch'],
      [7, AS_FLOWN, 'catch'],
      [8, AS_FLOWN, 'catch'],
      [7, { ...AS_FLOWN, wind: 90 }, 'catch'],
      [11, { ...AS_FLOWN, boosterRecovery: 'catch' }, 'catch'],
      [4, AS_FLOWN, 'splashdown'],
      [10, AS_FLOWN, 'splashdown'],
      [13, AS_FLOWN, 'splashdown'], // short boostback: it lets its aim go and brakes where it falls
      [14, AS_FLOWN, 'splashdown'],
    ] as Array<[number, Scenario, string]>) {
      const r = run(n, s);
      expect(r.booster.endKind, `F${n}`).toBe(end);
      const lb = ev(r, 'booster-landing-burn')?.t as number;
      const low = landingLean(r.booster, lb, 100);
      expect(low.max, `F${n} lean over the last 100 m`).toBeLessThan(6);
      expect(low.end, `F${n} lean at the end`).toBeLessThan(3);
      expect(landingLean(r.booster, lb, 3_000).max, `F${n} lean in the divert`).toBeGreaterThan(8);
    }
  });

  it('the boostback throttles back as the booster gets light, to at most 8 g', () => {
    for (const [n, s] of [
      [14, AS_FLOWN],
      [13, PLAN],
      [12, PLAN],
      [5, AS_FLOWN],
    ] as Array<[number, Scenario]>) {
      const b = run(n, s).booster;
      let peak = 0;
      for (let i = 1; i < b.n; i++) if (b.phase[i] === Phase.Boostback && b.phase[i - 1] === Phase.Boostback) peak = Math.max(peak, forceG(b, i));
      expect(peak, `F${n}`).toBeGreaterThan(4);
      expect(peak, `F${n}`).toBeLessThan(8.3);
    }
  });

  it('a throttle limit caps the landing engines rather than scaling them up, and the landing is planned within it', () => {
    const nominal = ev(run(5, AS_FLOWN), 'booster-landing-burn')?.t as number;
    const r = run(5, { ...AS_FLOWN, interventions: [{ id: 't', t: nominal - 5, kind: 'throttle', vehicle: 'booster', value: 0.6 }] });
    expect(r.booster.endKind).toBe('catch');
    // Within 60% the burn has to start higher.
    expect(ev(r, 'booster-landing-burn')?.t as number).toBeLessThan(nominal - 1);
  });

  it('an inner-ring engine stands in for a centre engine lost in the final approach', () => {
    for (const engines of [[2], [1, 2]]) {
      const r = run(7, { ...AS_FLOWN, interventions: engines.map((e) => ({ id: `e${e}`, t: 400, kind: 'engine-out' as const, vehicle: 'booster' as const, engine: e })) });
      expect(r.booster.endKind, `centre ${engines} out`).toBe('catch');
      expect(litAt(r.boosterEngines, r.booster.end - 6), `centre ${engines} out`).toBeGreaterThan(0);
    }
  });
});

describe('ship', () => {
  it('flips upright, takes out its drift and splashes down upright', () => {
    for (const n of [4, 6, 11, 12, 14]) {
      const r = run(n, AS_FLOWN);
      const s = r.ship;
      expect(s.endKind, `F${n}`).toBe('splashdown');
      const lb = ev(r, 'ship-landing-burn')?.t as number;
      expect(landingLean(s, lb, 100).max, `F${n} lean over the last 100 m`).toBeLessThan(7);
      expect(landingLean(s, lb, 30).max, `F${n} lean over the last 30 m`).toBeLessThan(4);
      expect(landingLean(s, lb, 30).end, `F${n} lean at splashdown`).toBeLessThan(3);
      // The flip's sideways kick stays small and the burn takes it out.
      let drift = 0, last = 0;
      for (let i = 0; i < s.n; i++) {
        if (s.t[i] < lb || s.phase[i] === Phase.Splashed) continue;
        const h = Math.sqrt(Math.max(0, s.speed[i] ** 2 - s.vspeed[i] ** 2));
        drift = Math.max(drift, h);
        last = h;
      }
      expect(drift, `F${n} drift after the flip`).toBeLessThan(35);
      expect(last, `F${n} drift at splashdown`).toBeLessThan(2);
    }
  });

  it('under a throttle limit a light ship sheds engines rather than climbing back up', () => {
    const r = run(6, { ...PLAN, interventions: [{ id: 's', t: 53, kind: 'throttle', vehicle: 'ship', value: 0.7 }] });
    expect(r.ship.endKind).toBe('splashdown');
    let climb = 0;
    for (let i = 0; i < r.ship.n; i++) if (r.ship.phase[i] === Phase.LandingBurn) climb = Math.max(climb, r.ship.vspeed[i]);
    expect(climb).toBeLessThan(2);
  });

  it('satellites leave the bay only in space, before entry', () => {
    for (const [n, s] of [
      [14, { ...AS_FLOWN, shipMission: 'suborbital' }],
      [10, { ...AS_FLOWN, payloadCount: 40 }],
      [7, { ...PLAN, payloadCount: 30 }],
      [5, { ...AS_FLOWN, payloadCount: 30 }],
    ] as Array<[number, Scenario]>) {
      const r = run(n, s);
      const entry = ev(r, 'entry', 'ship')?.t ?? Infinity;
      for (const p of r.payload) {
        expect(Math.hypot(...p.pos) - 6_371_000, `F${n} release altitude`).toBeGreaterThan(150_000);
        expect(p.t, `F${n} release time`).toBeLessThan(entry);
      }
      const end = ev(r, 'payload-end');
      if (r.payload.length > 0) expect(end?.t ?? Infinity).toBeLessThan(entry);
    }
    const all = run(14, { ...AS_FLOWN, shipMission: 'suborbital' });
    expect(all.payload).toHaveLength(26);
    // Too heavy to climb as high: the deploy starts early and stops when the path drops below 150 km.
    const heavy = run(10, { ...AS_FLOWN, payloadCount: 40 });
    expect(heavy.payload.length).toBeGreaterThan(10);
    expect(ev(heavy, 'payload-end')?.note).toBe(`${heavy.payload.length} of 40 satellites deployed`);
  });

  it('a ship that comes down on land is not a splashdown', () => {
    const r = run(9, { ...PLAN, payloadCount: 40 });
    const p = endLatLon(r.ship);
    if (isLand(p.lat, p.lon)) {
      expect(r.ship.endKind).toBe('impact');
      expect(ev(r, 'ship-end')?.note).toMatch(/land/);
    }
    // Every splashdown in a varied set is at sea.
    for (const [n, s] of [
      [6, { ...PLAN, interventions: [{ id: 's', t: 109.5, kind: 'stage-now' }] }],
      [9, { ...PLAN, interventions: [{ id: 'p', t: 30, kind: 'pitch', vehicle: 'booster', deg: -4 }, { id: 'e', t: 300, kind: 'engine-out', vehicle: 'ship', engine: 5 }] }],
      [10, AS_FLOWN],
      [14, AS_FLOWN],
    ] as Array<[number, Scenario]>) {
      const q = run(n, s);
      for (const tr of [q.booster, q.ship]) {
        if (tr.endKind !== 'splashdown') continue;
        const e = endLatLon(tr);
        expect(isLand(e.lat, e.lon), `F${n} ${tr.vehicle} splashdown at ${e.lat.toFixed(2)}, ${e.lon.toFixed(2)}`).toBe(false);
      }
    }
  });

  it('Flights 1 and 2 flown to plan splash down off Kauai about 90 minutes after launch', () => {
    for (const n of [1, 2]) {
      const r = run(n, PLAN);
      expect(r.separationT as number, `F${n} staging`).toBeLessThan(170);
      expect(r.ship.endKind, `F${n}`).toBe('splashdown');
      const zone = getFlight(n).plan.ship.landing;
      const i = r.ship.n - 1;
      const d = surfaceDistance(Float64Array.from([r.ship.pos[3 * i], r.ship.pos[3 * i + 1], r.ship.pos[3 * i + 2]]), Float64Array.from(latLonAltToEcef(zone.lat, zone.lon, 0)));
      expect(d, `F${n} miss`).toBeLessThan(150_000);
      expect(Math.abs((ev(r, 'ship-end')?.t as number) - 5400), `F${n} landing time`).toBeLessThan(600);
    }
  });

  it('a flight sent to orbit deorbits on the pass that brings it down at its zone, through an ordinary entry', () => {
    for (const [n, s] of [
      [5, AS_FLOWN],
      [6, AS_FLOWN],
      [8, PLAN],
      [10, AS_FLOWN],
      [11, AS_FLOWN],
    ] as Array<[number, Scenario]>) {
      const r = run(n, { ...s, shipMission: 'orbital' });
      expect(r.ship.endKind, `F${n}`).toBe('splashdown');
      expect(entryLoads(r), `F${n} entry q`).toBeLessThan(20_000);
      const i = r.ship.n - 1;
      const d = surfaceDistance(Float64Array.from([r.ship.pos[3 * i], r.ship.pos[3 * i + 1], r.ship.pos[3 * i + 2]]), Float64Array.from(latLonAltToEcef(24.5, -157.5, 0)));
      expect(d, `F${n} miss`).toBeLessThan(300_000);
    }
  });

  it('a ship that cannot reach its zone flies its entry for range instead of diving', () => {
    // Forty satellites leave Flight 1's ship far short of Kauai, which lies most of the way round the globe.
    const r = run(1, { ...PLAN, payloadCount: 40 });
    expect(entryLoads(r)).toBeLessThan(20_000);
    expect(r.ship.endKind).toBe('splashdown');
  });

  it('a ship already falling at cut-off goes on to entry, and never pumps its orbit up to thousands of km', () => {
    // Steered 16° nose down the whole climb: the path tops out before cut-off and the ship cannot make orbit.
    const r = run(9, { ...PLAN, shipMission: 'orbital', interventions: [{ id: 'p', t: 5, kind: 'pitch', vehicle: 'ship', deg: -16 }] });
    expect(ev(r, 'entry', 'ship')).toBeDefined();
    expect(r.records.shipApogee).toBeLessThan(400_000);
    expect(r.ship.endKind).toBe('splashdown');
  });

  it('the deploy starts only when a satellite can still leave the bay', () => {
    // Four of six engines out on the climb: the ship never reaches orbit and falls below the deploy altitude early.
    const out = [0, 1, 3, 4].map((e) => ({ id: `e${e}`, t: 220, kind: 'engine-out' as const, vehicle: 'ship' as const, engine: e }));
    for (const n of [14, 12]) {
      const r = run(n, { ...PLAN, interventions: out });
      if (ev(r, 'payload-start')) expect(r.payload.length, `F${n}`).toBeGreaterThan(0);
    }
  });

  it('an engine that does not relight for landing fails before the landing-burn callout', () => {
    // Flight 12's last sea-level Raptor does not relight; with the other two shut down there is no landing burn.
    const out = [0, 1].map((e) => ({ id: `e${e}`, t: 1000, kind: 'engine-out' as const, vehicle: 'ship' as const, engine: e }));
    const r = run(12, { ...AS_FLOWN, interventions: out });
    expect(ev(r, 'ship-landing-burn')).toBeUndefined();
    expect(r.events.some((e) => e.key === 'anomaly' && /relight for landing/.test(e.note ?? ''))).toBe(true);
    expect(r.ship.endKind).toBe('impact');
  });

  it('a ship left in orbit is still in orbit, not lost', () => {
    const r = run(14, { ...AS_FLOWN, interventions: [{ id: 'k', t: 3500, kind: 'skip-burn', vehicle: 'ship' }] });
    expect(r.ship.endKind).toBe('orbit');
    expect(ev(r, 'ship-end')?.label).toBe('Still in orbit');
  });

  it('a reentry anomaly waits for the reentry: a ship kept in orbit does not break up', () => {
    const r = run(9, { ...AS_FLOWN, shipMission: 'orbital' });
    expect(r.events.some((e) => e.note === 'Lost during reentry over the Indian Ocean.')).toBe(false);
    expect(r.ship.endKind).toBe('orbit');
    // As flown, the anomaly keeps its timing.
    const flown = run(9, AS_FLOWN);
    expect(ev(flown, 'ship-end')?.t as number).toBeCloseTo(2802, -1);
  });

  it('burn callouts only with engines lit, and in-space burns keep the landing reserve', () => {
    const scenarios: Array<[number, Scenario]> = [
      [1, { ...PLAN, shipMission: 'orbital', payloadCount: 7, interventions: [{ id: 'k', t: 315, kind: 'skip-burn', vehicle: 'booster' }] }],
      [5, { ...PLAN, shipMission: 'orbital', payloadCount: 37, wind: 85 }],
      [12, AS_FLOWN],
      [14, AS_FLOWN],
    ];
    for (const [n, s] of scenarios) {
      const r = run(n, s);
      for (const e of r.events) {
        if (!['relight', 'orbit-insertion', 'deorbit', 'ship-landing-burn'].includes(e.key)) continue;
        expect(litAt(r.shipEngines, e.t + 1e-6), `F${n} ${e.key} at ${e.t}`).toBeGreaterThan(0);
      }
    }
  });

  it('peak heating is called out only once heating has passed its peak', () => {
    const r = run(3, AS_FLOWN);
    const peak = ev(r, 'peak-heating');
    if (peak) expect(peak.t).toBeLessThan(r.ship.end - 5);
    expect(run(10, AS_FLOWN).events.some((e) => e.key === 'peak-heating')).toBe(true);
  });
});

describe('structural limits', () => {
  const aeroLoss = (r: FlightResult, vehicle: string) => r.events.some((e) => e.key === 'anomaly' && e.vehicle === vehicle && /Aerodynamic loads/.test(e.note ?? ''));
  const maxQ = (tr: Track) => {
    let q = 0;
    for (let i = 0; i < tr.n; i++) if (tr.phase[i] !== Phase.Destroyed) q = Math.max(q, tr.q[i]);
    return q;
  };

  it('a ship steered down into thick air breaks up instead of flying on at hypersonic speed', () => {
    const r = run(14, { ...AS_FLOWN, interventions: [{ id: 'p', t: 250, kind: 'pitch', vehicle: 'ship', deg: -40 }] });
    expect(r.ship.endKind).toBe('lost');
    expect(aeroLoss(r, 'ship')).toBe(true);
    expect(maxQ(r.ship)).toBeLessThan(85_000);
  });

  it('a booster driven down by its boostback breaks up', () => {
    const r = run(5, { ...AS_FLOWN, interventions: [{ id: 'p', t: 170, kind: 'pitch', vehicle: 'booster', deg: -60 }] });
    expect(r.booster.endKind).toBe('lost');
    expect(aeroLoss(r, 'booster')).toBe(true);
  });

  it('a vehicle whose flight is over takes no more commands', () => {
    const ship = run(10, AS_FLOWN).ship;
    const booster = run(5, AS_FLOWN).booster;
    // During the ship's tip-over and while the booster hangs in the arms.
    const r1 = run(10, { ...AS_FLOWN, interventions: [{ id: 'x', t: ship.end - 3, kind: 'terminate', vehicle: 'ship' }, { id: 'e', t: ship.end - 3, kind: 'engine-out', vehicle: 'ship', engine: 0 }] });
    expect(r1.ship.endKind).toBe('splashdown');
    expect(r1.events.filter((e) => e.key === 'ship-end')).toHaveLength(1);
    expect(r1.events.filter((e) => e.key === 'intervention')).toHaveLength(0);
    const r2 = run(5, { ...AS_FLOWN, interventions: [{ id: 'x', t: booster.end - 2, kind: 'terminate', vehicle: 'booster' }] });
    expect(r2.booster.endKind).toBe('catch');
    expect(r2.events.filter((e) => e.key === 'booster-end')).toHaveLength(1);
  });
});

describe('engines and samples', () => {
  it('the engine count only steps down in the final seconds of a landing', () => {
    for (const n of [4, 7, 10, 14]) {
      const r = run(n, AS_FLOWN);
      for (const [tl, key, end] of [
        [r.shipEngines, 'ship-landing-burn', r.ship.end],
        [r.boosterEngines, 'booster-landing-burn', r.booster.end],
      ] as Array<[EngineTimeline, string, number]>) {
        const lb = ev(r, key)?.t;
        if (lb === undefined) continue;
        let prev = Infinity;
        for (let t = lb + 1; t <= end; t += 0.05) {
          const lit = litAt(tl, t);
          expect(lit, `F${n} ${key} at ${t.toFixed(2)}`).toBeLessThanOrEqual(prev);
          prev = lit;
        }
      }
    }
  });

  it('samples stay dense while the engines tail off after cut-off', () => {
    const r = run(3, AS_FLOWN);
    const seco = ev(r, 'seco')?.t as number;
    const s = r.ship;
    // Through the 0.6 s tail-off: at most 0.1 s apart.
    for (let i = indexAt(s, seco); s.t[i + 1] < seco + 0.55; i++) expect(s.t[i + 1] - s.t[i]).toBeLessThan(0.11);
  });

  it('propellant gauges start full', () => {
    for (const n of [1, 5, 14]) {
      const r = run(n, AS_FLOWN);
      expect(r.ship.lox[0]).toBeCloseTo(1, 5);
      expect(r.booster.ch4[0]).toBeCloseTo(1, 5);
    }
    expect(run(5, { ...AS_FLOWN, boosterLoad: 0.9 }).booster.lox[0]).toBeCloseTo(0.9, 5);
  });
});

describe('catalog consistency', () => {
  it('Flight 12 loses its sea-level Raptor as the landing burn lights', () => {
    const r = run(12, AS_FLOWN);
    const lb = ev(r, 'ship-landing-burn')?.t as number;
    const out = r.events.find((e) => e.key === 'anomaly' && /relight for landing/.test(e.note ?? ''));
    expect(out?.t).toBeCloseTo(lb, 6);
    expect(litAt(r.shipEngines, lb + 1)).toBe(2);
  });

  it('Flight 3 loses its booster about 460 m above the water', () => {
    const r = run(3, AS_FLOWN);
    const end = ev(r, 'booster-end');
    expect(end?.alt).toBeGreaterThan(380);
    expect(end?.alt).toBeLessThan(540);
  });
});
