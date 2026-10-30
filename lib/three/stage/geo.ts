import * as THREE from 'three';
// Relative so the cameras can be unit tested (vitest has no @/ alias).
import { EARTH_RADIUS } from '../../sim/types';

export type V3 = [number, number, number];

const D2R = Math.PI / 180;

export function latLonToEcef(latDeg: number, lonDeg: number, alt: number, out: V3 = [0, 0, 0]): V3 {
  const lat = latDeg * D2R;
  const lon = lonDeg * D2R;
  const r = EARTH_RADIUS + alt;
  out[0] = r * Math.cos(lat) * Math.cos(lon);
  out[1] = r * Math.cos(lat) * Math.sin(lon);
  out[2] = r * Math.sin(lat);
  return out;
}

/** Local east/north/up unit vectors at an ECEF position (spherical Earth). */
export function enuAt(p: V3, east: THREE.Vector3, north: THREE.Vector3, up: THREE.Vector3): void {
  up.set(p[0], p[1], p[2]).normalize();
  east.set(-up.y, up.x, 0);
  if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
  east.normalize();
  north.crossVectors(up, east).normalize();
}

// Scratch for the helpers below, which run several times per frame.
const sEast = new THREE.Vector3();
const sNorth = new THREE.Vector3();
const sUp = new THREE.Vector3();
const sBasis = new THREE.Matrix4();

/** Rotation that maps a local frame (+X east, +Y up, +Z south; right-handed) to ECEF at p. */
export function enuQuaternion(p: V3, out: THREE.Quaternion): THREE.Quaternion {
  enuAt(p, sEast, sNorth, sUp);
  sBasis.makeBasis(sEast, sUp, sNorth.negate());
  return out.setFromRotationMatrix(sBasis);
}

/** p + east*e + north*n + up*u, in ECEF. `out` may be `p`. */
export function offsetEnu(p: V3, e: number, n: number, u: number, out: V3): V3 {
  enuAt(p, sEast, sNorth, sUp);
  const x = p[0] + sEast.x * e + sNorth.x * n + sUp.x * u;
  const y = p[1] + sEast.y * e + sNorth.y * n + sUp.y * u;
  const z = p[2] + sEast.z * e + sNorth.z * n + sUp.z * u;
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function dist3(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function copy3(a: V3, out: V3): V3 {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

/** Writes (a - origin) into a float32 vector: the camera-relative position used for rendering. */
export function relative(a: V3, origin: V3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(a[0] - origin[0], a[1] - origin[1], a[2] - origin[2]);
}

export function lerp3(a: V3, b: V3, f: number, out: V3): V3 {
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
  return out;
}

/** Exponential smoothing factor for a time constant (seconds). */
export function damp(tau: number, dt: number): number {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}
