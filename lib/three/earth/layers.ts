import * as THREE from 'three';
import { EARTH_RADIUS } from '@/lib/sim/types';
import { ecefToLatLon, enuBasis, latLonToEcef, mercatorX, mercatorY } from './geo';
import type { PatchId, PatchManifest } from './imagery';
import { fullscreenTriangle } from './passes';
import {
  GLOBE_FRAGMENT,
  GLOBE_VERTEX,
  PATCH_FRAGMENT,
  PATCH_VERTEX,
  STARS_FRAGMENT,
  STARS_VERTEX,
} from './shaders/scene';
import type { SharedUniforms } from './uniforms';

/** Render order: globe/sky first among opaques; the stars first among transparents. */
export const GLOBE_RENDER_ORDER = -1000;

// ---------------------------------------------------------------------------------------------------------
// Globe + sky (full-screen)
// ---------------------------------------------------------------------------------------------------------

export function createGlobeMesh(shared: SharedUniforms) {
  const uniforms = {
    ...shared,
    uPatchDiscard: { value: new THREE.Vector4(0, 0, 0, -1) },
    uPatchBiasRadius: { value: -1 },
    uSunTransmittanceCam: { value: new THREE.Vector3(1, 1, 1) },
  };
  const material = new THREE.ShaderMaterial({
    name: 'EarthGlobeSky',
    vertexShader: GLOBE_VERTEX,
    fragmentShader: GLOBE_FRAGMENT,
    uniforms,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.LessEqualDepth,
  });
  const mesh = new THREE.Mesh(fullscreenTriangle(), material);
  mesh.name = 'earth-globe-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = GLOBE_RENDER_ORDER;
  return { mesh, uniforms };
}

// ---------------------------------------------------------------------------------------------------------
// Starbase ground patch
// ---------------------------------------------------------------------------------------------------------

export interface PatchLayout {
  /** Disc radius of the mesh (m of arc on the sphere). */
  radius: number;
  /** The wide imagery fades into Blue Marble between these arc distances (m). */
  fadeStart: number;
  fadeEnd: number;
  /** The globe pass skips pixels closer than this to the pad (the patch draws them). */
  discardRadius: number;
  /**
   * Between discardRadius and this, the globe still draws but pushes its depth back, so the patch wins wherever
   * it exists while grazing views of the patch's edge (seen past the curvature) cannot leave holes.
   */
  biasRadius: number;
}

export const PATCH_LAYOUT: PatchLayout = {
  radius: 340_000,
  fadeStart: 270_000,
  fadeEnd: 320_000,
  discardRadius: 332_000,
  biasRadius: 345_000,
};

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Radial mesh centred on the pad: ring radii grow geometrically (≈ 3 m to 340 km), so vertices are dense where
 * the camera can get close. Positions are local ENU metres relative to the pad's sea-level point, curved onto the
 * sphere; every per-vertex coordinate (Blue Marble and Mercator UVs) is computed in float64 here.
 */
