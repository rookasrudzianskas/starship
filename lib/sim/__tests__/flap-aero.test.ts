import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { flapGeometry, flapPivot } from '../../three/vehicles/parts';
import { flapLoads, flapResponse } from '../flap-aero';
import { commandFlaps, newFlaps, type FlapPhase } from '../guidance/flaps';
import { aeroForce, airVelocity } from '../physics';
import { Body, VehicleRt } from '../runtime';
import { SHIP_GEOMETRY, shipNoseRadius } from '../ship-geometry';
import { newAirData, stepBody } from '../step';
import { EARTH_OMEGA, EARTH_RADIUS, type Generation } from '../types';
import { DEG, type V3 } from '../vec';
import { vehicleSpec } from '../vehicles';

// The renderer uses Next's alias; map it to the actual module in this isolated Node test.
vi.mock('@/lib/sim/ship-geometry', () => import('../ship-geometry'));

const v3 = (x = 0, y = 0, z = 0): V3 => Float64Array.of(x, y, z);
const GENERATIONS = ['b1', 'b2', 'v3'] as const;
const TRIM = [18, 18, 22, 22];
const CORNERS: number[][] = Array.from({ length: 16 }, (_, mask) => Array.from({ length: 4 }, (_, i) => (mask & (1 << i)) ? 90 : 0));
const BODY_TO_WORLD = new Quaternion().setFromEuler(new Euler(0.41, -0.83, 1.17));
const vec = (a: ArrayLike<number>) => new Vector3(a[0], a[1], a[2]);

function loads(gen: Generation, angles: number[], automatic = TRIM, flow = v3(0, 0, 200), q = 10_000, com = 25) {
  const force = v3(), moment = v3();
  flapLoads(force, moment, gen, angles, automatic, flow, q, com);
  return { force, moment };
}

function closeVector(actual: ArrayLike<number>, expected: Vector3, tolerance = 1e-11) {
  expect(vec(actual).distanceTo(expected)).toBeLessThanOrEqual(tolerance * Math.max(1, expected.length()));
}

/**
 * Independent area/centroid oracle: integrate triangles from the renderer's real flap mesh,
 * then use Three's pivot/quaternion transforms, rather than the force model's private basis.
 * Project onto the slab's mid-plane: thickness bevels are deliberately not pressure plates.
 */
function renderedPlate(gen: Generation, index: number, segments: number) {
  const ship = SHIP_GEOMETRY[gen], forward = index < 2, right = index % 2 === 1;
  const spec = forward ? ship.fwd : ship.aft, base = forward ? ship.noseBase : 0;
  const az = spec.az * (right ? -1 : 1);
  const point = (offset: number) => {
    const y = base + offset;
    const radius = (y <= ship.noseBase ? 4.5 : shipNoseRadius(y - ship.noseBase, ship.length - ship.noseBase)) + 0.16;
    return new Vector3(Math.sin(az) * radius, y, Math.cos(az) * radius);
  };
  const p0 = point(spec.h0), p1 = point(spec.h1);
  const pivot = flapPivot(p0, p1, right);
  const mesh = flapGeometry({ root: p0.distanceTo(p1), ...spec.plan }, right, segments, 1);
  const position = mesh.getAttribute('position'), normals = mesh.getAttribute('normal'), indices = mesh.getIndex()!;
  let area = 0;
  const centroid = new Vector3(), a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let i = 0; i < indices.count; i += 3) {
    const ia = indices.getX(i), ib = indices.getX(i + 1), ic = indices.getX(i + 2);
    if (normals.getZ(ia) < 0.99 || normals.getZ(ib) < 0.99 || normals.getZ(ic) < 0.99) continue;
    a.fromBufferAttribute(position, ia); b.fromBufferAttribute(position, ib); c.fromBufferAttribute(position, ic);
    const triangleArea = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    centroid.addScaledVector(a.clone().add(b).add(c), triangleArea / 3);
    area += triangleArea;
  }
  centroid.divideScalar(area); centroid.z = 0;
  mesh.dispose();
  return { area, centroid, pivot, right, p0, p1 };
}

