import { describe, expect, it } from 'vitest';
import { getFlight } from '../../flights/catalog';
import { spin } from '../attitude';
import { SimContext, recordSample } from '../context';
import { mountedShipAttitude } from '../guidance/roll';
import { flightParams } from '../params';
import { emptySample, TrackBuilder } from '../recorder';
import { Body, VehicleRt } from '../runtime';
import { runShip } from '../ship';
import { runStack } from '../stack';
import { EARTH_OMEGA, EARTH_RADIUS, Phase } from '../types';
import { q4, qAxis, qLook, qMul, qRotZ, v3 } from '../vec';
import { vehicleSpec } from '../vehicles';

function context(flight = 5) {
  const f = getFlight(flight), scenario = { asFlown: true, interventions: [] };
  return new SimContext(f, scenario, flightParams(f, undefined, scenario));
}

function body() {
  const spec = vehicleSpec('ship', 'b1');
  const part = new VehicleRt(spec, 110_000, 500_000, 0);
  const b = new Body([part], spec.aero, spec.length);
  b.r.set([EARTH_RADIUS + 20_000, 10_000, 100_000]);
  b.v.set([100, 400, -30]);
  b.w.set([0.01, -0.02, 0.03]);
  b.acc.set([-9, 0.5, 0.1]);
  qLook(b.q, [1, 2, 3], [-2, 1, 0]);
  return b;
}

function absDot(a: ArrayLike<number>, b: ArrayLike<number>) {
  return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
}

