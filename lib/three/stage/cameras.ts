import * as THREE from 'three';
// Relative so the cameras can be unit tested (vitest has no @/ alias).
import { EARTH_RADIUS } from '../../sim/types';
import { copy3, dist3, enuAt, offsetEnu, type V3 } from './geo';

export interface CameraPose {
  pos: V3;
  quat: THREE.Quaternion;
  /** Vertical field of view, degrees. */
  fov: number;
}

export function createPose(): CameraPose {
  return { pos: [0, 0, 0], quat: new THREE.Quaternion(), fov: 50 };
}

export function copyPose(a: CameraPose, out: CameraPose): CameraPose {
  copy3(a.pos, out.pos);
  out.quat.copy(a.quat);
  out.fov = a.fov;
  return out;
}

const m4 = new THREE.Matrix4();
const vZero = new THREE.Vector3();
const vDir = new THREE.Vector3();

/** Orient a pose to look from its position towards `target` with the given up vector. */
export function lookAt(pose: CameraPose, target: V3, up: THREE.Vector3): CameraPose {
  vDir.set(target[0] - pose.pos[0], target[1] - pose.pos[1], target[2] - pose.pos[2]);
  if (vDir.lengthSq() < 1e-9) return pose;
  m4.lookAt(vZero, vDir, up);
  pose.quat.setFromRotationMatrix(m4);
  return pose;
}

/** Field of view that fits an object of `size` metres at `distance` into `fill` of the frame height. */
export function fitFov(size: number, distance: number, fill: number, min = 0.25, max = 75): number {
  const fov = (2 * Math.atan((size / fill) / (2 * Math.max(1, distance))) * 180) / Math.PI;
  return Math.min(max, Math.max(min, fov));
}

/** What a camera can follow. */
export interface Focus {
  pos: V3;
  /** Where it is heading over the ground: a horizontal unit vector (see course.ts). */
  course: V3;
  /** Length of the thing being framed, m. */
  size: number;
}

/** A camera that follows a vehicle stays at least this high above the sea (the pad's ground is 3 m up), m. */
export const MIN_CAMERA_ALTITUDE = 10;

const east = new THREE.Vector3();
const north = new THREE.Vector3();
const up = new THREE.Vector3();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const orbitTarget: V3 = [0, 0, 0];
const globeLook: V3 = [0, 0, 0];

/** Lowest elevation (radians) at which a camera `dist` m from a point `alt` m up stays MIN_CAMERA_ALTITUDE up. */
function minElevation(alt: number, dist: number): number {
  return Math.asin(Math.min(1, Math.max(-1, (MIN_CAMERA_ALTITUDE - alt) / Math.max(1, dist))));
}

/** Orbit-style offset in the target's east/north/up frame (azimuth clockwise from north), kept off the ground. */
function orbitOffset(target: V3, azDeg: number, elDeg: number, dist: number, out: V3): V3 {
  const az = (azDeg * Math.PI) / 180;
  const alt = Math.hypot(target[0], target[1], target[2]) - EARTH_RADIUS;
  const el = Math.max((elDeg * Math.PI) / 180, minElevation(alt, dist));
  const e = Math.sin(az) * Math.cos(el) * dist;
  const n = Math.cos(az) * Math.cos(el) * dist;
  const u = Math.sin(el) * dist;
  return offsetEnu(target, e, n, u, out);
}

/**
 * Offset from a vehicle in the frame of its course: `azDeg` from straight behind round to its right-hand side,
 * `elDeg` above the local horizontal (raised where needed to stay off the ground), `dist` metres away. Leaves the
 * local up at the vehicle in `up`.
 */
function besideOffset(f: Focus, azDeg: number, elDeg: number, dist: number, out: V3): V3 {
  up.set(f.pos[0], f.pos[1], f.pos[2]);
  const r = up.length();
  up.divideScalar(r);
  fwd.set(f.course[0], f.course[1], f.course[2]);
  right.crossVectors(fwd, up);
  const az = (azDeg * Math.PI) / 180;
  const el = Math.max((elDeg * Math.PI) / 180, minElevation(r - EARTH_RADIUS, dist));
  const h = Math.cos(el) * dist;
  const back = -Math.cos(az) * h;
  const side = Math.sin(az) * h;
  const lift = Math.sin(el) * dist;
  out[0] = f.pos[0] + fwd.x * back + right.x * side + up.x * lift;
  out[1] = f.pos[1] + fwd.y * back + right.y * side + up.y * lift;
  out[2] = f.pos[2] + fwd.z * back + right.z * side + up.z * lift;
  return out;
}

