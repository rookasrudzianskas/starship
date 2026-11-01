import { describe, expect, it, vi } from 'vitest';
import { atmosphere } from '../atmosphere';
import { advanceFlaps, newFlaps } from '../guidance/flaps';
import { Body, VehicleRt } from '../runtime';
import { createTrackSample, sampleTrack } from '../sample';
import { simulateFlight } from '../simulate';
import { newAirData, stepBody, type AirData, type StepOptions } from '../step';
import { EARTH_OMEGA, EARTH_RADIUS, type Generation, type Intervention, type Track } from '../types';
import { vehicleSpec } from '../vehicles';

// Observe the real ship -> stepBody boundary while retaining the complete real integration.
const rateProbe = vi.hoisted(() => ({ enabled: false, missing: false, changedReference: false, aliasedAngles: false, sawDeployment: false, reference: null as ArrayLike<number> | null }));
const pressureProbe = vi.hoisted(() => ({
  body: null as Body | null, air: null as AirData | null, reference: null as ArrayLike<number> | null,
  omegaReference: null as ArrayLike<number> | null, invalid: false, sawLocal: false, sawVacuum: false, sawFreshCoast: false,
}));
vi.mock('../flap-aero', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flap-aero')>();
  return { ...actual, flapNormalPressures(...args: Parameters<typeof actual.flapNormalPressures>) {
    if (rateProbe.enabled) {
      const [out, , angles, q, flow, density, com, omega, rates] = args;
      const { body, air } = pressureProbe;
      const refreshed = air !== null && air.alt > 140_000 && density === atmosphere(air.alt).density;
      pressureProbe.sawFreshCoast ||= refreshed && density !== air?.density;
      pressureProbe.invalid ||= !body || !air || q !== body.q || flow !== air.vAir || (density !== air.density && !refreshed)
        || com !== body.parts[0].com() || air.alt >= 180_000 || !(density > 0)
        || !omega || omega[0] !== body.w[0] || omega[1] !== body.w[1] || omega[2] !== body.w[2] - EARTH_OMEGA
        || rates !== rateProbe.reference || out === angles || out === rates;
      if (pressureProbe.omegaReference && pressureProbe.omegaReference !== omega) pressureProbe.invalid = true;
      pressureProbe.omegaReference = omega ?? null;
      pressureProbe.sawLocal = true;
    }
    actual.flapNormalPressures(...args);
  } };
});
vi.mock('../guidance/flaps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../guidance/flaps')>();
  return { ...actual, advanceFlaps(...args: Parameters<typeof actual.advanceFlaps>) {
    if (rateProbe.enabled) {
      const [state, , pressure] = args;
      pressureProbe.invalid ||= !(pressure instanceof Float64Array) || pressure.length !== 4
        || pressure === state.angles || pressure === state.rates || pressure === state.targets;
      if (typeof pressure !== 'number' && pressure) {
        if (pressureProbe.reference && pressureProbe.reference !== pressure) pressureProbe.invalid = true;
        pressureProbe.reference = pressure;
        if (pressureProbe.air && pressureProbe.air.alt >= 180_000) {
          pressureProbe.sawVacuum = true;
          for (let i = 0; i < 4; i++) pressureProbe.invalid ||= pressure[i] !== 0;
        }
      }
    }
    actual.advanceFlaps(...args);
  } };
});
vi.mock('../step', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../step')>();
  return { ...actual, stepBody(body: Body, dt: number, wind: number, air: AirData, opts?: StepOptions) {
    if (rateProbe.enabled && opts?.flaps) {
      pressureProbe.body = body; pressureProbe.air = air;
      const f = opts.flaps;
      if (!f.rates) rateProbe.missing = true;
      else {
        if (rateProbe.reference && rateProbe.reference !== f.rates) rateProbe.changedReference = true;
        rateProbe.reference = f.rates;
        rateProbe.aliasedAngles ||= f.rates === f.angles;
        for (let i = 0; i < 4; i++) rateProbe.sawDeployment ||= f.rates[i] < 0;
      }
    }
    actual.stepBody(body, dt, wind, air, opts);
  } };
});

const nominal = { asFlown: true, interventions: [] };
const flap = (t: number, index: 0 | 1 | 2 | 3, deg: number | null): Intervention => ({ id: `${t}-${index}`, kind: 'flap', vehicle: 'ship', flap: index, deg, t });
function at(track: Track, t: number) { return sampleTrack(track, t, createTrackSample()); }

