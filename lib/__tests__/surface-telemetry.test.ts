import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { rollFromPose } from '../attitude-reading';
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
      const result = flight(35, antipodal), out = emptyReading(), aero = out.aero;
      expect(readVehicle(result, 'ship', 1, out)).toBe(out);
      expect(out.roll).toBeCloseTo(180, 5);
      expect(out.aero).toBe(aero);
      expect(out.aero).toEqual([45, 22.5, 15, 7.5]);
      readVehicle(result, 'ship', -1, out);
      expect(out.roll).toBeCloseTo(170, 5); expect(out.aero).toEqual([0, 0, 0, 0]);
      readVehicle(result, 'ship', 3, out);
      expect(out.ended).toBe(true); expect(out.roll).toBeCloseTo(-170, 5); expect(out.aero).toEqual([90, 45, 30, 15]);
    }
  });

  it('does not share surface arrays between readings or retain stale data for an empty track', () => {
    const a = emptyReading(), b = emptyReading(), result = flight();
    const aero = a.aero;
    readVehicle(result, 'ship', 1, a);
    expect(b.aero).toEqual([0, 0, 0, 0]);
    const empty = new TrackBuilder().finish('ship', 'lost');
    readVehicle({ ...result, ship: empty }, 'ship', 1, a);
    expect(a.aero).toBe(aero); expect(a.aero).toEqual([0, 0, 0, 0]);
    expect(a.roll).toBeNull(); expect(a.ended).toBe(true); expect(a.speed).toBe(0);
  });

  it('exports actual flap angles and signed roll with blank undefined/ended values', () => {
    const rows = buildCsv(flight()).split('\n').map(row => row.split(','));
    const header = rows[0], at = (t: number, key: string) => rows[t + 1][header.indexOf(key)];
    expect(header).toHaveLength(27);
    expect(rows.every(row => row.length === header.length)).toBe(true);
    expect(at(1, 'ship_roll_from_down_deg')).toBe('180.0');
    expect(at(1, 'ship_forward_left_flap_deg')).toBe('45.00');
    expect(at(1, 'ship_forward_right_flap_deg')).toBe('22.50');
    expect(at(1, 'ship_aft_left_flap_deg')).toBe('15.00');
    expect(at(1, 'ship_aft_right_flap_deg')).toBe('7.50');
    for (const key of header.slice(21)) expect(at(3, key)).toBe('');
    const vertical = buildCsv(flight(90)).split('\n')[1].split(',');
    expect(vertical[header.indexOf('ship_roll_from_down_deg')]).toBe('');
    expect(vertical[header.indexOf('booster_roll_from_down_deg')]).toBe('');
    expect(rows.flat().some(cell => cell === 'NaN' || cell === 'Infinity')).toBe(false);
  });
});
