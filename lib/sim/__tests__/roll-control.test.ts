import { beforeAll, describe, expect, it } from 'vitest';
import { getFlight, PADS } from '../../flights/catalog';
import { localEnuBasis } from '../geo';
import { steerFlight, slewFlight, slewNoseAndRoll } from '../guidance/roll';
import { Body } from '../runtime';
import { createTrackSample, sampleTrack } from '../sample';
import { simulateFlight } from '../simulate';
import { Phase, type FlightResult } from '../types';
import { DEG, cross3, dot3, normalize3, q4, qAxis, qLook, qMul, v3, type Q4, type V3 } from '../vec';
import { vehicleSpec } from '../vehicles';

const spec = vehicleSpec('ship', 'b1');
const Y = [0, 1, 0], Z = [0, 0, 1];

function body(roll = 0, initialNose: V3 = Y): Body {
  const b = new Body([], spec.aero, spec.length);
  qLook(b.q, initialNose, Z);
  qMul(b.q, b.q, [0, Math.sin(roll / 2), 0, Math.cos(roll / 2)]);
  return b;
}

function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** atan2 avoids acos losing precision near perfect alignment. */
function angle(a: V3, b: V3): number {
  return Math.atan2(Math.hypot(...cross3(v3(), a, b)), dot3(a, b));
}

function orientationError(a: Q4, b: Q4): number {
  const delta = qMul(q4(), a, [-b[0], -b[1], -b[2], b[3]]);
  return 2 * Math.atan2(Math.hypot(delta[0], delta[1], delta[2]), Math.abs(delta[3]));
}

function rollError(q: Q4, reference: V3): number {
  const nose = qAxis(v3(), q, 1), belly = qAxis(v3(), q, 2);
  const parallel = dot3(nose, reference);
  const projected = reference.map((x, i) => x - parallel * nose[i]);
  // A degenerate reference must not make an orientation assertion pass accidentally.
  expect(Math.hypot(...projected)).toBeGreaterThan(1e-6);
  return angle(belly, projected);
}