export interface DragInput {
  dx: number;
  dy: number;
  button: number;
}

/** Zoom per pixel of wheel travel: each camera's distance scales by exp(delta * WHEEL_ZOOM). */
export const WHEEL_ZOOM = 0.0012;

// Every camera turns with the pointer, as if the scene were held: dragging right swings the view round to the
// left of what it looks at, dragging down raises it.

// ---------------------------------------------------------------- chase

/**
 * A three-quarter tracking view from the right, slightly ahead and below the vehicle. Looking up keeps the
 * ascent against the sky and reveals the hull as well as the exhaust. Near the ground, stay further round the
 * side so the launch tower does not obscure the stack. Both this transition and the ground-clearance limit
 * depend only on position, so seeking and reset always reproduce the same view.
 */
const CHASE_AZIMUTH = 120;
const CHASE_GROUND_AZIMUTH = 70;
const CHASE_ELEVATION = -12;

export class ChaseCamera {
  /** The viewer's turn round the vehicle away from the default side view, degrees. */
  azimuth = 0;
  /** Degrees above the vehicle's horizon. */
  elevation = CHASE_ELEVATION;
  zoom = 1;

  reset(): void {
    this.azimuth = 0;
    this.elevation = CHASE_ELEVATION;
    this.zoom = 1;
  }

  drag(d: DragInput): void {
    this.azimuth -= d.dx * 0.25;
    this.elevation = Math.min(80, Math.max(-60, this.elevation + d.dy * 0.2));
  }

  wheel(delta: number): void {
    this.zoom = Math.min(25, Math.max(0.25, this.zoom * Math.exp(delta * WHEEL_ZOOM)));
  }

  /**
   * A pure function of the focus, so a paused view settles at once and a seek lands on the final framing.
   * `reach` scales the distance: a frame with less free height (page controls over it) stands further back.
   */
  pose(f: Focus, out: CameraPose, reach = 1): CameraPose {
    const dist = f.size * 2.4 * this.zoom * reach + 20;
    const altitude = Math.hypot(f.pos[0], f.pos[1], f.pos[2]) - EARTH_RADIUS;
    const cleared = Math.max(0, Math.min(1, (altitude - 150) / 450));
    const turn = cleared * cleared * (3 - 2 * cleared);
    const azimuth = CHASE_GROUND_AZIMUTH + (CHASE_AZIMUTH - CHASE_GROUND_AZIMUTH) * turn;
    besideOffset(f, azimuth + this.azimuth, this.elevation, dist, out.pos);
    out.fov = 40;
    return lookAt(out, f.pos, up);
  }
}

// ----------------------------------------------------------------- free

const FREE_FOV = 45;

export class FreeCamera {
  azimuth = 215;
  elevation = 8;
  distance = 0;
  pan: V3 = [0, 0, 0];

  reset(): void {
    this.azimuth = 215;
    this.elevation = 8;
    this.distance = 0;
    this.pan = [0, 0, 0];
  }

  drag(d: DragInput, size: number): void {
    if (d.button === 2) {
      const scale = Math.max(this.distance, size * 2) * 0.0016;
      const az = (this.azimuth * Math.PI) / 180;
      // Pan in the local horizontal plane relative to the view direction, and vertically: the scene follows the
      // pointer both ways.
      this.pan[0] += Math.cos(az) * d.dx * scale;
      this.pan[1] -= Math.sin(az) * d.dx * scale;
      this.pan[2] += d.dy * scale;
      return;
    }
    this.azimuth += d.dx * 0.3;
    this.elevation = Math.min(89, Math.max(-89, this.elevation + d.dy * 0.25));
  }

  wheel(delta: number, size: number): void {
    const base = this.distance || size * 2.6 + 30;
    this.distance = Math.min(5e7, Math.max(size * 0.6 + 5, base * Math.exp(delta * WHEEL_ZOOM)));
  }

  recentre(): void {
    this.pan = [0, 0, 0];
  }

  /** Take over a view: orbit the focus from where it is seen now, at the distance that keeps its size on screen. */
  takeOver(p: CameraPose, f: Focus): void {
    enuAt(f.pos, east, north, up);
    tmp.set(p.pos[0] - f.pos[0], p.pos[1] - f.pos[1], p.pos[2] - f.pos[2]);
    const d = tmp.length();
    if (d < 1) return;
    this.azimuth = (Math.atan2(tmp.dot(east), tmp.dot(north)) * 180) / Math.PI;
    this.elevation = Math.min(89, Math.max(-89, (Math.asin(tmp.dot(up) / d) * 180) / Math.PI));
    this.pan = [0, 0, 0];
    const lens = Math.tan((p.fov * Math.PI) / 360) / Math.tan((FREE_FOV * Math.PI) / 360);
    this.distance = Math.min(5e7, Math.max(f.size * 0.6 + 5, d * lens));
  }

