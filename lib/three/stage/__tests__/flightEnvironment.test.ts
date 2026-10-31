import { describe, expect, it } from 'vitest';
import { atmosphere, type AtmosphereState } from '../../../sim/atmosphere';
import { latLonAltToEcef, localEnuBasis } from '../../../sim/geo';
import { airVelocity } from '../../../sim/physics';
import { scenarioKey } from '../../../sim/scenario';
import { EARTH_OMEGA, EARTH_RADIUS, type Scenario } from '../../../sim/types';
import { flightEnvironmentInto, resultWindPeak } from '../flightEnvironment';

const newAtmosphere = (): AtmosphereState => ({ pressure: 0, density: 0, temperature: 0, speedOfSound: 0 });
const newOutput = () => ({ ambientPressure: 0, airflowBody: { x: 0, y: 0, z: 0 } });
const newSample = (alt = 11_500) => ({
  alt,
  pos: [EARTH_RADIUS + alt, 0, 0],
  vel: [0, 0, 0],
  quat: { x: 0, y: 0, z: 0, w: 1 },
});

function expectFlow(actual: { x: number; y: number; z: number }, expected: number[]) {
  expect(actual.x).toBeCloseTo(expected[0], 12);
  expect(actual.y).toBeCloseTo(expected[1], 12);
  expect(actual.z).toBeCloseTo(expected[2], 12);
  expect(Math.hypot(actual.x, actual.y, actual.z)).toBeCloseTo(1, 12);
}

describe('visual flight environment', () => {
  it.each([
    [0, 101_325],
    [11_000, 22_700],
    [50_000, 79.78],
  ])('uses simulator US76 pressure at geometric altitude %s m', (alt, pressure) => {
    const scratch = newAtmosphere(), out = newOutput();
    flightEnvironmentInto(newSample(alt), 0, scratch, out);
    expect(out.ambientPressure).toBe(atmosphere(alt).pressure);
    expect(Math.abs(out.ambientPressure - pressure) / pressure).toBeLessThan(0.00002);
    expect(scratch.pressure).toBe(out.ambientPressure);
  });

  it('preserves the calm-air direction without subtracting Earth rotation from an ECEF velocity again', () => {
    const sample = newSample();
    sample.vel = [20, 10, 30];
    const out = newOutput();
    flightEnvironmentInto(sample, 0, newAtmosphere(), out);
    const speed = Math.hypot(...sample.vel);
    expectFlow(out.airflowBody, sample.vel.map(v => -v / speed));
  });

  it.each([-150, 90])('moves air eastward for positive wind and westward for negative wind (%s m/s)', (wind) => {
    for (const lon of [-97, 0, 90, 180]) {
      const sample = newSample();
      sample.pos = latLonAltToEcef(26, lon, sample.alt);
      const out = newOutput();
      flightEnvironmentInto(sample, wind, newAtmosphere(), out);
      expectFlow(out.airflowBody, localEnuBasis(26, lon).east.map(x => x * Math.sign(wind)));
    }
  });

  it('reverses the oncoming flow when a tailwind overtakes the vehicle', () => {
    const sample = newSample();
    sample.vel = [0, 100, 0];
    const out = newOutput(), scratch = newAtmosphere();
    for (const wind of [-90, 0, 90]) {
      flightEnvironmentInto(sample, wind, scratch, out);
      expectFlow(out.airflowBody, [0, -1, 0]);
    }
    flightEnvironmentInto(sample, 150, scratch, out);
    expectFlow(out.airflowBody, [0, 1, 0]);
  });

  it('matches the live airVelocity model after converting the track velocity to an inertial state', () => {
    const sample = newSample();
    sample.pos = latLonAltToEcef(-20, 110, sample.alt);
    sample.vel = [350, -200, 100];
    const inertialV = [sample.vel[0] - EARTH_OMEGA * sample.pos[1], sample.vel[1] + EARTH_OMEGA * sample.pos[0], sample.vel[2]];
    const va = new Float64Array(3), out = newOutput(), scratch = newAtmosphere();
    for (const wind of [-150, 0, 150]) {
      airVelocity(va, sample.pos, inertialV, sample.alt, wind);
      flightEnvironmentInto(sample, wind, scratch, out);
      const speed = Math.hypot(...va);
      expectFlow(out.airflowBody, Array.from(va, x => -x / speed));
    }
  });

  it('rotates into the body frame and normalises a non-unit quaternion without modifying it', () => {
    const sample = newSample();
    // +90° body→ECEF about Z: an eastward ECEF flow is +X in the body.
    const q = Math.SQRT1_2 * 3;
    sample.quat = { x: 0, y: 0, z: q, w: q };
    const original = structuredClone(sample);
    const out = newOutput();
    flightEnvironmentInto(sample, 90, newAtmosphere(), out);
    expectFlow(out.airflowBody, [1, 0, 0]);
    expect(sample).toEqual(original);
  });

  it('uses the stable body +Y fallback at zero or near-zero relative speed', () => {
    const sample = newSample(), scratch = newAtmosphere(), out = newOutput();
    sample.quat = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    for (const [wind, eastSpeed] of [[0, 0], [0, 0.5], [90, 90], [90, 90.5]]) {
      sample.vel = [0, eastSpeed, 0];
      flightEnvironmentInto(sample, wind, scratch, out);
      expectFlow(out.airflowBody, [0, 1, 0]);
    }
  });

  it('treats a zero quaternion as identity and stays finite at and near either pole', () => {
    const sample = newSample(), scratch = newAtmosphere(), out = newOutput();
    sample.quat = { x: 0, y: 0, z: 0, w: 0 };
    sample.vel = [100, 0, 0];
    for (const pole of [-1, 1]) for (const h of [0, 0.25, 1, 2]) for (const wind of [-150, 150]) {
      sample.pos = [h, 0, pole * (EARTH_RADIUS + sample.alt)];
      flightEnvironmentInto(sample, wind, scratch, out);
      const eastWind = h > 1 ? wind : 0;
      const speed = Math.hypot(100, eastWind);
      expectFlow(out.airflowBody, [-100 / speed, eastWind / speed, 0]);
      expect(Number.isFinite(out.ambientPressure)).toBe(true);
    }
  });

  it('has no jet stream above the simulator cutoff and reuses caller-owned state independently per vehicle', () => {
    const sample = newSample(50_000);
    sample.vel = [10, 20, 30];
    const scratch = newAtmosphere(), out = newOutput(), flow = out.airflowBody;
    expect(flightEnvironmentInto(sample, 150, scratch, out)).toBe(out);
    expect(out.airflowBody).toBe(flow);
    const expected = structuredClone(out), expectedAtmosphere = { ...scratch };
    flightEnvironmentInto(newSample(0), 90, newAtmosphere(), newOutput());
    expect(out).toEqual(expected);
    expect(scratch).toEqual(expectedAtmosphere);
    flightEnvironmentInto(sample, 0, scratch, out);
    expect(out).toEqual(expected);
  });
});