describe('independent nose and roll control', () => {
  it('holds axial orientation when the raw guidance reference contains no roll information', () => {
    for (const initialNose of [[0, 1, 0], [0.3, 0.4, 0.5]]) for (const roll of [0.7, -1.8]) {
      const b = body(roll, initialNose), before = b.q.slice();
      const direction = qAxis(v3(), b.q, 1);
      for (let i = 0; i < 100; i++) steerFlight(b, direction, direction, 8 * DEG, 4 * DEG, 0.1);
      expect(orientationError(b.q, before)).toBeLessThan(1e-12);
      expect(Math.hypot(...b.w)).toBeLessThan(1e-12);
    }
  });

  it('brakes an inherited roll rate continuously when the roll reference becomes undefined', () => {
    const b = body(0.7); b.w[1] = 8 * DEG;
    let before = b.w[1];
    for (let i = 0; i < 30; i++) {
      steerFlight(b, Y, Y, 8 * DEG, 4 * DEG, 0.1);
      expect(Math.abs(b.w[1] - before)).toBeLessThanOrEqual(0.4 * DEG + 1e-12);
      expect(distance(qAxis(v3(), b.q, 1), Y)).toBeLessThan(1e-12);
      before = b.w[1];
    }
    expect(Math.hypot(...b.w)).toBeLessThan(1e-12);
  });

  it.each(['stationary', 'moving', 'antipodal at rest', 'antipodal with swing'].flatMap((motion) =>
    [{ frame: 'axis aligned', initialNose: Y }, { frame: 'tilted', initialNose: normalize3(v3(), [0.3, 0.8, -0.4]) }]
      .map(({ frame, initialNose }) => ({ motion, frame, initialNose })),
  ))(
    'preserves the whole nose trajectory under different rolls/references: $motion, $frame', ({ motion, initialNose }) => {
      const bodies = [0, Math.PI / 2, Math.PI, -0.73].map((roll) => body(roll, initialNose));
      const swingAxis = normalize3(v3(), cross3(v3(), initialNose, Z));
      for (let i = 0; i < bodies.length; i++) {
        // Different axial rates are allowed; transverse rates must start equal.
        bodies[i].w.set(initialNose.map((x, k) => x * (i - 1) * 0.01 + (motion === 'antipodal with swing' ? swingAxis[k] * 0.01 : 0)));
      }
      let worstNose = 0, worstNorm = 0;
      for (let step = 0; step < 2500; step++) {
        const t = step * 0.02;
        const target = motion.startsWith('antipodal') ? initialNose.map((x) => -x)
          : motion === 'moving' ? [Math.sin(t / 13), 0.8, 0.4 * Math.cos(t / 9)] : [1, 0.5, -0.3];
        const noses = bodies.map((b, i) => {
          const reference = [Math.sin(t / 7 + i * 1.3), 0.25, Math.cos(t / 7 + i * 1.3)];
          const error = slewNoseAndRoll(b, target, reference, 12 * DEG, 6 * DEG, 0.02);
          expect(Number.isFinite(error)).toBe(true);
          expect([...b.q, ...b.w].every(Number.isFinite)).toBe(true);
          worstNorm = Math.max(worstNorm, Math.abs(Math.hypot(...b.q) - 1));
          return qAxis(v3(), b.q, 1);
        });
        for (let i = 1; i < noses.length; i++) worstNose = Math.max(worstNose, distance(noses[0], noses[i]));
      }
      expect(worstNose).toBeLessThan(1e-9);
      expect(worstNorm).toBeLessThan(2e-14);
      if (motion.startsWith('antipodal')) expect(angle(qAxis(v3(), bodies[0].q, 1), initialNose.map((x) => -x))).toBeLessThan(0.01 * DEG);
    },
  );

  it.each([0.02, 0.1])('limits fixed-nose axial rate and acceleration and settles after a reversal (dt=%s)', (dt) => {
    const b = body(), rate = 8 * DEG, acc = 4 * DEG;
    let peakRate = 0, maxDelta = 0, worstNose = 0, worstNorm = 0;
    for (const degrees of [130, -70]) {
      const reference = [Math.sin(degrees * DEG), 0, Math.cos(degrees * DEG)];
      let settledError = 0, settledRate = 0;
      for (let step = 0; step < Math.round(40 / dt); step++) {
        const previous = b.w.slice();
        slewNoseAndRoll(b, Y, reference, rate, acc, dt);
        expect([...b.q, ...b.w].every(Number.isFinite)).toBe(true);
        peakRate = Math.max(peakRate, Math.abs(b.w[1]));
        maxDelta = Math.max(maxDelta, distance(b.w, previous));
        worstNose = Math.max(worstNose, distance(qAxis(v3(), b.q, 1), Y));
        worstNorm = Math.max(worstNorm, Math.abs(Math.hypot(...b.q) - 1));
        if (step * dt >= 35) {
          settledError = Math.max(settledError, rollError(b.q, reference));
          settledRate = Math.max(settledRate, Math.hypot(...b.w));
        }
      }
      expect(settledError).toBeLessThan(0.01 * DEG);
      expect(settledRate).toBeLessThan(0.01 * DEG);
    }
    expect(peakRate).toBeGreaterThan(0.99 * rate);
    expect(peakRate).toBeLessThanOrEqual(rate + 1e-12);
    expect(maxDelta).toBeLessThanOrEqual(acc * dt + 1e-12);
    expect(worstNose).toBeLessThan(1e-12);
    expect(worstNorm).toBeLessThan(2e-14);
  });

  it.each([0.02, 0.1])('limits pure swing rate/acceleration and settles without residual spin (dt=%s)', (dt) => {
    const b = body(), rate = 8 * DEG, acc = 4 * DEG;
    const target = [0, Math.cos(75 * DEG), Math.sin(75 * DEG)];
    const reference = [0, -Math.sin(75 * DEG), Math.cos(75 * DEG)];
    let peakRate = 0, maxDelta = 0, settledError = 0, settledRate = 0;
    for (let step = 0; step < Math.round(25 / dt); step++) {
      const previous = b.w.slice();
      slewNoseAndRoll(b, target, reference, rate, acc, dt);
      expect([...b.q, ...b.w].every(Number.isFinite)).toBe(true);
      expect(Math.abs(Math.hypot(...b.q) - 1)).toBeLessThan(2e-14);
      peakRate = Math.max(peakRate, Math.hypot(...b.w));
      maxDelta = Math.max(maxDelta, distance(b.w, previous));
      if (step * dt >= 20) {
        settledError = Math.max(settledError, angle(qAxis(v3(), b.q, 1), target));
        settledRate = Math.max(settledRate, Math.hypot(...b.w));
      }
    }
    expect(peakRate).toBeGreaterThan(0.99 * rate);
    expect(peakRate).toBeLessThanOrEqual(rate + 1e-12);
    expect(maxDelta).toBeLessThanOrEqual(acc * dt + 1e-12);
    expect(settledError).toBeLessThan(0.01 * DEG);
    expect(settledRate).toBeLessThan(0.01 * DEG);
  });

  it('leaves attitude, inherited angular velocity and translation untouched at zero dt', () => {
    const b = body(0.7);
    b.w.set([0.02, -0.03, 0.04]);
    b.r.set([1, 2, 3]); b.v.set([4, 5, 6]);
    const before = { q: b.q.slice(), w: b.w.slice(), r: b.r.slice(), v: b.v.slice() };
    expect(slewNoseAndRoll(b, [1, -1, 0], [-1, 0, 1], 0.1, 0.05, 0)).toBe(0);
    for (const key of ['q', 'w', 'r', 'v'] as const) expect(b[key]).toEqual(before[key]);
  });

  it('advances a 2 s coast interval like twenty 0.1 s attitude steps, including the quaternion wrapper', () => {
    const coarse = body(0.4), fine = body(0.4), wrapped = body(0.4);
    const target = normalize3(v3(), [1, 0.6, -0.2]), reference = normalize3(v3(), [-0.5, 0, 1]);
    const qTarget = qLook(q4(), target, reference);
    // Use the same orthogonal reference for both API forms.
    qAxis(reference, qTarget, 2);
    for (const b of [coarse, fine, wrapped]) b.w.set([0.01, -0.02, 0.005]);
    slewNoseAndRoll(coarse, target, reference, 0.15, 0.06, 2);
    slewFlight(wrapped, qTarget, 0.15, 0.06, 2);
    for (let i = 0; i < 20; i++) slewNoseAndRoll(fine, target, reference, 0.15, 0.06, 0.1);
    expect(orientationError(coarse.q, fine.q)).toBeLessThan(1e-12);
    expect(distance(coarse.w, fine.w)).toBeLessThan(1e-12);
    expect(orientationError(wrapped.q, fine.q)).toBeLessThan(1e-12);
    expect(distance(wrapped.w, fine.w)).toBeLessThan(1e-12);
  });

  it('converges as the attitude timestep is refined during simultaneous swing and roll', () => {
    const target = normalize3(v3(), [0.6, 0.6, 0.529]), reference = [-0.7, 0.2, 0.5];
    const integrate = (dt: number) => {
      const b = body(0.4);
      for (let i = 0; i < Math.round(6 / dt); i++) slewNoseAndRoll(b, target, reference, 8 * DEG, 4 * DEG, dt);
      return b;
    };
    const truth = integrate(0.00625);
    const errors = [0.1, 0.05, 0.025].map((dt) => orientationError(integrate(dt).q, truth.q));
    // Sub-degree convergence while still moving, not a vacuous comparison after all runs settle.
    expect(Math.hypot(...truth.w)).toBeGreaterThan(1 * DEG);
    expect(errors[0]).toBeLessThan(1 * DEG);
    expect(errors[1]).toBeLessThan(errors[0] * 0.7);
    expect(errors[2]).toBeLessThan(errors[1] * 0.7);
  });
});

