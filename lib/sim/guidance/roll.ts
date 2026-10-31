import type { Q4 } from '../vec';

/** Ship mounting: qShip = qStack · Ry(π). Leaves the shared +Y axis and inertial angular velocity unchanged. */
export function mountedShipAttitude(out: Q4, stack: Q4): Q4 {
  const x = stack[0], y = stack[1], z = stack[2], w = stack[3];
  out[0] = -z;
  out[1] = w;
  out[2] = x;
  out[3] = -y;
  return out;
}
