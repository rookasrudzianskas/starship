import { FLAPS_STOWED } from '../vehicles';

/** All arrays use [forward left, forward right, aft left, aft right]; left is body +X. */
export interface FlapState {
  /** Actual angles, deg: 0 = spread, 90 = folded leeward. Only advanceFlaps writes these. */
  readonly angles: Float64Array;
  /** Actual hinge velocities, deg/s. Only advanceFlaps writes these. */
  readonly rates: Float64Array;
  /** Commands, deg. May be overridden individually after commandFlaps; travel is limited to [0, 90]. */
  readonly targets: Float64Array;
}

export type FlapPhase = 'stow' | 'entry' | 'belly' | 'flip';

export interface FlapActuator {
  /** Unloaded hinge speed, deg/s. */
  readonly maxRate: number;
  /** Acceleration/braking authority, deg/s². */
  readonly maxAcceleration: number;
  /** Dynamic pressure, Pa, at the midpoint between unloaded and minimum speed. */
  readonly pressureScale: number;
  /** Asymptotic fraction of unloaded speed under high pressure, in (0, 1]. */
  readonly minRateFraction: number;
}

/** Plausible reconstruction parameters, NOT measured Starship actuator specifications. */
export const DEFAULT_FLAP_ACTUATOR: Readonly<FlapActuator> = Object.freeze({
  maxRate: 30,
  maxAcceleration: 60,
  pressureScale: 20_000,
  minRateFraction: 0.35,
});

/** Allocates once per ship; commandFlaps and advanceFlaps allocate nothing. */
export function newFlaps(): FlapState {
  return {
    angles: new Float64Array(4).fill(FLAPS_STOWED),
    rates: new Float64Array(4),
    targets: new Float64Array(4).fill(FLAPS_STOWED),
  };
}