function meshWrench(plates: ReturnType<typeof renderedPlate>[], angles: number[], automatic: number[], flow: V3, pressure: number, com: number) {
  const force = new Vector3(), moment = new Vector3(), unit = vec(flow).normalize();
  for (let i = 0; i < 4; i++) {
    const p = plates[i];
    for (const [angle, sign] of [[angles[i], 1], [automatic[i], -1]]) {
      const rotation = p.pivot.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle * DEG * (p.right ? -1 : 1)));
      const normal = new Vector3(0, 0, 1).applyQuaternion(rotation);
      const incidence = unit.dot(normal);
      const f = normal.multiplyScalar(-2 * pressure * p.area * incidence * Math.abs(incidence) * sign);
      const arm = p.centroid.clone().applyQuaternion(rotation).add(p.pivot.position).sub(new Vector3(0, com, 0));
      force.add(f); moment.add(arm.cross(f));
    }
  }
  return { force, moment };
}

describe('trim-relative flap loads', () => {
  it.each(GENERATIONS)('%s has exact zero vacuum, stopped-flow and matched-trim loads', (gen) => {
    const force = v3(1, 2, 3), moment = v3(4, 5, 6), acceleration = v3(7, 8, 9);
    for (const pressure of [0, -1]) {
      flapLoads(force, moment, gen, [0, 90, 0, 90], TRIM, v3(20, -80, 200), pressure, 25);
      expect(Array.from(force)).toEqual([0, 0, 0]); expect(Array.from(moment)).toEqual([0, 0, 0]);
    }
    flapLoads(force, moment, gen, [0, 90, 0, 90], TRIM, v3(), 10_000, 25);
    expect(Array.from(force)).toEqual([0, 0, 0]); expect(Array.from(moment)).toEqual([0, 0, 0]);
    for (const angles of [...CORNERS, TRIM, [0.123, 19.72, 48.5, 89.999]]) {
      flapResponse(force, acceleration, moment, gen, angles, angles.slice(), Float64Array.from(BODY_TO_WORLD.toArray()), v3(140, -80, 200), 60_000, 150_000, SHIP_GEOMETRY[gen].length, 25);
      expect(Math.hypot(...force)).toBe(0); expect(Math.hypot(...moment)).toBe(0); expect(Math.hypot(...acceleration)).toBe(0);
    }
  });

  it.each(GENERATIONS)('%s mirrors roll/yaw torque while preserving pitch for mirrored left/right commands', (gen) => {
    for (const index of [0, 2]) {
      const left = [45, 45, 45, 45], right = left.slice(); left[index] = 0; right[index + 1] = 0;
      const a = loads(gen, left, [45, 45, 45, 45]), b = loads(gen, right, [45, 45, 45, 45]);
      closeVector(b.force, new Vector3(-a.force[0], a.force[1], a.force[2]));
      closeVector(b.moment, new Vector3(a.moment[0], -a.moment[1], -a.moment[2]));
      expect(a.force[2]).toBeLessThan(0); // opening the left plate adds drag toward -belly
      expect(a.moment[1]).toBeGreaterThan(0); expect(b.moment[1]).toBeLessThan(0);
    }
  });

  it.each(GENERATIONS)('%s gives opposite fore/aft pitch and the commanded mixer signs', (gen) => {
    const baseline = [45, 45, 45, 45];
    const fore = loads(gen, [0, 0, 45, 45], baseline), aft = loads(gen, [45, 45, 0, 0], baseline);
    expect(fore.moment[0]).toBeLessThan(0); expect(aft.moment[0]).toBeGreaterThan(0);
    expect(Math.abs(fore.moment[1])).toBeLessThan(1e-8); expect(Math.abs(aft.moment[1])).toBeLessThan(1e-8);
    const state = newFlaps();
    for (const sign of [-1, 1]) {
      commandFlaps(state, 'entry', sign, 0);
      expect(loads(gen, Array.from(state.targets)).moment[1] * sign).toBeGreaterThan(0);
      commandFlaps(state, 'entry', 0, sign);
      expect(loads(gen, Array.from(state.targets)).moment[0] * sign).toBeGreaterThan(0);
    }
  });

  it.each(GENERATIONS)('%s uses the current longitudinal CoM without changing force or roll torque', (gen) => {
    const angles = [7, 63, 29, 86], flow = v3(30, 110, 200);
    const a = loads(gen, angles, TRIM, flow, 10_000, 20), b = loads(gen, angles, TRIM, flow, 10_000, 30);
    expect(b.force).toEqual(a.force);
    closeVector(b.moment, vec(a.moment).add(new Vector3(-10 * a.force[2], 0, 10 * a.force[0])));
  });
});