export function buildPatchGeometry(
  padLat: number,
  padLon: number,
  groundAlt: number,
  patches: PatchManifest[],
  layout: PatchLayout,
  segments = 192,
): THREE.BufferGeometry {
  const R = EARTH_RADIUS;
  // Ring radii: geometric (×1.1 per ring) from 3 m, with spacing capped at 6 km so the flat triangles stay within
  // ~1 m of the sphere far out, where the camera sees them at grazing angles.
  const radii: number[] = [];
  for (let s = 3; s < layout.radius; s += Math.min(s * 0.1, 6000)) radii.push(s);
  radii.push(layout.radius);
  const rings = radii.length;
  const n = 1 + rings * segments;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uvGlobe = new Float32Array(n * 2);
  const uvs: Record<PatchId, Float32Array> = {
    pad: new Float32Array(n * 2).fill(-1),
    mid: new Float32Array(n * 2).fill(-1),
    wide: new Float32Array(n * 2).fill(-1),
  };
  const arc = new Float32Array(n);
  const { east, north, up } = enuBasis(padLat, padLon);
  const origin = latLonToEcef(padLat, padLon, 0);
  const ecef: [number, number, number] = [0, 0, 0];

  // Longest triangle edge around each ring; vertices are lifted by the sag of such flat facets below the sphere
  // (≈ L²/6R), so the mesh lies on or just above the sphere and covers every pixel the globe pass leaves to it.
  const edge = (i: number) =>
    Math.max(radii[Math.min(i + 1, rings - 1)] - radii[i], i > 0 ? radii[i] - radii[i - 1] : 0, (2 * Math.PI * radii[i]) / segments);
  let ringIndex = 0;

  const write = (k: number, s: number, alpha: number) => {
    const th = s / R;
    const st = Math.sin(th);
    const sa = Math.sin(alpha);
    const ca = Math.cos(alpha);
    // Ground height: the pad apron sits at groundAlt, easing to sea level over a few km.
    const L = s > 0 ? edge(ringIndex) : 0;
    const hgt = groundAlt * (1 - smooth(1500, 4000, s)) + (1.3 * L * L) / (6 * R);
    const nx = st * sa;
    const ny = st * ca;
    const nz = Math.cos(th);
    const x = R * st * sa + hgt * nx;
    const y = R * st * ca + hgt * ny;
    const z = -2 * R * Math.sin(th / 2) ** 2 + hgt * nz;
    pos[k * 3] = x;
    pos[k * 3 + 1] = y;
    pos[k * 3 + 2] = z;
    nrm[k * 3] = nx;
    nrm[k * 3 + 1] = ny;
    nrm[k * 3 + 2] = nz;
    for (let c = 0; c < 3; c++) ecef[c] = origin[c] + east[c] * x + north[c] * y + up[c] * z;
    const [lat, lon] = ecefToLatLon(ecef);
    uvGlobe[k * 2] = lon / 360 + 0.5;
    uvGlobe[k * 2 + 1] = 0.5 - lat / 180;
    const mx = mercatorX(lon);
    const my = mercatorY(lat);
    for (const p of patches) {
      const m = p.mercator;
      uvs[p.id][k * 2] = (mx - m.xmin) / (m.xmax - m.xmin);
      uvs[p.id][k * 2 + 1] = (m.ymax - my) / (m.ymax - m.ymin);
    }
    arc[k] = s;
  };

  write(0, 0, 0);
  for (let i = 0; i < rings; i++) {
    ringIndex = i;
    for (let j = 0; j < segments; j++) write(1 + i * segments + j, radii[i], (j / segments) * Math.PI * 2);
  }

  // Counter-clockwise seen from above (azimuth runs clockwise from north).
  const index: number[] = [];
  for (let j = 0; j < segments; j++) index.push(0, 1 + ((j + 1) % segments), 1 + j);
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = 1 + i * segments + j;
      const b = 1 + i * segments + ((j + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      index.push(a, b, d, a, d, c);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uvGlobe', new THREE.BufferAttribute(uvGlobe, 2));
  g.setAttribute('uvPad', new THREE.BufferAttribute(uvs.pad, 2));
  g.setAttribute('uvMid', new THREE.BufferAttribute(uvs.mid, 2));
  g.setAttribute('uvWide', new THREE.BufferAttribute(uvs.wide, 2));
  g.setAttribute('arcDist', new THREE.BufferAttribute(arc, 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

export function createPatchMaterial(shared: SharedUniforms, placeholder: THREE.Texture) {
  const uniforms = {
    ...shared,
    uPatchPad: { value: placeholder as THREE.Texture },
    uPatchMid: { value: placeholder as THREE.Texture },
    uPatchWide: { value: placeholder as THREE.Texture },
    uPatchWater: { value: placeholder as THREE.Texture },
    uPatchParams: { value: new THREE.Vector4(1, PATCH_LAYOUT.fadeStart, PATCH_LAYOUT.fadeEnd, 0) },
  };
  const material = new THREE.ShaderMaterial({
    name: 'EarthGroundPatch',
    vertexShader: PATCH_VERTEX,
    fragmentShader: PATCH_FRAGMENT,
    uniforms,
  });
  return { material, uniforms };
}

// ---------------------------------------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Galactic → equatorial (J2000) rotation (transpose of the IAU equatorial → galactic matrix). */
const GAL_TO_EQ = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
];

/** Relative linear RGB of a black body at temperature T (Planck's law at 610 / 550 / 465 nm), max = 1. */
function blackbodyRgb(T: number): [number, number, number] {
  const planck = (nm: number) => {
    const l = nm * 1e-9;
    return 1 / (Math.pow(l, 5) * (Math.exp(0.014387769 / (l * T)) - 1));
  };
  const c = [planck(610), planck(550), planck(465)];
  const m = Math.max(c[0], c[1], c[2]);
  return [c[0] / m, c[1] / m, c[2] / m];
}

/**
 * A procedural star field with realistic counts per magnitude (log10 N(<m) ≈ 0.49 m + 0.75, so ~6000 stars to
 * m ≈ 6.2), colours from a B−V distribution and a concentration of faint stars towards the galactic plane.
 */
export function createStars(shared: SharedUniforms, count = 6000) {
  const rand = rng(20231118);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // Inverse of the cumulative count: the i-th brightest star has N(<m) = i (+ jitter); m ≥ −1.5.
    const m = (Math.log10(Math.max(i + rand(), 1)) - 0.75) / 0.49;
    // Direction: uniform, or (fainter stars, 35 %) near the galactic plane.
    let x: number;
    let y: number;
    let z: number;
    if (m > 3.5 && rand() < 0.35) {
      const l = rand() * Math.PI * 2;
      const b = Math.max(-1.4, Math.min(1.4, gauss() * 0.16));
      const g = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
      x = GAL_TO_EQ[0][0] * g[0] + GAL_TO_EQ[0][1] * g[1] + GAL_TO_EQ[0][2] * g[2];
      y = GAL_TO_EQ[1][0] * g[0] + GAL_TO_EQ[1][1] * g[1] + GAL_TO_EQ[1][2] * g[2];
      z = GAL_TO_EQ[2][0] * g[0] + GAL_TO_EQ[2][1] * g[1] + GAL_TO_EQ[2][2] * g[2];
    } else {
      z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      x = s * Math.cos(a);
      y = s * Math.sin(a);
    }
    pos.set([x, y, z], i * 3);
    // Colour: B−V ≈ N(0.65, 0.42), temperature from Ballesteros' formula, desaturated a little (eye/camera).
    const bv = Math.max(-0.3, Math.min(1.9, 0.65 + 0.42 * gauss()));
    const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
    const rgb = blackbodyRgb(T);
    // Displayed brightness compresses the 2.5 log scale (exponent 0.55) so faint stars stay visible.
    const brightness = Math.pow(10, -0.4 * 0.55 * (m - 0.5));
    const size = 1.6 + 2.2 * Math.min(Math.max((3 - m) / 4.5, 0), 1);
    for (let c = 0; c < 3; c++) col[i * 4 + c] = (0.55 + 0.45 * rgb[c]) * brightness;
    col[i * 4 + 3] = size;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('starColour', new THREE.BufferAttribute(col, 4));
  const uniforms = {
    ...shared,
    uStarRotation: { value: new THREE.Matrix3() },
    // x: brightness, y: pixel ratio, z/w: fade as the sky luminance behind the star rises (scene units)
    uStarParams: { value: new THREE.Vector4(1, 1, 0.004, 0.06) },
  };
  const material = new THREE.ShaderMaterial({
    name: 'EarthStars',
    vertexShader: STARS_VERTEX,
    fragmentShader: STARS_FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'earth-stars';
  points.frustumCulled = false;
  points.renderOrder = GLOBE_RENDER_ORDER;
  return { points, uniforms };
}
