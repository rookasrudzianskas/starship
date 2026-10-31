import { atmosphereInto, type AtmosphereState } from '../../sim/atmosphere';
import { jetStream } from '../../sim/physics';
import { scenarioKey } from '../../sim/scenario';
import type { Quat, Vec3 } from '../../sim/sample';
import type { Scenario } from '../../sim/types';

interface EnvironmentSample {
  alt: number;
  pos: ArrayLike<number>; // ECEF metres
  vel: ArrayLike<number>; // Earth-relative ECEF m/s
  quat: Quat; // body → ECEF
}

interface FlightEnvironment {
  ambientPressure: number;
  airflowBody: Vec3;
}

/** Writes visual inputs from the simulator's atmosphere and wind model, using caller-owned scratch. */
export function flightEnvironmentInto(
  sample: EnvironmentSample,
  windPeak: number,
  atmosphere: AtmosphereState,
  out: FlightEnvironment,
): FlightEnvironment {
  out.ambientPressure = atmosphereInto(sample.alt, atmosphere).pressure;
  // The tracks already subtract Earth rotation. Oncoming flow is wind − ground velocity.
  let x = -sample.vel[0], y = -sample.vel[1], z = -sample.vel[2];
  const w = jetStream(sample.alt, windPeak);
  if (w !== 0) {
    const rx = sample.pos[0], ry = sample.pos[1];
    const h = Math.sqrt(rx * rx + ry * ry);
    // Match airVelocity's polar guard: east is undefined on the rotation axis.
    if (h > 1) {
      x -= (w * ry) / h;
      y += (w * rx) / h;
    }
  }
  const speedSq = x * x + y * y + z * z;
  const flow = out.airflowBody;
  if (!(speedSq > 1)) {
    // Preserve the stage's quiet-air fallback instead of amplifying noise below 1 m/s.
    flow.x = 0;
    flow.y = 1;
    flow.z = 0;
    return out;
  }
  const invSpeed = 1 / Math.sqrt(speedSq);
  x *= invSpeed;
  y *= invSpeed;
  z *= invSpeed;

  // Inverse of the normalised body→ECEF quaternion, without mutating the sampled attitude.
  const q = sample.quat;
  const normSq = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  let qx = 0, qy = 0, qz = 0, qw = 1;
  if (normSq > 0 && Number.isFinite(normSq)) {
    const invNorm = 1 / Math.sqrt(normSq);
    qx = -q.x * invNorm;
    qy = -q.y * invNorm;
    qz = -q.z * invNorm;
    qw = q.w * invNorm;
  }
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  flow.x = x + qw * tx + qy * tz - qz * ty;
  flow.y = y + qw * ty + qz * tx - qx * tz;
  flow.z = z + qw * tz + qx * ty - qy * tx;
  return out;
}

/**
 * A worker result may still belong to an earlier scenario. Resolve only a matching snapshot;
 * null means its wind is unknown, so the stage can retain the wind already paired with that result.
 * Call on result/scenario changes, not each animation frame (scenario keys sort interventions).
 */
export function resultWindPeak(key: string, current: Scenario, past: readonly Scenario[], future: readonly Scenario[]): number | null {
  if (scenarioKey(current) === key) return Math.max(0, current.wind ?? 0);
  for (let i = past.length - 1; i >= 0; i--) {
    if (scenarioKey(past[i]) === key) return Math.max(0, past[i].wind ?? 0);
  }
  for (let i = future.length - 1; i >= 0; i--) {
    if (scenarioKey(future[i]) === key) return Math.max(0, future[i].wind ?? 0);
  }
  return null;
}
