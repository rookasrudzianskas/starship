import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { advanceFlaps, commandFlaps, DEFAULT_FLAP_ACTUATOR, flapFeedback, flapRateLimit, newFlaps, type FlapPhase } from '../guidance/flaps';

const A = DEFAULT_FLAP_ACTUATOR.maxAcceleration;
const V = DEFAULT_FLAP_ACTUATOR.maxRate;
const phases: FlapPhase[] = ['stow', 'entry', 'belly', 'flip'];

describe('flap command mixer', () => {
  it('starts stowed with independent actual, velocity and command storage for every ship', () => {
    const s = newFlaps(), other = newFlaps();
    expect(Array.from(s.angles)).toEqual([75, 75, 75, 75]);
    expect(Array.from(s.targets)).toEqual([75, 75, 75, 75]);
    expect(Array.from(s.rates)).toEqual([0, 0, 0, 0]);
    commandFlaps(s, 'entry');
    expect(Array.from(s.angles)).toEqual([75, 75, 75, 75]);
    expect(Array.from(s.rates)).toEqual([0, 0, 0, 0]);
    expect(Array.from(other.targets)).toEqual([75, 75, 75, 75]);
  });

  it.each([
    ['stow', [75, 75, 75, 75]],
    ['entry', [18, 18, 22, 22]],
    ['belly', [32, 32, 42, 42]],
    ['flip', [80, 80, 15, 15]],
  ] as const)('uses symmetric %s trim at zero feedback', (phase, expected) => {
    const s = newFlaps();
    commandFlaps(s, phase);
    expect(Array.from(s.targets)).toEqual(expected);
  });

  it('uses the same left/right differential at both ends, and opposite pitch differentials', () => {
    const s = newFlaps();
    commandFlaps(s, 'entry', 1, 0);
    expect(Array.from(s.targets)).toEqual([10, 26, 14, 30]);
    commandFlaps(s, 'entry', 0, 1);
    expect(Array.from(s.targets)).toEqual([28, 28, 12, 12]);
    commandFlaps(s, 'entry', 0, -1);
    expect(Array.from(s.targets)).toEqual([8, 8, 32, 32]);
  });

  it('bounds combined commands and preserves left/right symmetry under roll reversal', () => {
    const s = newFlaps(), opposite = newFlaps();
    for (const phase of phases) for (const roll of [-100, -1, -0.2, 0, 0.2, 1, 100]) for (const pitch of [-100, -1, 0, 1, 100]) {
      commandFlaps(s, phase, roll, pitch);
      commandFlaps(opposite, phase, -roll, pitch);
      for (let i = 0; i < 4; i++) {
        expect(s.targets[i]).toBeGreaterThanOrEqual(0);
        expect(s.targets[i]).toBeLessThanOrEqual(90);
        expect(s.targets[i]).toBe(opposite.targets[i ^ 1]);
      }
    }
    commandFlaps(s, 'stow', 1, -1);
    expect(Array.from(s.targets)).toEqual([75, 75, 75, 75]);
    commandFlaps(s, 'entry', NaN, Infinity);
    expect(Array.from(s.targets)).toEqual([18, 18, 22, 22]);
  });

  it('responds to angle error and damps rate; a held bank produces no permanent differential', () => {
    const s = newFlaps();
    expect(flapFeedback(6, 0)).toBe(0.5);
    expect(flapFeedback(-6, 0)).toBe(-0.5);
    expect(flapFeedback(0, 10)).toBe(-0.5);
    expect(flapFeedback(0, -10)).toBe(0.5);
    expect(flapFeedback(6, 10)).toBe(0);
    expect(flapFeedback(100, -100)).toBe(1);
    expect(flapFeedback(-100, 100)).toBe(-1);
    expect(flapFeedback(2, 1, 4, 4)).toBe(0.25);
    for (const bank of [-120, -45, 0, 45, 120]) {
      commandFlaps(s, 'entry', flapFeedback(bank - bank, 0));
      expect(Array.from(s.targets)).toEqual([18, 18, 22, 22]);
    }
    expect(flapFeedback(NaN, 0)).toBe(0);
    expect(flapFeedback(1, 0, 0)).toBe(0);
  });

  // Independent r×F check using mirrored/sloped hinge geometry, pressure normal to
  // a flat plate and representative COM between the fore/aft hinges. This checks torque signs,
  // not torque magnitudes: no measured aerodynamic coefficients are implied.
  function plateTorque(index: number, angle: number, forwardAzimuth: number): Vector3 {
    const left = index % 2 === 0, forward = index < 2;
    const side = left ? 1 : -1;
    const az = (forward ? forwardAzimuth : 90) * Math.PI / 180;
    const p0 = new Vector3(side * Math.sin(az) * 4.66, forward ? 35 : 1.25, Math.cos(az) * 4.66);
    const p1 = new Vector3(side * Math.sin(az) * (forward ? 3 : 4.66), forward ? 42 : 11.9, Math.cos(az) * (forward ? 3 : 4.66));
    const y = p1.clone().sub(p0).normalize();
    const x = y.clone().cross(new Vector3(0, 0, 1)).normalize();
    const z = x.clone().cross(y).normalize();
    const rotation = side * angle * Math.PI / 180;
    const normal = x.clone().multiplyScalar(Math.sin(rotation)).addScaledVector(z, Math.cos(rotation));
    const arm = p0.clone().addScaledVector(x, side * 1.5 * Math.cos(rotation))
      .addScaledVector(z, -side * 1.5 * Math.sin(rotation)).addScaledVector(y, p0.distanceTo(p1) * 0.5);
    arm.y -= 20;
    const force = normal.clone().multiplyScalar(-(Math.max(0, normal.z) ** 2));
    return arm.cross(force);
  }

  it.each([90, 116, 120])('produces the requested torque signs with %s° forward hinges', (azimuth) => {
    const s = newFlaps();
    for (const phase of ['entry', 'belly'] as const) {
      commandFlaps(s, phase);
      const trim = Array.from(s.targets);
      for (const sign of [-1, 1]) {
        commandFlaps(s, phase, sign, 0);
        for (const pair of [0, 2]) {
          const delta = plateTorque(pair, s.targets[pair], azimuth).y + plateTorque(pair + 1, s.targets[pair + 1], azimuth).y;
          expect(delta * sign).toBeGreaterThan(0);
        }
        commandFlaps(s, phase, 0, sign);
        for (let i = 0; i < 4; i++) {
          const delta = plateTorque(i, s.targets[i], azimuth).x - plateTorque(i, trim[i], azimuth).x;
          expect(delta * sign).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('flap actuator', () => {
  it('keeps omitted, scalar and uniform ArrayLike pressure paths bit-identical through mixed commands', () => {
    const scalar = newFlaps(), array = newFlaps(), omitted = newFlaps(), zero = newFlaps();
    for (let n = 0; n < 80; n++) {
      const dt = [0.001, 0.02, 0.17, 2][n % 4], q = [0, 20_000, 100_000, Infinity, NaN, -1][n % 6];
      for (const s of [scalar, array, omitted, zero]) commandFlaps(s, phases[n % 4], Math.sin(n), Math.cos(n));
      advanceFlaps(scalar, dt, q);
      advanceFlaps(array, dt, { length: 4, 0: q, 1: q, 2: q, 3: q });
      expect(array).toEqual(scalar);
      advanceFlaps(omitted, dt);
      advanceFlaps(zero, dt, 0);
      expect(omitted).toEqual(zero);
    }
  });

  it('decelerates independently and continuously when per-flap pressure changes', () => {
    const s = newFlaps(), pressure = new Float64Array(4), independent = Array.from({ length: 4 }, () => newFlaps());
    s.targets.fill(0);
    for (const state of independent) state.targets.fill(0);
    for (let step = 0; step < 50; step++) {
      pressure.set(step < 25 ? [0, 0, 0, 0] : [Infinity, 0, 20_000, 100_000]);
      const before = s.rates.slice();
      advanceFlaps(s, 0.02, pressure);
      for (let i = 0; i < 4; i++) {
        advanceFlaps(independent[i], 0.02, pressure[i]);
        expect(s.angles[i]).toBe(independent[i].angles[i]);
        expect(s.rates[i]).toBe(independent[i].rates[i]);
        expect(Math.abs(s.rates[i] - before[i])).toBeLessThanOrEqual(A * 0.02 + 1e-12);
      }
      if (step === 25) {
        expect(s.rates[0]).toBeCloseTo(-30 + A * 0.02, 12);
        expect(s.rates[1]).toBe(-30);
      }
    }
    expect(s.rates[0]).toBe(-V * DEFAULT_FLAP_ACTUATOR.minRateFraction);
  });

  it('integrates a trapezoidal slew and stops at the target without skipping the braking point', () => {
    const s = newFlaps();
    s.targets.fill(0);
    advanceFlaps(s, 0.5, 0);
    expect(s.angles[0]).toBeCloseTo(67.5, 12);
    expect(s.rates[0]).toBe(-30);
    advanceFlaps(s, 2, 0);
    expect(s.angles[0]).toBeCloseTo(7.5, 12);
    expect(s.rates[0]).toBe(-30);
    advanceFlaps(s, 0.5, 0);
    expect(Array.from(s.angles)).toEqual([0, 0, 0, 0]);
    expect(Array.from(s.rates)).toEqual([0, 0, 0, 0]);
  });

  it('brakes a short triangular slew without reaching the speed cap', () => {
    const s = newFlaps();
    s.targets.fill(74);
    advanceFlaps(s, 0.1, 0);
    expect(s.angles[0]).toBeCloseTo(74.7, 12);
    expect(s.rates[0]).toBeCloseTo(-6, 12);
    advanceFlaps(s, 2, 0);
    expect(Array.from(s.angles)).toEqual([74, 74, 74, 74]);
    expect(Array.from(s.rates)).toEqual([0, 0, 0, 0]);
  });

  it.each([0.001, 0.02, 0.1, 0.7, 2])('settles monotonically without overshoot at dt=%ss', (dt) => {
    const s = newFlaps();
    s.targets.set([0, 18, 75.01, 90]);
    const direction = [-1, -1, 1, 1];
    for (let t = 0; t < 10; t += dt) {
      const before = s.angles.slice(), rates = s.rates.slice();
      advanceFlaps(s, dt, 15_000);
      for (let i = 0; i < 4; i++) {
        expect((s.angles[i] - before[i]) * direction[i]).toBeGreaterThanOrEqual(-1e-10);
        expect((s.targets[i] - s.angles[i]) * direction[i]).toBeGreaterThanOrEqual(-1e-10);
        expect(Math.abs(s.rates[i])).toBeLessThanOrEqual(flapRateLimit(15_000) + 1e-10);
        expect(Math.abs(s.rates[i] - rates[i])).toBeLessThanOrEqual(A * dt + 1e-8);
      }
    }
    expect(s.angles).toEqual(s.targets);
    expect(Array.from(s.rates)).toEqual([0, 0, 0, 0]);
  });

  it.each([0, 20_000, 100_000])('agrees across coarse and irregular step partitions at q=%s Pa', (q) => {
    const coarse = newFlaps(), fine = newFlaps(), split = newFlaps();
    for (const s of [coarse, fine, split]) s.targets.set([18, 22, 80, 15]);
    for (let block = 0; block < 6; block++) {
      advanceFlaps(coarse, 2, q);
      for (let step = 0; step < 100; step++) advanceFlaps(fine, 0.02, q);
      for (const dt of [0.001, 0.173, 1.826]) advanceFlaps(split, dt, q);
      for (let i = 0; i < 4; i++) {
        expect(coarse.angles[i]).toBeCloseTo(fine.angles[i], 9);
        expect(coarse.rates[i]).toBeCloseTo(fine.rates[i], 9);
        expect(coarse.angles[i]).toBeCloseTo(split.angles[i], 9);
        expect(coarse.rates[i]).toBeCloseTo(split.rates[i], 9);
      }
    }
  });

  it('freezes every state array for zero, negative and nonfinite dt', () => {
    const s = newFlaps();
    commandFlaps(s, 'entry', 0.5, -0.5);
    advanceFlaps(s, 0.2, 0);
    const saved = { angles: s.angles.slice(), rates: s.rates.slice(), targets: s.targets.slice() };
    for (const dt of [0, -1, NaN, Infinity]) {
      advanceFlaps(s, dt, 1e6);
      expect(s).toEqual(saved);
    }
  });

  it('brakes continuously before reversing, including a new target inside the stopping distance', () => {
    const s = newFlaps();
    s.targets.fill(0);
    advanceFlaps(s, 0.5, 0);
    // At 67.5°, -30°/s, stopping distance is 7.5°. Crossing 66° is physically unavoidable.
    s.targets.fill(66);
    advanceFlaps(s, 0.1, 0);
    expect(s.angles[0]).toBeCloseTo(64.8, 12);
    expect(s.rates[0]).toBeCloseTo(-24, 12);
    advanceFlaps(s, 0.4, 0);
    expect(s.angles[0]).toBeCloseTo(60, 12);
    expect(s.rates[0]).toBeCloseTo(0, 12);
    advanceFlaps(s, 2, 0);
    expect(Array.from(s.angles)).toEqual([66, 66, 66, 66]);
    expect(Array.from(s.rates)).toEqual([0, 0, 0, 0]);
  });

  it('slows smoothly with pressure, retains a speed floor and decelerates to a newly lowered cap', () => {
    const { minRateFraction, pressureScale } = DEFAULT_FLAP_ACTUATOR;
    const floor = V * minRateFraction;
    expect(flapRateLimit(0)).toBe(V);
    expect(flapRateLimit(pressureScale)).toBeCloseTo((V + floor) / 2, 12);
    expect(flapRateLimit(Infinity)).toBe(floor);
    expect(flapRateLimit(-100)).toBe(V);
    expect(flapRateLimit(NaN)).toBe(V);
    let previous = V;
    for (const q of [1, 1e3, 1e4, 1e5, 1e6, 1e12]) {
      const limit = flapRateLimit(q);
      expect(limit).toBeLessThan(previous);
      expect(limit).toBeGreaterThan(floor);
      previous = limit;
    }
    expect(Math.abs(flapRateLimit(pressureScale + 0.001) - flapRateLimit(pressureScale - 0.001))).toBeLessThan(1e-6);
    const loaded = newFlaps(), unloaded = newFlaps();
    for (const s of [loaded, unloaded]) s.targets.fill(0);
    advanceFlaps(loaded, 2, 100_000);
    advanceFlaps(unloaded, 2, 0);
    expect(loaded.angles[0]).toBeGreaterThan(unloaded.angles[0]);
    const s = newFlaps();
    s.targets.fill(0);
    advanceFlaps(s, 0.5, 0);
    advanceFlaps(s, 0.01, Infinity);
    expect(s.rates[0]).toBeCloseTo(-V + A * 0.01, 12);
    advanceFlaps(s, 0.5, Infinity);
    expect(s.rates[0]).toBe(-floor);
    advanceFlaps(s, 10, Infinity);
    expect(s.angles[0]).toBe(0);
    expect(s.rates[0]).toBe(0);
  });

  it('accepts actuator tuning and individual target overrides without reallocating the state', () => {
    const s = newFlaps(), angles = s.angles, rates = s.rates, targets = s.targets;
    const actuator = { ...DEFAULT_FLAP_ACTUATOR, maxRate: 12, maxAcceleration: 24 };
    commandFlaps(s, 'entry');
    s.targets.set([-100, 100, NaN, 45]);
    advanceFlaps(s, 0.25, 0, actuator);
    expect(s.rates[0]).toBe(-6);
    expect(s.angles[0]).toBeCloseTo(74.25, 12);
    for (let i = 0; i < 10; i++) advanceFlaps(s, 2, 0, actuator);
    expect(Array.from(s.angles)).toEqual([0, 90, 75, 45]);
    expect(s.angles).toBe(angles);
    expect(s.rates).toBe(rates);
    expect(s.targets).toBe(targets);
    expect(Array.from(s.targets)).toEqual([-100, 100, NaN, 45]);
  });

  it('keeps travel, speed and acceleration bounded through deterministic mixed commands and pressure changes', () => {
    const s = newFlaps();
    let seed = 4321;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let n = 0; n < 1500; n++) {
      const dt = [0.001, 0.008, 0.02, 0.1, 0.5, 2][n % 6];
      commandFlaps(s, phases[Math.floor(random() * phases.length)], 2 * random() - 1, 2 * random() - 1);
      if (n % 9 === 0) s.targets[Math.floor(random() * 4)] = n % 2 ? 0 : 90;
      const before = s.angles.slice(), rates = s.rates.slice();
      advanceFlaps(s, dt, random() * 100_000);
      for (let i = 0; i < 4; i++) {
        expect(s.angles[i]).toBeGreaterThanOrEqual(-1e-9);
        expect(s.angles[i]).toBeLessThanOrEqual(90 + 1e-9);
        expect(Math.abs(s.rates[i])).toBeLessThanOrEqual(V + 1e-9);
        expect(Math.abs(s.rates[i] - rates[i])).toBeLessThanOrEqual(A * dt + 1e-8);
        expect(Math.abs(s.angles[i] - before[i])).toBeLessThanOrEqual(V * dt + 1e-8);
        expect(Math.abs(s.angles[i] - before[i] - rates[i] * dt)).toBeLessThanOrEqual(0.5 * A * dt * dt + 1e-8);
      }
    }
  });
});
