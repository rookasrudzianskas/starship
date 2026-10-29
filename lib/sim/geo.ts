import { EARTH_OMEGA, EARTH_RADIUS } from './types';
import type { V3, Vec3Like } from './vec';

/** Geodetic helpers on the simulator's spherical Earth. Angles in degrees, distances in metres. */

export interface LatLonAlt {
  lat: number;
  lon: number;
  alt: number;
}

export interface EnuBasis {
  east: [number, number, number];
  north: [number, number, number];
  up: [number, number, number];
}

const D2R = Math.PI / 180;
const OMEGA = EARTH_OMEGA;
const R2D = 180 / Math.PI;

export function latLonAltToEcef(lat: number, lon: number, alt = 0): [number, number, number] {
  const r = EARTH_RADIUS + alt;
  const cl = Math.cos(lat * D2R);
  return [r * cl * Math.cos(lon * D2R), r * cl * Math.sin(lon * D2R), r * Math.sin(lat * D2R)];
}

export function ecefToLatLonAlt(p: Vec3Like): LatLonAlt;
export function ecefToLatLonAlt(x: number, y: number, z: number): LatLonAlt;
export function ecefToLatLonAlt(a: Vec3Like | number, b?: number, c?: number): LatLonAlt {
  let x: number, y: number, z: number;
  if (typeof a === 'number') {
    x = a;
    y = b ?? 0;
    z = c ?? 0;
  } else if ('x' in a) {
    x = a.x;
    y = a.y;
    z = a.z;
  } else {
    x = a[0];
    y = a[1];
    z = a[2];
  }
  const rxy = Math.hypot(x, y);
  return { lat: Math.atan2(z, rxy) * R2D, lon: Math.atan2(y, x) * R2D, alt: Math.hypot(rxy, z) - EARTH_RADIUS };
}

export function localEnuBasis(lat: number, lon: number): EnuBasis {
  const sl = Math.sin(lat * D2R), cl = Math.cos(lat * D2R);
  const so = Math.sin(lon * D2R), co = Math.cos(lon * D2R);
  return {
    east: [-so, co, 0],
    north: [-sl * co, -sl * so, cl],
    up: [cl * co, cl * so, sl],
  };
}

/** Great-circle distance between two ECEF points projected onto the sphere, m. */
export function surfaceDistance(a: V3, b: V3): number {
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return EARTH_RADIUS * Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
}

/** Local east/north/up unit vectors at a position (any frame sharing the polar axis with ECEF). */
export function enuAt(r: V3, east: V3, north: V3, up: V3): void {
  const l = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  up[0] = r[0] / l;
  up[1] = r[1] / l;
  up[2] = r[2] / l;
  const h = Math.sqrt(up[0] * up[0] + up[1] * up[1]);
  if (h < 1e-9) {
    // At a pole: pick +Y as east.
    east[0] = 0;
    east[1] = 1;
    east[2] = 0;
  } else {
    east[0] = -up[1] / h;
    east[1] = up[0] / h;
    east[2] = 0;
  }
  north[0] = up[1] * east[2] - up[2] * east[1];
  north[1] = up[2] * east[0] - up[0] * east[2];
  north[2] = up[0] * east[1] - up[1] * east[0];
}

/** Rotates an inertial vector into ECEF at time t (inertial frame = ECEF at T+0). */
export function inertialToEcef(out: V3, a: V3, t: number): V3 {
  const th = OMEGA * t;
  const c = Math.cos(th), s = Math.sin(th);
  const x = c * a[0] + s * a[1];
  const y = -s * a[0] + c * a[1];
  out[0] = x;
  out[1] = y;
  out[2] = a[2];
  return out;
}

/** Rotates an ECEF vector into the inertial frame at time t. */
export function ecefToInertial(out: V3, a: V3, t: number): V3 {
  const th = OMEGA * t;
  const c = Math.cos(th), s = Math.sin(th);
  const x = c * a[0] - s * a[1];
  const y = s * a[0] + c * a[1];
  out[0] = x;
  out[1] = y;
  out[2] = a[2];
  return out;
}