  pose(f: Focus, out: CameraPose): CameraPose {
    const dist = this.distance || f.size * 2.6 + 30;
    const target = offsetEnu(f.pos, this.pan[0], this.pan[1], this.pan[2], orbitTarget);
    orbitOffset(target, this.azimuth, this.elevation, dist, out.pos);
    enuAt(target, east, north, up);
    out.fov = FREE_FOV;
    return lookAt(out, target, up);
  }
}

// ---------------------------------------------------------------- globe

export class GlobeCamera {
  lon = 0;
  lat = 0;
  distance = EARTH_RADIUS * 2.7;
  tilt = 0;
  /** Centred for this visit to the globe. */
  private centred = false;
  /** The viewer has turned or zoomed it: coming back to the globe keeps their view. */
  private moved = false;

  reset(): void {
    this.centred = false;
    this.moved = false;
    this.distance = EARTH_RADIUS * 2.7;
    this.tilt = 0;
  }

  /** The globe view is shown again: centre it afresh on what is followed, unless the viewer has turned it. */
  enter(): void {
    if (!this.moved) this.centred = false;
  }

  /** Centre the view over an ECEF point, once per visit (see enter()). */
  centreOn(p: V3): void {
    if (this.centred) return;
    const r = Math.hypot(p[0], p[1], p[2]);
    this.lat = (Math.asin(p[2] / r) * 180) / Math.PI - 8;
    this.lon = (Math.atan2(p[1], p[0]) * 180) / Math.PI + 25;
    this.centred = true;
  }

  drag(d: DragInput): void {
    this.moved = true;
    const k = (this.distance / EARTH_RADIUS - 1) * 0.12 + 0.02;
    if (d.button === 2) {
      this.tilt = Math.min(70, Math.max(0, this.tilt + d.dy * 0.2));
      return;
    }
    this.lon -= d.dx * k;
    this.lat = Math.min(85, Math.max(-85, this.lat + d.dy * k));
  }

  wheel(delta: number): void {
    this.moved = true;
    const alt = this.distance - EARTH_RADIUS;
    this.distance = EARTH_RADIUS + Math.min(EARTH_RADIUS * 9, Math.max(250_000, alt * Math.exp(delta * WHEEL_ZOOM)));
  }

  pose(out: CameraPose): CameraPose {
    const lat = (this.lat * Math.PI) / 180;
    const lon = (this.lon * Math.PI) / 180;
    const sx = Math.cos(lat) * Math.cos(lon);
    const sy = Math.cos(lat) * Math.sin(lon);
    const sz = Math.sin(lat);
    if (this.tilt > 0) {
      // Tilt: move the eye south of the look point and aim at the surface below it.
      const tiltRad = (this.tilt * Math.PI) / 180;
      const alt = this.distance - EARTH_RADIUS;
      globeLook[0] = sx * EARTH_RADIUS;
      globeLook[1] = sy * EARTH_RADIUS;
      globeLook[2] = sz * EARTH_RADIUS;
      enuAt(globeLook, east, north, up);
      const back = Math.sin(tiltRad) * alt;
      const height = Math.cos(tiltRad) * alt;
      out.pos[0] = globeLook[0] - north.x * back + up.x * height;
      out.pos[1] = globeLook[1] - north.y * back + up.y * height;
      out.pos[2] = globeLook[2] - north.z * back + up.z * height;
    } else {
      globeLook[0] = 0;
      globeLook[1] = 0;
      globeLook[2] = 0;
      out.pos[0] = sx * this.distance;
      out.pos[1] = sy * this.distance;
      out.pos[2] = sz * this.distance;
    }
    up.set(0, 0, 1);
    out.fov = 38;
    return lookAt(out, globeLook, up);
  }
}

// ---------------------------------------------------------- fixed ground

/** A camera at a fixed ECEF point that tracks a target, auto-zooming to keep it framed. */
export function trackerPose(site: V3, f: Focus, fill: number, minFov: number, maxFov: number, out: CameraPose): CameraPose {
  copy3(site, out.pos);
  const d = dist3(site, f.pos);
  out.fov = fitFov(f.size, d, fill, minFov, maxFov);
  enuAt(site, east, north, up);
  return lookAt(out, f.pos, up);
}

