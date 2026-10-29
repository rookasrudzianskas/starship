import * as THREE from 'three';
import { EARTH_RADIUS } from '@/lib/sim/types';
import { copy3, damp, dist3, enuAt, offsetEnu, type V3 } from './geo';

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
  vel: V3;
  quat: THREE.Quaternion;
  /** Length of the thing being framed, m. */
  size: number;
}

const east = new THREE.Vector3();
const north = new THREE.Vector3();
const up = new THREE.Vector3();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

/** Orbit-style offset in the target's local east/north/up frame. */
function orbitOffset(target: V3, azDeg: number, elDeg: number, dist: number, out: V3): V3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const e = Math.sin(az) * Math.cos(el) * dist;
  const n = Math.cos(az) * Math.cos(el) * dist;
  const u = Math.sin(el) * dist;
  return offsetEnu(target, e, n, u, out);
}

export interface DragInput {
  dx: number;
  dy: number;
  button: number;
}

// ---------------------------------------------------------------- chase

export class ChaseCamera {
  azimuth = 0;
  elevation = 12;
  zoom = 1;
  private smoothedBack = new THREE.Vector3();
  private initialised = false;

  reset(): void {
    this.azimuth = 0;
    this.elevation = 12;
    this.zoom = 1;
    this.initialised = false;
  }

  drag(d: DragInput): void {
    this.azimuth -= d.dx * 0.25;
    this.elevation = Math.min(80, Math.max(-60, this.elevation + d.dy * 0.2));
  }

  wheel(delta: number): void {
    this.zoom = Math.min(25, Math.max(0.25, this.zoom * Math.exp(delta * 0.0012)));
  }

  pose(f: Focus, dt: number, out: CameraPose): CameraPose {
    enuAt(f.pos, east, north, up);
    // "Behind" = against the direction of travel; on the pad, look from the south-west.
    tmp.set(f.vel[0], f.vel[1], f.vel[2]);
    if (tmp.lengthSq() < 25) tmp.copy(north).multiplyScalar(0.6).add(tmp2.copy(east).multiplyScalar(0.8));
    tmp.normalize().negate();
    if (!this.initialised || dt > 0.5) {
      this.smoothedBack.copy(tmp);
      this.initialised = true;
    } else {
      this.smoothedBack.lerp(tmp, damp(0.6, dt)).normalize();
    }
    // Rotate the back vector by the user's azimuth/elevation around local up / the side axis.
    const back = tmp.copy(this.smoothedBack);
    back.applyAxisAngle(up, (this.azimuth * Math.PI) / 180);
    const side = tmp2.crossVectors(back, up);
    if (side.lengthSq() > 1e-8) back.applyAxisAngle(side.normalize(), (this.elevation * Math.PI) / 180);
    const dist = f.size * 2.4 * this.zoom + 20;
    out.pos[0] = f.pos[0] + back.x * dist;
    out.pos[1] = f.pos[1] + back.y * dist;
    out.pos[2] = f.pos[2] + back.z * dist;
    out.fov = 40;
    return lookAt(out, f.pos, up);
  }
}

// ----------------------------------------------------------------- free

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
      // Pan in the local horizontal plane relative to the view direction, and vertically.
      this.pan[0] -= (Math.cos(az) * d.dx) * scale;
      this.pan[1] += (Math.sin(az) * d.dx) * scale;
      this.pan[2] += d.dy * scale;
      return;
    }
    this.azimuth -= d.dx * 0.3;
    this.elevation = Math.min(89, Math.max(-89, this.elevation + d.dy * 0.25));
  }

  wheel(delta: number, size: number): void {
    const base = this.distance || size * 2.6 + 30;
    this.distance = Math.min(5e7, Math.max(size * 0.6 + 5, base * Math.exp(delta * 0.0012)));
  }

  recentre(): void {
    this.pan = [0, 0, 0];
  }

  pose(f: Focus, out: CameraPose): CameraPose {
    const dist = this.distance || f.size * 2.6 + 30;
    const target: V3 = offsetEnu(f.pos, this.pan[0], this.pan[1], this.pan[2], [0, 0, 0]);
    orbitOffset(target, this.azimuth, this.elevation, dist, out.pos);
    enuAt(target, east, north, up);
    out.fov = 45;
    return lookAt(out, target, up);
  }
}

// ---------------------------------------------------------------- globe

export class GlobeCamera {
  lon = 0;
  lat = 0;
  distance = EARTH_RADIUS * 2.7;
  tilt = 0;
  private centred = false;

  reset(): void {
    this.centred = false;
    this.distance = EARTH_RADIUS * 2.7;
    this.tilt = 0;
  }

  /** Centre the view over an ECEF point the first time the globe is shown. */
  centreOn(p: V3): void {
    if (this.centred) return;
    const r = Math.hypot(p[0], p[1], p[2]);
    this.lat = (Math.asin(p[2] / r) * 180) / Math.PI - 8;
    this.lon = (Math.atan2(p[1], p[0]) * 180) / Math.PI + 25;
    this.centred = true;
  }

  drag(d: DragInput): void {
    const k = (this.distance / EARTH_RADIUS - 1) * 0.12 + 0.02;
    if (d.button === 2) {
      this.tilt = Math.min(70, Math.max(0, this.tilt + d.dy * 0.2));
      return;
    }
    this.lon -= d.dx * k;
    this.lat = Math.min(85, Math.max(-85, this.lat + d.dy * k));
  }

  wheel(delta: number): void {
    const alt = this.distance - EARTH_RADIUS;
    this.distance = EARTH_RADIUS + Math.min(EARTH_RADIUS * 9, Math.max(250_000, alt * Math.exp(delta * 0.0012)));
  }

  pose(out: CameraPose): CameraPose {
    const lat = (this.lat * Math.PI) / 180;
    const lon = (this.lon * Math.PI) / 180;
    const center: V3 = [0, 0, 0];
    const surface: V3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    // Tilt: move the eye south of the look point and aim at a point above the surface.
    const tiltRad = (this.tilt * Math.PI) / 180;
    const alt = this.distance - EARTH_RADIUS;
    const look: V3 = this.tilt > 0 ? [surface[0] * EARTH_RADIUS, surface[1] * EARTH_RADIUS, surface[2] * EARTH_RADIUS] : center;
    if (this.tilt > 0) {
      enuAt(look, east, north, up);
      const back = Math.sin(tiltRad) * alt;
      const height = Math.cos(tiltRad) * alt;
      out.pos[0] = look[0] - north.x * back + up.x * height;
      out.pos[1] = look[1] - north.y * back + up.y * height;
      out.pos[2] = look[2] - north.z * back + up.z * height;
    } else {
      out.pos[0] = surface[0] * this.distance;
      out.pos[1] = surface[1] * this.distance;
      out.pos[2] = surface[2] * this.distance;
    }
    up.set(0, 0, 1);
    out.fov = 38;
    return lookAt(out, look, up);
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

/** Ease between two poses (position in float64, slerped orientation). */
export function blendPose(a: CameraPose, b: CameraPose, f: number, out: CameraPose): CameraPose {
  const e = f * f * (3 - 2 * f);
  for (let k = 0; k < 3; k++) out.pos[k] = a.pos[k] + (b.pos[k] - a.pos[k]) * e;
  out.quat.slerpQuaternions(a.quat, b.quat, e);
  out.fov = a.fov + (b.fov - a.fov) * e;
  return out;
}
