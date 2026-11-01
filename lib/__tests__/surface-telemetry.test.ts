import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { axialRollRateFromSamples, rollFromPose } from '../attitude-reading';
import { buildCsv } from '../csv';
import { emptySample, TrackBuilder } from '../sim/recorder';
import { EARTH_RADIUS, Phase, type FlightResult } from '../sim/types';
import { emptyReading, readVehicle } from '../telemetry';

const D = Math.PI / 180;
const position = new Vector3(0, 0, -EARTH_RADIUS);
const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0);
function attitude(roll: number, tilt = 0) {
  return new Quaternion().setFromAxisAngle(X, tilt * D).multiply(new Quaternion().setFromAxisAngle(Y, roll * D));
}

function packed(a: Quaternion, b: Quaternion): Float64Array {
  return Float64Array.from([...a.toArray(), ...b.toArray()]);
}

describe('Earth-relative axial roll rate from replay interpolation', () => {
  it.each([-60, 60])('differentiates a %s° axial slew rather than assuming constant-rate slerp', (degrees) => {
    const samples = packed(attitude(0), attitude(degrees));
    const dt = 2;
    const endpointRate = 2 * Math.sin(degrees * D / 2) / dt / D;
    const midpointRate = 4 * Math.tan(degrees * D / 4) / dt / D;
    expect(axialRollRateFromSamples(samples, 0, 0, dt)).toBeCloseTo(endpointRate, 10);
    expect(axialRollRateFromSamples(samples, 0, 1, dt)).toBeCloseTo(endpointRate, 10);
    expect(axialRollRateFromSamples(samples, 0, 0.5, dt)).toBeCloseTo(midpointRate, 10);
    expect(Math.abs(midpointRate - degrees / dt)).toBeGreaterThan(0.5);
  });

  it('is invariant under tilted poses, shared world rotations and quaternion sign/common scale', () => {
    const world = new Quaternion().setFromAxisAngle(new Vector3(0.3, -0.7, 0.4).normalize(), 1.4);
    const base = attitude(37, 68), end = base.clone().multiply(attitude(-60));
    const expected = -4 * Math.tan(15 * D) / 2 / D;
    for (const transform of [new Quaternion(), world]) for (const scale of [0.25, 1, 5]) for (const sign of [-1, 1]) {
      const a = transform.clone().multiply(base), b = transform.clone().multiply(end);
      const samples = packed(a, b);
      for (let k = 0; k < 8; k++) samples[k] *= scale * (k < 4 ? 1 : sign);
      expect(axialRollRateFromSamples(samples, 0, 0.5, 2)).toBeCloseTo(expected, 9);
    }
  });

  it('does not report a nose-only pitch or yaw motion as axial spin', () => {
    const base = attitude(30, 35);
    for (const axis of [X, new Vector3(0, 0, 1)]) {
      const end = base.clone().multiply(new Quaternion().setFromAxisAngle(axis, 40 * D));
      for (const fraction of [0, 0.3, 0.5, 1]) expect(axialRollRateFromSamples(packed(base, end), 0, fraction, 2)).toBe(0);
    }
    const pitchEnd = base.clone().multiply(new Quaternion().setFromAxisAngle(X, 40 * D));
    expect(Math.abs(rollFromPose(position, pitchEnd)! - rollFromPose(position, base)!)).toBeGreaterThan(1);
  });

  it('keeps axial rate valid at a vertical nose where the local-down roll angle is undefined', () => {
    const a = attitude(0, 90), b = attitude(40, 90);
    expect(rollFromPose(position, a)).toBeNull();
    expect(rollFromPose(position, b)).toBeNull();
    expect(axialRollRateFromSamples(packed(a, b), 0, 0.5, 2)).toBeCloseTo(4 * Math.tan(10 * D) / 2 / D, 9);
  });

  it('handles ±180° wrap, antipodal encodings and stationary attitude without spurious spins', () => {
    const a = attitude(170), b = attitude(-170);
    const samples = packed(a, b);
    const expected = 4 * Math.tan(5 * D) / 2 / D;
    expect(axialRollRateFromSamples(samples, 0, 0.5, 2)).toBeCloseTo(expected, 9);
    for (let k = 4; k < 8; k++) samples[k] *= -1;
    expect(axialRollRateFromSamples(samples, 0, 0.5, 2)).toBeCloseTo(expected, 9);
    const still = packed(a, a);
    for (let k = 4; k < 8; k++) still[k] *= -1;
    const rate = axialRollRateFromSamples(still, 0, 0.5, 2);
    expect(rate).toBe(0);
    expect(Object.is(rate, -0)).toBe(false);
  });

  it('matches the numerical derivative of normalized lerp with unequal endpoint norms', () => {
    const a = attitude(22, 35), b = a.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 2, -3).normalize(), 1.1));
    const samples = packed(a, b);
    for (let k = 0; k < 4; k++) samples[k] *= 0.8;
    for (let k = 4; k < 8; k++) samples[k] *= -1.3;
    const at = (f: number) => new Quaternion(
      samples[0] * (1 - f) - samples[4] * f, samples[1] * (1 - f) - samples[5] * f,
      samples[2] * (1 - f) - samples[6] * f, samples[3] * (1 - f) - samples[7] * f,
    ).normalize();
    const epsilon = 1e-6, dt = 0.7;
    for (const fraction of [0.1, 0.5, 0.9]) {
      const before = at(fraction - epsilon), after = at(fraction + epsilon);
      const derivative = new Quaternion((after.x - before.x) / (2 * epsilon * dt), (after.y - before.y) / (2 * epsilon * dt),
        (after.z - before.z) / (2 * epsilon * dt), (after.w - before.w) / (2 * epsilon * dt));
      const bodyRate = at(fraction).conjugate().multiply(derivative).y * 2 / D;
      expect(axialRollRateFromSamples(samples, 0, fraction, dt)).toBeCloseTo(bodyRate, 6);
    }
  });

  it('returns no estimate for missing/degenerate quaternions and invalid interval parameters', () => {
    const valid = packed(attitude(0), attitude(10));
    for (const dt of [0, -1, NaN, Infinity]) expect(axialRollRateFromSamples(valid, 0, 0.5, dt)).toBeNull();
    for (const fraction of [-0.01, 1.01, NaN, Infinity]) expect(axialRollRateFromSamples(valid, 0, fraction, 1)).toBeNull();
    for (const index of [-1, 0.5, 1, NaN]) expect(axialRollRateFromSamples(valid, index, 0.5, 1)).toBeNull();
    for (const values of [new Float64Array(8), valid.subarray(0, 4), new Float64Array(0)]) expect(axialRollRateFromSamples(values, 0, 0.5, 1)).toBeNull();
    for (const invalid of [NaN, Infinity]) {
      const values = valid.slice(); values[5] = invalid;
      expect(axialRollRateFromSamples(values, 0, 0.5, 1)).toBeNull();
    }
    for (const endpoint of [0, 4]) {
      const values = valid.slice(); values.fill(0, endpoint, endpoint + 4);
      expect(axialRollRateFromSamples(values, 0, 0.5, 1)).toBeNull();
    }
  });
});