describe('rigid ship mounting', () => {
  it('right-multiplies by Ry(pi), preserving +Y and reversing +X/+Z without changing the input', () => {
    const stack = body().q, before = stack.slice(), ship = q4();
    expect(mountedShipAttitude(ship, stack)).toBe(ship);
    expect(stack).toEqual(before);
    expect(ship).toEqual(qMul(q4(), stack, [0, 1, 0, 0]));
    expect(Math.hypot(...ship)).toBeCloseTo(1, 14);
    for (const axis of [0, 1, 2] as const) {
      const a = qAxis(v3(), stack, axis), b = qAxis(v3(), ship, axis);
      for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i] * (axis === 1 ? 1 : -1), 14);
    }
    mountedShipAttitude(ship, ship);
    expect(absDot(stack, ship)).toBeCloseTo(1, 14);
  });

  it('keeps inertial angular velocity and common motion compatible with the fixed mount', () => {
    const stack = body(), ship = body();
    mountedShipAttitude(ship.q, stack.q);
    const w = ship.w.slice();
    spin(stack, 0.1);
    spin(ship, 0.1);
    expect(ship.w).toEqual(w);
    expect(stack.w).toEqual(ship.w);
    expect(absDot(mountedShipAttitude(q4(), stack.q), ship.q)).toBeCloseTo(1, 14);
  });

  it('records an axial mount override without modifying the body or any translation/telemetry field', () => {
    const ctx = context(), b = body(), part = b.parts[0];
    const saved = { r: b.r.slice(), v: b.v.slice(), q: b.q.slice(), w: b.w.slice(), acc: b.acc.slice() };
    const normal = emptySample(), mounted = emptySample();
    const extra = { phase: Phase.Ascent, heating: 0.1, aero: [0, 0, 0, 0], still: false };
    const normalTrack = new TrackBuilder(), shipTrack = new TrackBuilder();
    const qShip = mountedShipAttitude(q4(), b.q);
    recordSample(ctx, normalTrack, normal, 123, b, part, 17, extra);
    recordSample(ctx, shipTrack, mounted, 123, b, part, 17, extra, qShip);
    const attitudeFields = new Set(['qx', 'qy', 'qz', 'qw']);
    for (const key of Object.keys(normal) as Array<keyof typeof normal>) {
      if (!attitudeFields.has(key)) expect(mounted[key], key).toBe(normal[key]);
    }
    for (const key of ['r', 'v', 'q', 'w', 'acc'] as const) expect(b[key]).toEqual(saved[key]);
    const expected = qMul(q4(), qRotZ(q4(), -EARTH_OMEGA * 123), qShip);
    expect([mounted.qx, mounted.qy, mounted.qz, mounted.qw]).toEqual(Array.from(expected));
    const recorded = shipTrack.finish('ship', 'lost');
    expect(Array.from(recorded.quat)).toEqual(Array.from(Float32Array.from(expected)));
  });

  it.each([1, 5, 14])('records opposite bellies throughout attached Flight %s, including the pad', (flight) => {
    const ctx = context(flight);
    const stack = runStack(ctx);
    const booster = ctx.boosterTrack.finish('booster', stack.end?.kind ?? 'lost');
    const ship = ctx.shipTrack.finish('ship', stack.end?.kind ?? 'lost');
    expect(booster.t).toEqual(ship.t);
    let largestMountError = 0, largestNormError = 0;
    const a = q4(), expected = q4(), actual = q4();
    for (let i = 0; i < booster.n; i++) {
      for (let k = 0; k < 4; k++) { a[k] = booster.quat[4 * i + k]; actual[k] = ship.quat[4 * i + k]; }
      mountedShipAttitude(expected, a);
      largestMountError = Math.max(largestMountError, Math.abs(1 - absDot(actual, expected)));
      largestNormError = Math.max(largestNormError, Math.abs(Math.hypot(...actual) - 1));
    }
    expect(largestMountError).toBeLessThan(2e-7);
    expect(largestNormError).toBeLessThan(1e-7);
    const shipZ = v3();
    qAxis(shipZ, Float64Array.from(ship.quat.subarray(0, 4)), 2);
    const tower = ctx.padEast.map((x, i) => x * ctx.pad.tower.east + ctx.padNorth[i] * ctx.pad.tower.north);
    expect(shipZ.reduce((sum, x, i) => sum + x * tower[i], 0)).toBeLessThan(0);
  });

  it.each([5, 14])('keeps Flight %s attitude and axial position/velocity continuous at separation', (flight) => {
    const ctx = context(flight), stack = runStack(ctx);
    const b = stack.boosterBody!, s = stack.shipBody!;
    expect(b).not.toBeNull();
    expect(s).not.toBeNull();
    expect(s.q).toEqual(mountedShipAttitude(q4(), b.q));
    expect(s.w).toEqual(b.w);
    const dr = s.r.map((x, i) => x - b.r[i]);
    const expectedDv = [b.w[1] * dr[2] - b.w[2] * dr[1], b.w[2] * dr[0] - b.w[0] * dr[2], b.w[0] * dr[1] - b.w[1] * dr[0]];
    for (let i = 0; i < 3; i++) expect(s.v[i] - b.v[i]).toBeCloseTo(expectedDv[i], 9);
    const before = ctx.shipTrack.finish('ship', 'lost');
    const index = before.n - 1;
    expect(before.t[index]).toBe(stack.t);
    const qEcef = qMul(q4(), qRotZ(q4(), -EARTH_OMEGA * stack.t), s.q);
    expect(absDot(before.quat.subarray(4 * index, 4 * index + 4), qEcef)).toBeCloseTo(1, 6);
    runShip(ctx, s, stack.ship, stack.t);
    const after = ctx.shipTrack.finish('ship', ctx.shipEnd?.kind ?? 'lost');
    expect(after.t[index]).toBe(stack.t);
    expect(after.quat.slice(4 * index, 4 * index + 4)).toEqual(before.quat.slice(4 * index, 4 * index + 4));
    expect(after.pos.slice(3 * index, 3 * index + 3)).toEqual(before.pos.slice(3 * index, 3 * index + 3));
    expect(after.vel.slice(3 * index, 3 * index + 3)).toEqual(before.vel.slice(3 * index, 3 * index + 3));
  });
});
