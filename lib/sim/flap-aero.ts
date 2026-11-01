import { SHIP_GEOMETRY, shipNoseRadius, flapLeadingEdge } from './ship-geometry';
import type { Generation } from './types';
import { DEG, qAxis as qAxisFn, type Q4, type V3 } from './vec';

/** Hinge frame and pressure centre of each rendered flap, evaluated once per generation. */
interface PlatePose { angle: number; nx: number; ny: number; nz: number; rx: number; ry: number; rz: number }
interface Plate { area: number; cx: number; cy: number; p: number[]; x: number[]; y: number[]; z: number[]; poses: PlatePose[] }
function emptyPose(): PlatePose { return { angle: NaN, nx: 0, ny: 0, nz: 0, rx: 0, ry: 0, rz: 0 }; }
function plate(gen: Generation, index: number): Plate {
  const geometry = SHIP_GEOMETRY[gen], fwd = index < 2;
  const spec = fwd ? geometry.fwd : geometry.aft, side = (index & 1) ? -1 : 1;
  const az = spec.az * side, base = fwd ? geometry.noseBase : 0;
  const point = (h: number) => {
    const height = base + h;
    const radius = (height <= geometry.noseBase ? 4.5 : shipNoseRadius(height - geometry.noseBase, geometry.length - geometry.noseBase)) + 0.16;
    return [Math.sin(az) * radius, height, Math.cos(az) * radius];
  };
  const p = point(spec.h0), end = point(spec.h1), y = end.map((v, i) => v - p[i]);
  const root = Math.hypot(...y); for (let i = 0; i < 3; i++) y[i] /= root;
  const x = [y[1], -y[0], 0], xl = Math.hypot(...x); for (let i = 0; i < 3; i++) x[i] /= xl;
  const z = [x[1] * y[2], -x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < 64; i++) {
    const a = (i + 0.5) / 64, low = a * spec.plan.tipY0, high = flapLeadingEdge(root, spec.plan, a);
    const strip = (high - low) * spec.plan.span / 64;
    area += strip; cx += strip * a * spec.plan.span; cy += strip * (high + low) / 2;
  }
  return { area, cx: side * cx / area, cy: cy / area, p, x, y, z, poses: [emptyPose(), emptyPose()] };
}
const PLATES = Object.fromEntries((['b1', 'b2', 'v3'] as const).map(gen => [gen, [0, 1, 2, 3].map(i => plate(gen, i))])) as Record<Generation, Plate[]>;

const qAxis = qAxisFn;
const D = DEG;
const xAxis = new Float64Array(3), yAxis = new Float64Array(3), zAxis = new Float64Array(3);

/** Geometry depends only on hinge angle. Reuse it while still evaluating flow, pressure and CoM
 * every physics step. Separate actual/automatic poses keep a moving surface from evicting its trim.
 */
function platePose(g: Plate, sample: number, angle: number): PlatePose {
  const p = g.poses[sample];
  if (angle === p.angle) return p;
  const sin = Math.sin(angle), cos = Math.cos(angle);
  p.angle = angle;
  p.nx = g.x[0] * sin + g.z[0] * cos;
  p.ny = g.x[1] * sin + g.z[1] * cos;
  p.nz = g.x[2] * sin + g.z[2] * cos;
  p.rx = g.p[0] + g.cx * (g.x[0] * cos - g.z[0] * sin) + g.cy * g.y[0];
  p.ry = g.p[1] + g.cx * (g.x[1] * cos - g.z[1] * sin) + g.cy * g.y[1];
  p.rz = g.p[2] + g.cx * (g.x[2] * cos - g.z[2] * sin) + g.cy * g.y[2];
  return p;
}

/**
 * Trim-relative four-plate loads in body axes. The calibrated whole-ship coefficients already
 * include trimmed flaps and ideal attitude control; only the difference from the automatic
 * commands is added. This avoids counting their drag twice while retaining actuator lag and
 * manual overrides. Normals follow each actual hinge rotation; moments use the current CoM.
 * At equal actual/automatic angles the incremental wrench is exactly zero.
 */
