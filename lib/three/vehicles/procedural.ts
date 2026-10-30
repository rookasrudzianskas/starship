import * as THREE from 'three';
import { NOISE_KEY, SOFT_SPRITE_KEY, noisePixels, pixelJobs, softSpritePixels, type PixelResult } from './pixels';
import type { Quality } from '@/lib/three/contracts';

/**
 * Small procedural toolkit shared by the vehicle, pad and effects modules: deterministic hashing and
 * random numbers, tileable value noise (both in pixels.ts), canvas/data texture helpers and a
 * reference-counted cache so generated textures (and other heavy resources) are built once and shared by
 * every instance. The heaviest pixels can be made in a worker ahead of time (prefetchGenerated).
 * Nothing here touches the DOM at import time, so it is safe to import from server components.
 */

export {
  FbmLattice,
  NOISE_KEY,
  NoiseLattice,
  SOFT_SPRITE_KEY,
  hash3i,
  seededRandom,
  tileFbm,
  tileNoise,
} from './pixels';

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
const generated = new Map<string, unknown>();

/**
 * The pixels (or canvas) behind a generated texture, made on first use and kept for the session. Textures
 * built from them stay reference counted and free their GPU memory with their last user, but a later
 * rebuild (another pad, vehicle generation or quality) only uploads them again instead of spending tens to
 * hundreds of milliseconds regenerating them.
 */
export function generatedOnce<T>(key: string, make: () => T): T {
  let value = generated.get(key) as T | undefined;
  if (value === undefined) {
    value = make();
    generated.set(key, value);
  }
  return value;
}

/**
 * Returns the shared resource for `key`, creating it with `make` on first use. Every acquire must be
 * paired with a release; the resource is disposed when the last user releases it (expensive generated
 * pixels survive that, see generatedOnce).
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
// Pixels made ahead of time in a worker
// ---------------------------------------------------------------------------

let pixelWorker: Worker | null | undefined;
/** Jobs posted to the worker and not answered yet, by key: settle() resolves their waiters. */
const inFlight = new Map<string, { done: Promise<void>; settle: () => void }>();

/** The pixel worker, started on first use; null where workers are unavailable or after it failed. */
function getPixelWorker(): Worker | null {
  if (pixelWorker !== undefined) return pixelWorker;
  let w: Worker | null = null;
  try {
    w = typeof Worker === 'undefined' ? null : new Worker(new URL('./pixels.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    w = null;
  }
  pixelWorker = w;
  if (!w) return null;
  w.addEventListener('message', (e: MessageEvent<{ key: string; pixels: PixelResult }>) => {
    const { key, pixels } = e.data;
    // A model built meanwhile has made these on the main thread: keep that copy.
    if (!generated.has(key)) generated.set(key, pixels);
    inFlight.get(key)?.settle();
    inFlight.delete(key);
  });
  // A worker that fails to load or crashes: whatever it still owed is made on the main thread when used.
  const fail = () => {
    if (pixelWorker === w) pixelWorker = null;
    w.terminate();
    for (const job of inFlight.values()) job.settle();
    inFlight.clear();
  };
  w.addEventListener('error', fail);
  w.addEventListener('messageerror', fail);
  return w;
}

/**
 * Starts making the pixels of the large shared textures (noise, smoke puffs and, given the quality, the
 * steel maps) in a worker, so that building the first models only uploads them. Safe to call any number
 * of times, with or without a quality: each image is requested once, and every call's promise resolves
 * when the images it asked for are cached (at once if they already are, or if workers are unavailable)
 * or the worker has failed. Anything still missing when a model needs it is made on the spot by
 * generatedOnce, and the worker's late copy is dropped.
 */
export function prefetchGenerated(quality?: Quality): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const [key, job] of Object.entries(pixelJobs(quality))) {
    if (generated.has(key)) continue;
    let pending = inFlight.get(key);
    if (!pending) {
      const w = getPixelWorker();
      if (!w) break;
      let settle = () => {};
      const done = new Promise<void>((resolve) => {
        settle = () => resolve();
      });
      pending = { done, settle };
      inFlight.set(key, pending);
      w.postMessage({ key, job });
    }
    waits.push(pending.done);
  }
  return Promise.all(waits).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Common generated textures
// ---------------------------------------------------------------------------

/**
 * 256² tileable noise texture, four independent fbm channels (linear, RepeatWrapping). Useful for
 * flicker, soot, frost and smoke in shaders. Acquire through a SharedScope with key NOISE_KEY.
 */
export function makeNoiseTexture(): THREE.DataTexture {
  return dataTexture(generatedOnce(NOISE_KEY, noisePixels), 256, 256, { srgb: false, repeat: true, mipmaps: true, anisotropy: 1 });
}

/** Soft round sprite (white, alpha falloff), 128². Key SOFT_SPRITE_KEY. */
export function makeSoftSprite(): THREE.DataTexture {
  return dataTexture(generatedOnce(SOFT_SPRITE_KEY, softSpritePixels), 128, 128, { srgb: false, repeat: false, mipmaps: true, anisotropy: 1 });
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
