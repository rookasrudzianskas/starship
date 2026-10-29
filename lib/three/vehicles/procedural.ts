import * as THREE from 'three';

/**
 * Small procedural toolkit shared by the vehicle, pad and effects modules: deterministic hashing and
 * random numbers, tileable value noise, canvas/data texture helpers and a reference-counted cache so
 * generated textures (and other heavy resources) are built once and shared by every instance.
 * Nothing here touches the DOM at import time, so it is safe to import from server components.
 */

// ---------------------------------------------------------------------------
// Hashing and random numbers
// ---------------------------------------------------------------------------

/** Integer hash of up to three integers, returned as a float in [0, 1). */
export function hash3i(x: number, y: number, z = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x2f2b4f8d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Deterministic PRNG (32-bit state, xorshift-multiply mix). Returns floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let s = (seed | 0) ^ 0x5bd1e995;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Tileable value noise
// ---------------------------------------------------------------------------

/**
 * 2D value noise that tiles with period (px, py) lattice cells. Smoothstep interpolation, range [0, 1].
 */
export function tileNoise(x: number, y: number, px: number, py: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % px) + px) % px;
  const y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = hash3i(x0, y0, seed);
  const b = hash3i(x1, y0, seed);
  const c = hash3i(x0, y1, seed);
  const d = hash3i(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal sum of tileNoise octaves; tiles with the base period (px, py). Range about [0, 1]. */
export function tileFbm(x: number, y: number, px: number, py: number, octaves: number, seed = 0, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(x * f, y * f, px * f, py * f, seed + o * 17);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Canvas and texture helpers
// ---------------------------------------------------------------------------

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function context2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

export interface TextureOptions {
  /** Colour data (albedo/emission) is sRGB; data maps (roughness, normals, masks) are linear. */
  srgb?: boolean;
  /** RepeatWrapping on both axes (default true). */
  repeat?: boolean;
  /** Generate mipmaps and use trilinear filtering (default true). */
  mipmaps?: boolean;
  /** Anisotropic filtering samples; three clamps it to the GPU maximum. Default 8. */
  anisotropy?: number;
}

function applyTextureOptions(t: THREE.Texture, o: TextureOptions): void {
  t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const wrap = o.repeat === false ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.wrapS = wrap;
  t.wrapT = wrap;
  const mips = o.mipmaps !== false;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = o.anisotropy ?? 8;
  t.needsUpdate = true;
}

/** RGBA8 data texture (row 0 = v 0, i.e. no flip). */
export function dataTexture(data: Uint8Array, w: number, h: number, o: TextureOptions = {}): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  applyTextureOptions(t, o);
  return t;
}

/** Texture from a canvas. flipY is disabled so canvas row 0 maps to v = 0 like dataTexture. */
export function canvasTexture(c: HTMLCanvasElement, o: TextureOptions = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.flipY = false;
  applyTextureOptions(t, o);
  return t;
}

/**
 * Converts a height field (0..1, row-major, tiling) into a tangent-space normal map (RGBA8).
 * `strength` scales the slopes; x runs along +u, y along +v.
 */
export function heightToNormal(height: Float32Array, w: number, h: number, strength: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w;
    const yp = ((y + 1) % h) * w;
    const yc = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const dx = (height[yc + xp] - height[yc + xm]) * strength;
      const dy = (height[yp + x] - height[ym + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (yc + x) * 4;
      out[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference-counted shared resources
// ---------------------------------------------------------------------------

interface Disposable {
  dispose(): void;
}

const shared = new Map<string, { value: Disposable; refs: number }>();

/**
 * Returns the shared resource for `key`, creating it with `make` on first use. Every acquire must be
 * paired with a release; the resource is disposed when the last user releases it.
 */
export function acquireShared<T extends Disposable>(key: string, make: () => T): T {
  const hit = shared.get(key);
  if (hit) {
    hit.refs++;
    return hit.value as T;
  }
  const value = make();
  shared.set(key, { value, refs: 1 });
  return value;
}

export function releaseShared(key: string): void {
  const hit = shared.get(key);
  if (!hit) return;
  hit.refs--;
  if (hit.refs <= 0) {
    hit.value.dispose();
    shared.delete(key);
  }
}

/** Tracks shared keys acquired by one model so `dispose()` can release them all. */
export class SharedScope {
  private keys: string[] = [];

  get<T extends Disposable>(key: string, make: () => T): T {
    this.keys.push(key);
    return acquireShared(key, make);
  }

  releaseAll(): void {
    for (const k of this.keys) releaseShared(k);
    this.keys = [];
  }
}

// ---------------------------------------------------------------------------
// Common generated textures
// ---------------------------------------------------------------------------

/**
 * 256² tileable noise texture, four independent fbm channels (linear, RepeatWrapping). Useful for
 * flicker, soot, frost and smoke in shaders. Acquire through a SharedScope with key NOISE_KEY.
 */
export const NOISE_KEY = 'proc:noise256';

export function makeNoiseTexture(): THREE.DataTexture {
  const n = 256;
  const data = new Uint8Array(n * n * 4);
  const cells = 8;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x / n) * cells;
      const v = (y / n) * cells;
      const i = (y * n + x) * 4;
      data[i] = Math.round(tileFbm(u, v, cells, cells, 5, 11) * 255);
      data[i + 1] = Math.round(tileFbm(u, v, cells, cells, 5, 23) * 255);
      data[i + 2] = Math.round(tileFbm(u * 2, v * 2, cells * 2, cells * 2, 4, 37) * 255);
      data[i + 3] = Math.round(tileNoise(u * 4, v * 4, cells * 4, cells * 4, 51) * 255);
    }
  }
  return dataTexture(data, n, n, { srgb: false, repeat: true, mipmaps: true, anisotropy: 1 });
}

/** Soft round sprite (white, alpha falloff), 128². Key SOFT_SPRITE_KEY. */
export const SOFT_SPRITE_KEY = 'proc:softSprite';

export function makeSoftSprite(): THREE.DataTexture {
  const n = 128;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = r >= 1 ? 0 : Math.pow(1 - r * r, 2.2);
      const i = (y * n + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  return dataTexture(data, n, n, { srgb: false, repeat: false, mipmaps: true, anisotropy: 1 });
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Total triangles drawn for an object tree (instanced meshes count every instance). */
export function countTriangles(root: THREE.Object3D): number {
  let tris = 0;
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const g = m.geometry;
    const count = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1;
    tris += (count / 3) * inst;
  });
  return Math.round(tris);
}

/** Number of draw calls an object tree issues (one per visible mesh, per material group). */
export function countDrawCalls(root: THREE.Object3D): number {
  let calls = 0;
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine) return;
    if ((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count === 0) return;
    calls += Array.isArray(m.material) ? Math.max(1, m.geometry.groups.length) : 1;
  });
  return calls;
}

/**
 * Disposes geometries and materials of an object tree. Shared textures are not touched (release them
 * through their SharedScope); objects flagged with userData.sharedGeometry / userData.sharedMaterial
 * keep those resources.
 */
export function disposeObjectTree(root: THREE.Object3D): void {
  const seen = new Set<{ dispose(): void }>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !o.userData.sharedGeometry) seen.add(m.geometry);
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mat && !o.userData.sharedMaterial) {
      if (Array.isArray(mat)) mat.forEach((x) => seen.add(x));
      else seen.add(mat);
    }
  });
  seen.forEach((d) => d.dispose());
}
