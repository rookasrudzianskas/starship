import * as THREE from 'three';
import { EARTH_RADIUS } from '@/lib/sim/types';

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

/** Rotation that maps a local frame (+X east, +Y up, +Z south; right-handed) to ECEF at p. */
export function enuQuaternion(p: V3, out: THREE.Quaternion): THREE.Quaternion {
  const e = new THREE.Vector3();
  const n = new THREE.Vector3();
  const u = new THREE.Vector3();
  enuAt(p, e, n, u);
  const m = new THREE.Matrix4().makeBasis(e, u, n.negate());
  return out.setFromRotationMatrix(m);
}

/** p + east*e + north*n + up*u, in ECEF. */
export function offsetEnu(p: V3, e: number, n: number, u: number, out: V3): V3 {
  const east = new THREE.Vector3();
  const north = new THREE.Vector3();
  const up = new THREE.Vector3();
  enuAt(p, east, north, up);
  out[0] = p[0] + east.x * e + north.x * n + up.x * u;
  out[1] = p[1] + east.y * e + north.y * n + up.y * u;
  out[2] = p[2] + east.z * e + north.z * n + up.z * u;
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