export function flapLoads(
  force: V3, moment: V3, gen: Generation, angles: ArrayLike<number>, automatic: ArrayLike<number>,
  flow: V3, dynamicPressure: number, com: number,
): void {
  force.fill(0); moment.fill(0);
  const speed = Math.sqrt(flow[0] * flow[0] + flow[1] * flow[1] + flow[2] * flow[2]);
  if (!(dynamicPressure > 0) || speed < 0.05) return;
  const ux = flow[0] / speed, uy = flow[1] / speed, uz = flow[2] / speed;
  const plates = PLATES[gen];
  for (let i = 0; i < 4; i++) {
    if (angles[i] === automatic[i]) continue;
    const g = plates[i];
    const side = (i & 1) === 0 ? 1 : -1;
    for (let sample = 0; sample < 2; sample++) {
      const angle = (sample === 0 ? angles[i] : automatic[i]) * D * side;
      const pose = platePose(g, sample, angle);
      const nx = pose.nx, ny = pose.ny, nz = pose.nz;
      const incidence = ux * nx + uy * ny + uz * nz;
      // Two-sided Newtonian plate: pressure opposes incident flow on either face.
      const pressure = -2 * dynamicPressure * g.area * incidence * Math.abs(incidence) * (sample === 0 ? 1 : -1);
      const fx = pressure * nx, fy = pressure * ny, fz = pressure * nz;
      const rx = pose.rx, ry = pose.ry - com, rz = pose.rz;
      force[0] += fx; force[1] += fy; force[2] += fz;
      moment[0] += ry * fz - rz * fy;
      moment[1] += rz * fx - rx * fz;
      moment[2] += rx * fy - ry * fx;
    }
  }
}

/** Transform the incremental force and moment, using cylindrical inertia estimates.
 * Translation is added by stepBody; finite-authority attitude guidance must counter these
 * angular disturbances on its next update rather than replacing the attitude outright.
 */
export function flapResponse(
  force: V3, acceleration: V3, moment: V3, gen: Generation, angles: ArrayLike<number>, automatic: ArrayLike<number>,
  q: Q4, vAir: V3, dynamicPressure: number, mass: number, length: number, com: number,
): void {
  if (angles[0] === automatic[0] && angles[1] === automatic[1] && angles[2] === automatic[2] && angles[3] === automatic[3]) {
    force.fill(0); acceleration.fill(0); moment.fill(0);
    return;
  }
  qAxis(xAxis, q, 0); qAxis(yAxis, q, 1); qAxis(zAxis, q, 2);
  const vx = vAir[0] * xAxis[0] + vAir[1] * xAxis[1] + vAir[2] * xAxis[2];
  const vy = vAir[0] * yAxis[0] + vAir[1] * yAxis[1] + vAir[2] * yAxis[2];
  const vz = vAir[0] * zAxis[0] + vAir[1] * zAxis[1] + vAir[2] * zAxis[2];
  localFlow[0] = vx; localFlow[1] = vy; localFlow[2] = vz;
  flapLoads(force, moment, gen, angles, automatic, localFlow, dynamicPressure, com);
  const fx = force[0], fy = force[1], fz = force[2];
  const transverse = mass * (length * length / 12 + 4.5 * 4.5 / 4);
  const axial = mass * 4.5 * 4.5 / 2;
  const ax = moment[0] / transverse, ay = moment[1] / axial, az = moment[2] / transverse;
  for (let i = 0; i < 3; i++) {
    force[i] = fx * xAxis[i] + fy * yAxis[i] + fz * zAxis[i];
    acceleration[i] = ax * xAxis[i] + ay * yAxis[i] + az * zAxis[i];
  }
}
const localFlow = new Float64Array(3);