/**
 * A camera flying alongside a vehicle with a long lens (a tracking aircraft): `dist` m away, `azDeg` from straight
 * behind round to its right-hand side and `elDeg` above its horizon, zoomed so it fills `fill` of the frame height.
 */
export function alongsidePose(f: Focus, azDeg: number, elDeg: number, dist: number, fill: number, minFov: number, maxFov: number, out: CameraPose): CameraPose {
  besideOffset(f, azDeg, elDeg, dist, out.pos);
  out.fov = fitFov(f.size, dist, fill, minFov, maxFov);
  return lookAt(out, f.pos, up);
}

const fitInv = new THREE.Quaternion();

/**
 * Zoom a pose (its position and direction kept) so that every point (ECEF) lies within `fillY` of the free band of
 * the frame (`band`, a share of its height, centred on the view direction) and within `fillX` of its width.
 * `aspect` is the frame's width over its height.
 */
export function fitPoints(pose: CameraPose, points: readonly V3[], fillY: number, fillX: number, band: number, aspect: number, minFov: number, maxFov: number): CameraPose {
  fitInv.copy(pose.quat).invert();
  let k = 0;
  for (const p of points) {
    tmp.set(p[0] - pose.pos[0], p[1] - pose.pos[1], p[2] - pose.pos[2]).applyQuaternion(fitInv);
    const depth = Math.max(1, -tmp.z);
    k = Math.max(k, Math.abs(tmp.y) / depth / (fillY * band), Math.abs(tmp.x) / depth / (fillX * aspect));
  }
  pose.fov = Math.min(maxFov, Math.max(minFov, (2 * Math.atan(k) * 180) / Math.PI));
  return pose;
}

/** A camera fixed to a vehicle: `local` offset and `dir` view direction in the body frame, `upLocal` body-frame up. */
export function onboardPose(base: V3, quat: THREE.Quaternion, local: THREE.Vector3, dir: THREE.Vector3, upLocal: THREE.Vector3, fov: number, out: CameraPose): CameraPose {
  tmp.copy(local).applyQuaternion(quat);
  out.pos[0] = base[0] + tmp.x;
  out.pos[1] = base[1] + tmp.y;
  out.pos[2] = base[2] + tmp.z;
  tmp.copy(dir).applyQuaternion(quat);
  tmp2.copy(upLocal).applyQuaternion(quat);
  m4.lookAt(vZero, tmp, tmp2);
  out.quat.setFromRotationMatrix(m4);
  out.fov = fov;
  return out;
}

// --------------------------------------------------------------- blends

/** Smoothstep ease of a blend's progress. */
function ease(f: number): number {
  return f * f * (3 - 2 * f);
}

/**
 * Ease between two nearby poses (position in float64, slerped orientation). Views of a moving vehicle are blended
 * with `a` carried along with it (see the stage), so the camera never falls behind.
 */
export function blendPose(a: CameraPose, b: CameraPose, f: number, out: CameraPose): CameraPose {
  const e = ease(f);
  for (let k = 0; k < 3; k++) out.pos[k] = a.pos[k] + (b.pos[k] - a.pos[k]) * e;
  out.quat.slerpQuaternions(a.quat, b.quat, e);
  out.fov = a.fov + (b.fov - a.fov) * e;
  return out;
}

const dirA = new THREE.Vector3();
const dirB = new THREE.Vector3();
const swing = new THREE.Quaternion();
const noSwing = new THREE.Quaternion();

/**
 * Ease between two poses far apart round the Earth (into or out of the globe view): the camera swings round the
 * Earth's centre instead of cutting through the planet, and climbs or descends evenly in log altitude.
 */
export function blendAround(a: CameraPose, b: CameraPose, f: number, out: CameraPose): CameraPose {
  const e = ease(f);
  dirA.set(a.pos[0], a.pos[1], a.pos[2]);
  dirB.set(b.pos[0], b.pos[1], b.pos[2]);
  const altA = Math.max(1, dirA.length() - EARTH_RADIUS);
  const altB = Math.max(1, dirB.length() - EARTH_RADIUS);
  dirA.normalize();
  dirB.normalize();
  swing.setFromUnitVectors(dirA, dirB);
  dirA.applyQuaternion(noSwing.identity().slerp(swing, e));
  const r = EARTH_RADIUS + Math.exp(Math.log(altA) + (Math.log(altB) - Math.log(altA)) * e);
  out.pos[0] = dirA.x * r;
  out.pos[1] = dirA.y * r;
  out.pos[2] = dirA.z * r;
  out.quat.slerpQuaternions(a.quat, b.quat, e);
  out.fov = a.fov + (b.fov - a.fov) * e;
  return out;
}
