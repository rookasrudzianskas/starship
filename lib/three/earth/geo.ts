import * as THREE from 'three';
import { EARTH_RADIUS } from '@/lib/sim/types';
import type { Vec3d } from '@/lib/three/contracts';

const DEG = Math.PI / 180;

/**
 * Latitude/longitude (degrees) and altitude above the sphere (m) to ECEF metres on the spherical Earth
 * (radius EARTH_RADIUS; +X lat 0/lon 0, +Y lat 0/lon 90° E, +Z north pole).
 */
export function latLonToEcef(latDeg: number, lonDeg: number, altM = 0): Vec3d {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const r = EARTH_RADIUS + altM;
  const c = Math.cos(lat);
  return [r * c * Math.cos(lon), r * c * Math.sin(lon), r * Math.sin(lat)];
}

/** ECEF metres to [latitude°, longitude°, altitude above the sphere in m]. */
export function ecefToLatLon(ecef: ArrayLike<number>): [number, number, number] {
  const x = ecef[0];
  const y = ecef[1];
  const z = ecef[2];
  const p = Math.hypot(x, y);
  return [Math.atan2(z, p) / DEG, Math.atan2(y, x) / DEG, Math.hypot(p, z) - EARTH_RADIUS];
}

/** Local east, north and up unit vectors (ECEF) at a latitude/longitude. */
export function enuBasis(latDeg: number, lonDeg: number): { east: Vec3d; north: Vec3d; up: Vec3d } {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return {
    east: [-so, co, 0],
    north: [-sl * co, -sl * so, cl],
    up: [cl * co, cl * so, sl],
  };
}

/** Rotation taking local ENU coordinates (x east, y north, z up) to ECEF axes. */
export function enuToEcefRotation(latDeg: number, lonDeg: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const { east, north, up } = enuBasis(latDeg, lonDeg);
  return out.set(
    east[0], north[0], up[0], 0,
    east[1], north[1], up[1], 0,
    east[2], north[2], up[2], 0,
    0, 0, 0, 1,
  );
}

/** EPSG:3857 spherical Web Mercator (R = 6378137 m), as used by the ground patch textures. */
export const WEB_MERCATOR_RADIUS = 6378137;
export function mercatorX(lonDeg: number): number {
  return WEB_MERCATOR_RADIUS * lonDeg * DEG;
}
export function mercatorY(latDeg: number): number {
  return WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG) / 2));
}