describe('roll relative to local down', () => {
  it.each([-179, -90, -30, 0, 30, 90, 179, 180])('reports a %s degree axial roll independently of nose tilt', (roll) => {
    for (const tilt of [-80, -40, 0, 35, 80]) expect(rollFromPose(position, attitude(roll, tilt))).toBeCloseTo(roll, 9);
  });

  it('is invariant under a shared world rotation and quaternion sign or scale', () => {
    const world = new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.7, -0.4).normalize(), 1.29);
    const p = position.clone().applyQuaternion(world), q = world.clone().multiply(attitude(-62, 41));
    for (const scale of [1, -1, 0.25, 5]) {
      expect(rollFromPose(p, { x: q.x * scale, y: q.y * scale, z: q.z * scale, w: q.w * scale })).toBeCloseTo(-62, 9);
    }
  });

  it('leaves vertical and degenerate references undefined, without NaN or an arbitrary bank', () => {
    for (const tilt of [-90, -89.99, 89.99, 90]) for (const roll of [-90, 0, 120]) expect(rollFromPose(position, attitude(roll, tilt))).toBeNull();
    expect(rollFromPose(position, attitude(45, 89.9))).toBeCloseTo(45, 8);
    expect(rollFromPose(new Vector3(), attitude(0))).toBeNull();
    expect(rollFromPose(position, { x: 0, y: 0, z: 0, w: 0 })).toBeNull();
    expect(rollFromPose({ x: NaN, y: 0, z: 0 }, attitude(0))).toBeNull();
    expect(rollFromPose(position, { x: 0, y: Infinity, z: 0, w: 1 })).toBeNull();
  });
});