describe('flap force frames and rendered geometry', () => {
  it.each(GENERATIONS)('%s agrees with rendered hinge rotations and mesh area/centroids', (gen) => {
    const flow = v3(80, 130, 210), angles = [5, 43, 72, 89];
    const commands = [angles, ...[0, 1, 2, 3].map((index) => TRIM.map((angle, i) => i === index ? angles[i] : angle))];
    // 128 mesh strips independently check the force model's 64-strip area quadrature.
    for (const [segments, tolerance] of [[128, 0.0001], [7, 0.003], [4, 0.01]]) {
      const plates = [0, 1, 2, 3].map((i) => renderedPlate(gen, i, segments));
      for (const p of plates) {
        expect(p.area).toBeGreaterThan(5);
        expect(p.centroid.y).toBeGreaterThan(0);
        expect(p.centroid.y).toBeLessThan(p.p0.distanceTo(p.p1));
        expect(p.centroid.x * (p.right ? -1 : 1)).toBeGreaterThan(0);
        const hingeEnd = new Vector3(0, p.p0.distanceTo(p.p1), 0).applyQuaternion(p.pivot.quaternion).add(p.p0);
        expect(hingeEnd.distanceTo(p.p1)).toBeLessThan(1e-12);
      }
      for (const angles of commands) {
        const actual = loads(gen, angles, TRIM, flow, 10_000, 23);
        const oracle = meshWrench(plates, angles, TRIM, flow, 10_000, 23);
        closeVector(actual.force, oracle.force, tolerance); closeVector(actual.moment, oracle.moment, tolerance);
      }
    }
  });

  it.each(GENERATIONS)('%s transforms force and inertia-scaled acceleration into the inertial frame', (gen) => {
    const angles = [8, 55, 42, 87], flow = v3(70, -40, 180), pressure = 12_000, mass = 180_000, length = SHIP_GEOMETRY[gen].length;
    const body = loads(gen, angles, TRIM, flow, pressure);
    const worldFlow = Float64Array.from(vec(flow).applyQuaternion(BODY_TO_WORLD).toArray());
    const force = v3(), acceleration = v3(), moment = v3();
    flapResponse(force, acceleration, moment, gen, angles, TRIM, Float64Array.from(BODY_TO_WORLD.toArray()), worldFlow, pressure, mass, length, 25);
    const transverse = mass * (length ** 2 / 12 + 4.5 ** 2 / 4), axial = mass * 4.5 ** 2 / 2;
    closeVector(force, vec(body.force).applyQuaternion(BODY_TO_WORLD));
    closeVector(moment, vec(body.moment)); // scratch moment remains in body coordinates
    closeVector(acceleration, new Vector3(body.moment[0] / transverse, body.moment[1] / axial, body.moment[2] / transverse).applyQuaternion(BODY_TO_WORLD));
    const first = acceleration.slice();
    flapResponse(force, acceleration, moment, gen, angles, TRIM, Float64Array.from(BODY_TO_WORLD.toArray()), worldFlow, pressure, mass * 2, length, 25);
    closeVector(acceleration, vec(first).multiplyScalar(0.5));
  });
});

describe('total aerodynamic passivity', () => {
  it.each(GENERATIONS)('%s never accelerates the relative airflow across extreme flap configurations', (gen) => {
    const config = vehicleSpec('ship', gen).aero, automatic = CORNERS.map((angles) => angles.slice());
    const state = newFlaps();
    for (const phase of ['stow', 'entry', 'belly', 'flip'] as FlapPhase[]) {
      commandFlaps(state, phase); automatic.push(Array.from(state.targets));
    }
    const force = v3(), moment = v3(), base = v3(), info = { q: 0, mach: 0, aoa: 0, airspeed: 0 };
    let worstRatio = -Infinity, witness = '';
    // Both windward and leeward flow, nose/tail flight, every azimuth, and both sides of transonic drag rise.
    for (let polar = 0; polar <= 180; polar += 15) for (let az = 0; az < 360; az += 30) {
      const flow = v3(Math.sin(polar * DEG) * Math.cos(az * DEG), Math.cos(polar * DEG), Math.sin(polar * DEG) * Math.sin(az * DEG));
      const baseline = [0.2, 0.8, 1.05, 1.5, 5, 20].map((mach) => {
        const speed = mach * 340, velocity = flow.map((v) => v * speed);
        aeroForce(base, info, v3(0, 1, 0), velocity, 2 / (speed * speed), 340, config);
        return { force: base.slice(), q: info.q, mach };
      });
      for (const actual of CORNERS) for (const trim of automatic) {
        flapLoads(force, moment, gen, actual, trim, flow, 1, 25);
        for (const b of baseline) {
          let power = 0, baselinePower = 0;
          for (let k = 0; k < 3; k++) { power += (b.force[k] + force[k] * b.q) * flow[k]; baselinePower += b.force[k] * flow[k]; }
          const ratio = power / -baselinePower;
          if (!Number.isFinite(ratio)) throw new Error(`Nonfinite aero work: ${JSON.stringify({ gen, polar, az, mach: b.mach, actual, trim })}`);
          if (ratio > worstRatio) { worstRatio = ratio; witness = JSON.stringify({ polar, az, mach: b.mach, actual, trim }); }
        }
      }
    }
    expect(Number.isFinite(worstRatio)).toBe(true);
    expect(worstRatio, `Positive total aero work at ${witness}`).toBeLessThanOrEqual(1e-12);
  });
});