describe('achieved flight roll orientation', () => {
  const runs = new Map<number, FlightResult>();
  beforeAll(() => {
    for (const n of [5, 14]) runs.set(n, simulateFlight(n, { asFlown: true, interventions: [] }));
  });

  it.each([5, 14].flatMap((flight) => [60, 120, 300, 400].map((t) => ({ flight, t }))))(
    'Flight $flight at T+$t points the heat shield toward its required roll reference', ({ flight, t }) => {
      const s = sampleTrack(runs.get(flight)!.ship, t, createTrackSample());
      expect(s.alive).toBe(true);
      const q = [s.quat.x, s.quat.y, s.quat.z, s.quat.w];
      const up = normalize3(v3(), [s.pos.x, s.pos.y, s.pos.z]);
      // Right of the ground track: recorded ECEF velocity already excludes Earth rotation.
      // Adding it here would tilt the early-ascent reference toward planetary rotation instead
      // of the trajectory over Earth. Later, orbital-plane steering differs slightly from this.
      const right = normalize3(v3(), cross3(v3(), [s.vel.x, s.vel.y, s.vel.z], up));
      const reference = flight === 14 && t >= 100 && t <= 315 ? up : right;
      const errorDeg = rollError(q, reference) / DEG;
      // A 5° orientation envelope allows steering/roll lag and a changing flight plane. It does not
      // claim measured roll telemetry; a wrong side or a missing 90° manoeuvre fails decisively.
      expect(errorDeg, `F${flight} T+${t}: heat-shield roll error ${errorDeg.toFixed(3)}°`).toBeLessThan(5);
    },
  );

  // Flight 14 plans a Gulf splashdown; only Flight 5 of these two runs is a catch.
  it.each([5])('Flight %s aligns the booster with the tower before the arms can square it up', (flight) => {
    const result = runs.get(flight)!;
    expect(result.booster.endKind).toBe('catch');
    const caught = result.booster.phase.findIndex((phase) => phase === Phase.Caught);
    expect(caught).toBeGreaterThan(0);
    const catchTime = result.booster.t[caught];
    const pad = PADS[getFlight(flight).pad], basis = localEnuBasis(pad.lat, pad.lon);
    const tower = basis.east.map((x, i) => x * pad.tower.east + basis.north[i] * pad.tower.north);
    for (const t of [catchTime - 0.1, catchTime]) {
      const s = sampleTrack(result.booster, t, createTrackSample());
      const q = [s.quat.x, s.quat.y, s.quat.z, s.quat.w];
      const errorDeg = rollError(q, tower) / DEG;
      // Evaluate the incoming vehicle as well as first contact, not the later arm animation.
      expect(errorDeg, `F${flight} T+${t.toFixed(3)}: catch roll error ${errorDeg.toFixed(3)}°`).toBeLessThan(2);
    }
  });
});
