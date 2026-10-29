import { describe, expect, it } from 'vitest';
import { createRng } from '../scenario';
import { simulateFlight } from '../simulate';
import type { FlightResult, Intervention, Scenario, Track, VehicleId } from '../types';

function randomScenario(rnd: () => number, k: number): { flight: number; scenario: Scenario } {
  const flight = 1 + Math.floor(rnd() * 14);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const vehicle = (): VehicleId => (rnd() < 0.5 ? 'booster' : 'ship');
  const interventions: Intervention[] = [];
  const count = Math.floor(rnd() * 5);
  for (let i = 0; i < count; i++) {
    const t = rnd() < 0.15 ? -5 + rnd() * 10 : rnd() * (rnd() < 0.7 ? 600 : 6000);
    const id = `${k}-${i}`;
    switch (pick(['engine-out', 'throttle', 'terminate', 'stage-now', 'pitch', 'skip-burn'] as const)) {
      case 'engine-out': {
        const v = vehicle();
        interventions.push({ id, t, kind: 'engine-out', vehicle: v, engine: Math.floor(rnd() * (v === 'booster' ? 33 : 6)) });
        break;
      }
      case 'throttle':
        interventions.push({ id, t, kind: 'throttle', vehicle: vehicle(), value: 0.4 + rnd() * 0.6 });
        break;
      case 'terminate':
        if (rnd() < 0.3) interventions.push({ id, t, kind: 'terminate', vehicle: vehicle() });
        break;
      case 'stage-now':
        interventions.push({ id, t, kind: 'stage-now' });
        break;
      case 'pitch':
        interventions.push({ id, t, kind: 'pitch', vehicle: vehicle(), deg: -15 + rnd() * 30 });
        break;
      case 'skip-burn':
        interventions.push({ id, t, kind: 'skip-burn', vehicle: vehicle() });
        break;
    }
  }
  const scenario: Scenario = {
    asFlown: rnd() < 0.6,
    interventions,
    ...(rnd() < 0.25 ? { boosterRecovery: pick(['catch', 'splashdown', 'expend'] as const) } : {}),
    ...(rnd() < 0.2 ? { shipMission: pick(['suborbital', 'orbital'] as const) } : {}),
    ...(rnd() < 0.2 ? { payloadCount: Math.floor(rnd() * 40) } : {}),
    ...(rnd() < 0.3 ? { wind: rnd() * 80 } : {}),
    ...(rnd() < 0.2 ? { boosterLoad: 0.85 + rnd() * 0.15 } : {}),
  };
  return { flight, scenario };
}

function checkTrack(tr: Track, where: string): void {
  expect(tr.n, where).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < tr.n; i++) if (!(tr.t[i] > tr.t[i - 1])) throw new Error(`${where}: time not increasing at ${i}`);
  for (const [name, arr] of Object.entries(tr)) {
    if (!ArrayBuffer.isView(arr)) continue;
    const a = arr as unknown as ArrayLike<number>;
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) throw new Error(`${where}: ${name}[${i}] = ${a[i]}`);
  }
}

function check(r: FlightResult, where: string): void {
  checkTrack(r.booster, `${where} booster`);
  checkTrack(r.ship, `${where} ship`);
  for (let i = 1; i < r.events.length; i++) expect(r.events[i].t).toBeGreaterThanOrEqual(r.events[i - 1].t);
  for (const e of r.events) expect(Number.isFinite(e.t) && Number.isFinite(e.speed) && Number.isFinite(e.alt), `${where} ${e.key}`).toBe(true);
  expect(r.tEnd).toBeGreaterThanOrEqual(Math.max(r.booster.end, r.ship.end));
  expect(r.ship.end).toBeLessThanOrEqual(14_400 + 200);
}

describe('fuzz', () => {
  it('finishes every random scenario with finite, monotonic tracks', () => {
    const rnd = createRng(20_261_029);
    for (let k = 0; k < 200; k++) {
      const { flight, scenario } = randomScenario(rnd, k);
      const where = `#${k} flight ${flight} ${JSON.stringify(scenario)}`;
      check(simulateFlight(flight, scenario), where);
    }
  }, 300_000);
});