function bodyAt(altitude: number, gen: Generation = 'b2') {
  const spec = vehicleSpec('ship', gen), part = new VehicleRt(spec, spec.dryMass, 30_000, 0);
  const body = new Body([part], spec.aero, spec.length);
  body.r.set([EARTH_RADIUS + altitude, 0, 0]);
  body.q.set(BODY_TO_WORLD.toArray());
  body.v.set(vec(v3(70, -40, 180)).applyQuaternion(BODY_TO_WORLD).toArray());
  body.v[1] += EARTH_OMEGA * body.r[0];
  body.w.set([0.01, -0.02, 0.03]);
  return body;
}

describe('stepBody flap integration', () => {
  it('adds neither force nor angular impulse in vacuum', () => {
    const body = bodyAt(200_000), air = newAirData(), before = body.w.slice();
    stepBody(body, 0.02, 0, air, { flaps: { gen: 'b2', angles: [0, 90, 0, 90], automatic: TRIM } });
    expect(air.q).toBe(0); expect(Array.from(air.aero)).toEqual([0, 0, 0]); expect(body.w).toEqual(before);
  });

  it('preserves the legacy body step bit-for-bit when all actual angles equal automatic trim', () => {
    const old = bodyAt(11_500), modified = bodyAt(11_500), a = newAirData(), b = newAirData();
    stepBody(old, 0.02, 60, a);
    stepBody(modified, 0.02, 60, b, { flaps: { gen: 'b2', angles: TRIM.slice(), automatic: TRIM.slice() } });
    for (const key of ['r', 'v', 'q', 'w', 'acc'] as const) expect(modified[key]).toEqual(old[key]);
    expect(b).toEqual(a);
  });

  it('adds the inertial residual once and integrates its torque about current CoM with the correct sign', () => {
    const body = bodyAt(11_500), baseline = bodyAt(11_500), air = newAirData(), baseAir = newAirData(), dt = 0.02;
    const initialW = body.w.slice(), initialQ = body.q.slice(), angles = [5, 43, 72, 89], com = body.parts[0].com(), mass = body.mass;
    const relative = airVelocity(v3(), body.r, body.v, 11_500, 60);
    const bodyFlow = Float64Array.from(vec(relative).applyQuaternion(BODY_TO_WORLD.clone().invert()).toArray());
    stepBody(baseline, dt, 60, baseAir);
    const plates = [0, 1, 2, 3].map((i) => renderedPlate('b2', i, 128));
    const oracle = meshWrench(plates, angles, TRIM, bodyFlow, baseAir.q, com);
    const transverse = mass * (body.length ** 2 / 12 + 4.5 ** 2 / 4), axial = mass * 4.5 ** 2 / 2;
    const expectedImpulse = new Vector3(oracle.moment.x / transverse, oracle.moment.y / axial, oracle.moment.z / transverse).applyQuaternion(BODY_TO_WORLD).multiplyScalar(dt);
    stepBody(body, dt, 60, air, { flaps: { gen: 'b2', angles, automatic: TRIM } });
    closeVector(air.aero.map((x, i) => x - baseAir.aero[i]), oracle.force.applyQuaternion(BODY_TO_WORLD), 0.0001);
    closeVector(body.w.map((x, i) => x - initialW[i]), expectedImpulse, 0.0001);
    expect(body.q).toEqual(initialQ); // step adds angular velocity; guidance advances attitude separately
    expect(body.v).not.toEqual(baseline.v);
  });
});