function demand(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

/**
 * Normalized PD demand from signed target-minus-actual angle error (deg) and measured rate (deg/s).
 * For pitch, supply the signed AoA/attitude error about body +X; for roll, error about body +Y.
 * errorScale/rateScale are positive tuning scales. A held bank with zero error/rate gives zero demand.
 */
export function flapFeedback(error: number, rate: number, errorScale = 12, rateScale = 20): number {
  if (!(errorScale > 0) || !(rateScale > 0)) return 0;
  return demand(error / errorScale - rate / rateScale);
}

/**
 * Set phase trim plus normalized [-1, 1] torque demands; this never moves the actual flaps.
 * Positive roll is about body +Y; positive pitch is about body +X (nose towards the +Z belly).
 *
 * With belly-first flow, pressure acts opposite the windward normals, predominantly -Z. Since
 * torqueY = z*Fx - x*Fz, deploying the +X/left flaps and folding the -X/right flaps gives +Y roll.
 * Both fore and aft pairs need the SAME differential. Since torqueX = y*Fz - z*Fy, folding the
 * forward (+y relative to COM) pair and deploying the aft (-y) pair gives +X pitch. These signs
 * follow the mirrored hinges/normals in lib/three/vehicles/{ship,parts}.ts; they are not bank angles.
 * This is a reduced-order mixer, not a force/torque solver or a measured control law.
 */
export function commandFlaps(state: FlapState, phase: FlapPhase, rollDemand = 0, pitchDemand = 0): void {
  let forward = FLAPS_STOWED, aft = FLAPS_STOWED;
  if (phase === 'entry') { forward = 18; aft = 22; }
  else if (phase === 'belly') { forward = 32; aft = 42; }
  else if (phase === 'flip') { forward = 80; aft = 15; }
  const roll = phase === 'stow' ? 0 : demand(rollDemand) * 8;
  const pitch = phase === 'stow' ? 0 : demand(pitchDemand) * 10;
  // Numerical command resolution prevents sub-hundredth-degree guidance noise from keeping
  // every actuator active throughout a settled coast or trim. Manual targets retain their precision.
  state.targets[0] = Math.round(Math.max(0, Math.min(90, forward + pitch - roll)) * 100) / 100;
  state.targets[1] = Math.round(Math.max(0, Math.min(90, forward + pitch + roll)) * 100) / 100;
  state.targets[2] = Math.round(Math.max(0, Math.min(90, aft - pitch - roll)) * 100) / 100;
  state.targets[3] = Math.round(Math.max(0, Math.min(90, aft - pitch + roll)) * 100) / 100;
}

/** Smooth pressure loading with a nonzero speed floor. Negative/NaN pressure is treated as zero. */
export function flapRateLimit(q: number, actuator: Readonly<FlapActuator> = DEFAULT_FLAP_ACTUATOR): number {
  const pressure = q > 0 ? q : 0;
  return actuator.maxRate * (actuator.minRateFraction + (1 - actuator.minRateFraction) / (1 + pressure / actuator.pressureScale));
}

/**
 * Advance four independent rate/acceleration-limited hinges, in place; dt is seconds, q is Pa.
 * q may be a shared scalar (legacy behavior), or four actual plate normal pressures in flap order.
 * Omitted q means unloaded. The per-flap form changes only cruise speed, not braking authority.
 * Uses exact constant-acceleration/coast segments, so a 2 s coast step cannot skip the braking point.
 * Commands and pressure are held throughout the step. Finite positive actuator parameters required.
 * Nonpositive/nonfinite dt freezes state. Invalid target values hold the current angle.
 *
 * A fixed, reachable target is reached at zero speed without overshoot. A command inside the current
 * stopping distance necessarily gets crossed while braking, then approached from rest; snapping there
 * would violate the acceleration limit. Likewise, a newly lowered pressure speed cap is approached
 * with finite deceleration, not an instantaneous rate clamp. Braking authority stays constant with q.
 * Callers may override targets, but must leave the internally maintained angles/rates intact.
 */
export function advanceFlaps(state: FlapState, dt: number, q: number | ArrayLike<number> = 0, actuator: Readonly<FlapActuator> = DEFAULT_FLAP_ACTUATOR): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  if (state.angles[0] === state.targets[0] && state.angles[1] === state.targets[1] && state.angles[2] === state.targets[2] && state.angles[3] === state.targets[3]
      && state.rates[0] === 0 && state.rates[1] === 0 && state.rates[2] === 0 && state.rates[3] === 0) return;
  const acceleration = actuator.maxAcceleration;
  const sharedLimit = typeof q === 'number' ? flapRateLimit(q, actuator) : 0;
  if (!(acceleration > 0) || !Number.isFinite(acceleration)) return;
  for (let i = 0; i < 4; i++) {
    const speedLimit = typeof q === 'number' ? sharedLimit : flapRateLimit(q[i], actuator);
    if (!(speedLimit > 0) || !Number.isFinite(speedLimit)) continue;
    let angle = state.angles[i], rate = state.rates[i], remaining = dt;
    const command = state.targets[i];
    const target = Number.isFinite(command) ? Math.max(0, Math.min(90, command)) : angle;
    // At most: brake away/excess speed, accelerate, coast, brake to target, settle.
    // The extra iterations accommodate roundoff at a segment boundary, without a dt-dependent loop.
    for (let segment = 0; segment < 8 && remaining > 0; segment++) {
      const error = target - angle;
      if (Math.abs(error) <= 1e-10 && Math.abs(rate) <= 1e-9) {
        angle = target;
        rate = 0;
        break;
      }
      const direction = error > 0 ? 1 : error < 0 ? -1 : rate > 0 ? -1 : 1;
      const distance = Math.abs(error), speed = rate * direction;
      const stoppingDistance = speed * speed / (2 * acceleration);
      let accel: number, duration: number, endRate: number;
      let stopAtTarget = false;
      if (speed < 0) {
        // Moving away from the command: stop before trying to reverse.
        accel = direction * acceleration;
        duration = -speed / acceleration;
        endRate = 0;
      } else if (distance <= stoppingDistance + 1e-10) {
        accel = -direction * acceleration;
        duration = speed / acceleration;
        endRate = 0;
        stopAtTarget = Math.abs(distance - stoppingDistance) <= 1e-10;
      } else if (speed > speedLimit) {
        // Pressure loading lowered the cruise limit; decelerate continuously to it.
        accel = -direction * acceleration;
        duration = (speed - speedLimit) / acceleration;
        endRate = direction * speedLimit;
      } else if (speed < speedLimit) {
        // Solve accelerate-then-brake distance exactly, capped by the loaded cruise speed.
        const peak = Math.min(speedLimit, Math.sqrt(acceleration * distance + 0.5 * speed * speed));
        accel = direction * acceleration;
        duration = (peak - speed) / acceleration;
        endRate = direction * peak;
      } else {
        accel = 0;
        duration = (distance - stoppingDistance) / speed;
        endRate = rate;
      }
      const step = Math.min(remaining, duration);
      angle += rate * step + 0.5 * accel * step * step;
      rate += accel * step;
      remaining -= step;
      if (step === duration) {
        rate = endRate;
        if (stopAtTarget) angle = target;
      }
    }
    state.angles[i] = angle;
    state.rates[i] = rate;
  }
}