describe('wind matching the displayed worker result', () => {
  const calm: Scenario = { asFlown: true, interventions: [] };
  const windy: Scenario = { ...calm, wind: 90 };
  const changed: Scenario = { ...calm, wind: 150 };

  it('uses only the current scenario when its key matches and applies the simulator wind clamp', () => {
    expect(resultWindPeak(scenarioKey(windy), windy, [], [])).toBe(90);
    expect(resultWindPeak(scenarioKey(calm), calm, [], [])).toBe(0);
    const negative = { ...calm, wind: -90 };
    expect(resultWindPeak(scenarioKey(negative), negative, [], [])).toBe(0);
  });

  it('keeps the old result wind during a pending edit, including when the stage first attaches mid-load', () => {
    expect(resultWindPeak(scenarioKey(windy), changed, [calm, windy], [])).toBe(90);
    expect(resultWindPeak(scenarioKey(calm), windy, [calm], [])).toBe(0);
    expect(resultWindPeak(scenarioKey(changed), changed, [calm, windy], [])).toBe(150);
  });

  it('recovers the displayed scenario from redo history while undo is waiting for the worker', () => {
    expect(resultWindPeak(scenarioKey(changed), windy, [calm], [changed])).toBe(150);
    expect(resultWindPeak(scenarioKey(windy), calm, [], [changed, windy])).toBe(90);
  });

  it('reports an unknown result instead of applying an unrelated scenario wind', () => {
    expect(resultWindPeak(scenarioKey(windy), changed, [calm], [])).toBeNull();
  });
});