describe('flap commands through the flight integrator', () => {
  it('moves one surface in vacuum, holds its command, then returns smoothly to automatic without changing the coast', () => {
    const baseline = simulateFlight(5, nominal);
    Object.assign(rateProbe, { enabled: true, missing: false, changedReference: false, aliasedAngles: false, sawDeployment: false, reference: null });
    let changed: ReturnType<typeof simulateFlight>;
    // First exercise the 140–180 km coast's fresh density, then the >=180 km cutoff.
    try { changed = simulateFlight(5, { ...nominal, interventions: [flap(600, 2, 0), flap(620, 2, null), flap(800, 2, 0), flap(820, 2, null)] }); }
    finally { rateProbe.enabled = false; }
    expect(rateProbe.missing).toBe(false);
    expect(rateProbe.reference).toBeInstanceOf(Float64Array);
    expect(rateProbe.changedReference).toBe(false);
    expect(rateProbe.aliasedAngles).toBe(false);
    expect(rateProbe.sawDeployment).toBe(true);
    expect(pressureProbe.invalid).toBe(false);
    expect(pressureProbe.reference).toBeInstanceOf(Float64Array);
    expect(pressureProbe.sawLocal).toBe(true);
    expect(pressureProbe.sawVacuum).toBe(true);
    expect(pressureProbe.sawFreshCoast).toBe(true);
    const before = at(changed.ship, 800), halfway = at(changed.ship, 801), held = at(changed.ship, 815), released = at(changed.ship, 820), restored = at(changed.ship, 830);
    expect(before.aero).toEqual([75, 75, 75, 75]);
    expect(halfway.aero[2]).toBeGreaterThan(0);
    expect(halfway.aero[2]).toBeLessThan(75);
    expect(held.aero).toEqual([75, 75, 0, 75]);
    expect(released.aero[2]).toBe(0);
    expect(restored.aero).toEqual([75, 75, 75, 75]);
    const sameTime = at(baseline.ship, 830);
    expect(restored.alt).toBeGreaterThan(180_000);
    expect(restored.q).toBeLessThan(0.05);
    // Actuator movement refines coast timesteps; gravity integration remains equivalent to sub-mm precision.
    for (const key of ['x', 'y', 'z'] as const) {
      expect(restored.pos[key]).toBeCloseTo(sameTime.pos[key], 3);
      expect(restored.vel[key]).toBeCloseTo(sameTime.vel[key], 5);
    }
    expect(changed.events.filter(e => e.short === 'FLAP').map(e => e.t)).toEqual([600, 620, 800, 820]);
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

function stationaryBody(gen: Generation, altitude: number) {
  const spec = vehicleSpec('ship', gen), part = new VehicleRt(spec, spec.dryMass, 30_000, 0);
  const body = new Body([part], spec.aero, spec.length);
  body.r.set([EARTH_RADIUS + altitude, 0, 0]);
  body.v.set([0, EARTH_OMEGA * body.r[0], 0]);
  body.w.set([0, 0, EARTH_OMEGA]);
  return body;
}

describe('persistent actuators through the force integrator', () => {
  it.each(['b1', 'b2', 'v3'] as const)('%s uses actual hinge motion at zero CM airspeed and becomes exactly trim-neutral when settled', (gen) => {
    const flaps = newFlaps(), automatic = flaps.angles.slice(), rates = flaps.rates;
    const opts: StepOptions = { flaps: { gen, angles: flaps.angles, automatic, rates } };
    flaps.targets[2] = 15;
    // Issuing a new target has no aerodynamic hinge-velocity effect before the actuator moves.
    const waiting = stationaryBody(gen, 11_500), waitingAir = newAirData();
    stepBody(waiting, 0.02, 0, waitingAir, opts);
    expect(Array.from(waitingAir.aero)).toEqual([0, 0, 0]);
    advanceFlaps(flaps, 0.1, 0);
    expect(flaps.rates).toBe(rates);
    expect(flaps.rates[2]).toBeLessThan(0);
    // Equal instantaneous angles isolate the rate term during a moving hinge's crossing of trim.
    automatic.set(flaps.angles);
    const moving = stationaryBody(gen, 11_500), air = newAirData(), originalW = moving.w.slice();
    stepBody(moving, 0.02, 0, air, opts);
    expect(air.q).toBe(0);
    expect(Math.hypot(...air.aero)).toBeGreaterThan(0);
    expect(moving.w).not.toEqual(originalW);
    advanceFlaps(flaps, 10, air.q);
    expect(flaps.rates).toBe(rates);
    expect(Array.from(flaps.rates)).toEqual([0, 0, 0, 0]);
    automatic.set(flaps.angles);
    const noFlaps = stationaryBody(gen, 11_500), baselineAir = newAirData();
    for (const key of ['r', 'v', 'q', 'w', 'acc'] as const) noFlaps[key].set(moving[key]);
    stepBody(noFlaps, 0.02, 0, baselineAir);
    stepBody(moving, 0.02, 0, air, opts);
    for (const key of ['r', 'v', 'q', 'w', 'acc'] as const) expect(moving[key]).toEqual(noFlaps[key]);
    expect(air).toEqual(baselineAir);
  });

  it.each(['b1', 'b2', 'v3'] as const)('%s preserves the atmospheric cutoff for moving hinges at equal trim angles', (gen) => {
    const flaps = newFlaps(); flaps.targets[0] = 15;
    advanceFlaps(flaps, 0.1, 0);
    const opts: StepOptions = { flaps: { gen, angles: flaps.angles, automatic: flaps.angles.slice(), rates: flaps.rates } };
    for (const altitude of [179_999, 180_000, 200_000]) {
      const body = stationaryBody(gen, altitude), air = newAirData(), initialW = body.w.slice();
      stepBody(body, 0.02, 0, air, opts);
      expect(air.q).toBe(0);
      if (altitude < 180_000) expect(Math.hypot(...air.aero)).toBeGreaterThan(0);
      else { expect(Array.from(air.aero)).toEqual([0, 0, 0]); expect(body.w).toEqual(initialW); }
    }
  });
});