function flight(tilt = 0, antipodal = false): FlightResult {
  const builder = new TrackBuilder(2);
  for (const [i, roll] of [170, -170].entries()) {
    const q = attitude(roll, tilt), sign = antipodal && i === 1 ? -1 : 1;
    builder.push({ ...emptySample(), t: i * 2, pz: -EARTH_RADIUS,
      qx: q.x * sign, qy: q.y * sign, qz: q.z * sign, qw: q.w * sign,
      phase: Phase.Coast, a0: i * 90, a1: i * 45, a2: i * 30, a3: i * 15 });
  }
  const ship = builder.finish('ship', 'orbit');
  return { ship, booster: { ...ship, vehicle: 'booster' }, tStart: 0, tEnd: 4, separationT: 0,
    boosterEngines: { slots: [], changes: [] }, shipEngines: { slots: [], changes: [] } } as unknown as FlightResult;
}

describe('surface telemetry through replay and CSV', () => {
  it('derives wraparound roll from the interpolated quaternion and interpolates actual flap motion', () => {
    for (const antipodal of [false, true]) {
      const result = flight(35, antipodal), out = emptyReading(), aero = out.aero, rates = out.aeroRates;
      expect(readVehicle(result, 'ship', 1, out)).toBe(out);
      expect(out.roll).toBeCloseTo(180, 5);
      expect(out.aero).toBe(aero);
      expect(out.aero).toEqual([45, 22.5, 15, 7.5]);
      expect(out.rollRate).toBeCloseTo(4 * Math.tan(5 * D) / 2 / D, 4);
      expect(out.aeroRates).toBe(rates);
      expect(out.aeroRates).toEqual([45, 22.5, 15, 7.5]);
      readVehicle(result, 'ship', -1, out);
      expect(out.roll).toBeCloseTo(170, 5); expect(out.aero).toEqual([0, 0, 0, 0]);
      expect(out.rollRate).toBeNull(); expect(out.aeroRates).toEqual([null, null, null, null]);
      readVehicle(result, 'ship', 3, out);
      expect(out.ended).toBe(true); expect(out.roll).toBeCloseTo(-170, 5); expect(out.aero).toEqual([90, 45, 30, 15]);
      expect(out.rollRate).toBeNull(); expect(out.aeroRates).toEqual([null, null, null, null]);
    }
  });

  it('does not share surface arrays between readings or retain stale data for an empty track', () => {
    const a = emptyReading(), b = emptyReading(), result = flight();
    const aero = a.aero, rates = a.aeroRates;
    readVehicle(result, 'ship', 1, a);
    expect(b.aero).toEqual([0, 0, 0, 0]);
    expect(b.aeroRates).toEqual([null, null, null, null]);
    const empty = new TrackBuilder().finish('ship', 'lost');
    readVehicle({ ...result, ship: empty }, 'ship', 1, a);
    expect(a.aero).toBe(aero); expect(a.aero).toEqual([0, 0, 0, 0]);
    expect(a.roll).toBeNull(); expect(a.ended).toBe(true); expect(a.speed).toBe(0);
    expect(a.rollRate).toBeNull(); expect(a.aeroRates).toBe(rates); expect(a.aeroRates).toEqual([null, null, null, null]);
  });

  it('uses the following interval at knots, with independent flap signs and no estimate at/after the end', () => {
    const builder = new TrackBuilder(3);
    for (const [t, a0, a1, a2, a3] of [[0, 10, 20, 30, 40], [2, 30, 10, 30, 50], [5, 0, 40, 45, 50]]) {
      builder.push({ ...emptySample(), t, pz: -EARTH_RADIUS, a0, a1, a2, a3 });
    }
    const result = { ...flight(), ship: builder.finish('ship', 'orbit') }, out = emptyReading();
    for (const t of [0, 1, 1.999]) {
      readVehicle(result, 'ship', t, out);
      expect(out.aeroRates).toEqual([10, -5, 0, 5]);
      expect(out.rollRate).toBe(0);
    }
    for (const t of [2, 4.999]) {
      readVehicle(result, 'ship', t, out);
      expect(out.aeroRates).toEqual([-10, 10, 5, 0]);
    }
    for (const t of [-1, 5, 6]) {
      readVehicle(result, 'ship', t, out);
      expect(out.aeroRates).toEqual([null, null, null, null]);
      expect(out.rollRate).toBeNull();
    }
  });

  it('does not infer rates from one sample, zero-duration intervals or missing values', () => {
    const one = new TrackBuilder(1); one.push({ ...emptySample(), pz: -EARTH_RADIUS });
    const result = flight(), out = emptyReading();
    readVehicle({ ...result, ship: one.finish('ship', 'orbit') }, 'ship', 0, out);
    expect(out.rollRate).toBeNull(); expect(out.aeroRates).toEqual([null, null, null, null]);
    const repeated = { ...result.ship, t: new Float64Array([0, 0]) };
    readVehicle({ ...result, ship: repeated }, 'ship', 0, out);
    expect(out.rollRate).toBeNull(); expect(out.aeroRates).toEqual([null, null, null, null]);
    const missing = { ...result.ship, quat: new Float32Array(4), aero: result.ship.aero.slice(0, 7) };
    readVehicle({ ...result, ship: missing }, 'ship', 1, out);
    expect(out.rollRate).toBeNull(); expect(out.aeroRates).toEqual([45, 22.5, 15, null]);
  });

  it('exports actual flap angles and signed roll with blank undefined/ended values', () => {
    const rows = buildCsv(flight()).split('\n').map(row => row.split(','));
    const header = rows[0], at = (t: number, key: string) => rows[t + 1][header.indexOf(key)];
    expect(header).toHaveLength(33);
    expect(rows.every(row => row.length === header.length)).toBe(true);
    expect(at(1, 'ship_roll_from_down_deg')).toBe('180.0');
    expect(at(1, 'ship_forward_left_flap_deg')).toBe('45.00');
    expect(at(1, 'ship_forward_right_flap_deg')).toBe('22.50');
    expect(at(1, 'ship_aft_left_flap_deg')).toBe('15.00');
    expect(at(1, 'ship_aft_right_flap_deg')).toBe('7.50');
    expect(at(1, 'ship_axial_roll_rate_ecef_deg_s')).toBe('10.03');
    expect(at(1, 'booster_axial_roll_rate_ecef_deg_s')).toBe('10.03');
    expect(at(1, 'ship_forward_left_flap_rate_deg_s')).toBe('45.00');
    expect(at(1, 'ship_forward_right_flap_rate_deg_s')).toBe('22.50');
    expect(at(1, 'ship_aft_left_flap_rate_deg_s')).toBe('15.00');
    expect(at(1, 'ship_aft_right_flap_rate_deg_s')).toBe('7.50');
    for (const key of header.slice(27)) expect(at(2, key)).toBe('');
    for (const key of header.slice(21)) expect(at(3, key)).toBe('');
    const vertical = buildCsv(flight(90)).split('\n')[1].split(',');
    expect(vertical[header.indexOf('ship_roll_from_down_deg')]).toBe('');
    expect(vertical[header.indexOf('booster_roll_from_down_deg')]).toBe('');
    expect(Number(vertical[header.indexOf('ship_axial_roll_rate_ecef_deg_s')])).toBeGreaterThan(9);
    expect(rows.flat().some(cell => cell === 'NaN' || cell === 'Infinity')).toBe(false);
  });

  it('exports numeric zero rather than negative zero for very small rates, and blanks before the track', () => {
    const result = flight(), a = result.ship.aero.slice(), q = result.ship.quat.slice();
    a.set([10, 10, 10, 10, 9.99999, 9.99999, 9.99999, 9.99999]);
    q.set([...attitude(0).toArray(), ...attitude(-0.001).toArray()]);
    result.ship = { ...result.ship, aero: a, quat: q };
    result.tStart = -1;
    const rows = buildCsv(result).split('\n').map(row => row.split(',')), header = rows[0];
    for (const key of header.slice(27)) expect(rows[1][header.indexOf(key)]).toBe('');
    for (const key of header.slice(28)) expect(rows[2][header.indexOf(key)]).toBe('0.00');
    expect(rows.flat()).not.toContain('-0.00');
  });
});
