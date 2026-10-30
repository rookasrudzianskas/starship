/**
 * Pixel generators behind the procedural textures: deterministic hashing and random numbers, tileable
 * value noise and the noise, soft sprite, stainless steel and smoke-puff images. Plain arrays only (no
 * three.js, no DOM), so the same code runs on the main thread and in the pixel worker
 * (pixels.worker.ts), which makes them off the main thread while the 3D view loads.
 */
import type { Quality } from '../contracts';

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

function wrap(i: number, p: number): number {
  const m = i % p;
  return m < 0 ? m + p : m;
}

/**
 * tileNoise for bulk texture generation: the lattice hashes over a window of cells are computed once, after
 * which sample() returns exactly tileNoise(x, y, px, py, seed) for any point with x0 <= x <= x1, y0 <= y <= y1
 * (several times faster than hashing four corners per sample).
 */
export class NoiseLattice {
  private readonly v: Float64Array;
  private readonly ox: number;
  private readonly oy: number;
  private readonly w: number;

  constructor(x0: number, y0: number, x1: number, y1: number, px: number, py: number, seed: number) {
    this.ox = Math.floor(x0);
    this.oy = Math.floor(y0);
    this.w = Math.floor(x1) - this.ox + 2;
    const h = Math.floor(y1) - this.oy + 2;
    this.v = new Float64Array(this.w * h);
    for (let j = 0; j < h; j++) {
      const yy = wrap(this.oy + j, py);
      for (let i = 0; i < this.w; i++) this.v[j * this.w + i] = hash3i(wrap(this.ox + i, px), yy, seed);
    }
  }

  sample(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const k = (yi - this.oy) * this.w + (xi - this.ox);
    const a = this.v[k];
    const b = this.v[k + 1];
    const c = this.v[k + this.w];
    const d = this.v[k + this.w + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
}

/** tileFbm over a window (see NoiseLattice): sample() equals tileFbm(x, y, px, py, octaves, seed, gain). */
export class FbmLattice {
  private readonly octaves: NoiseLattice[] = [];
  private readonly amps: number[] = [];
  private readonly norm: number;

  constructor(x0: number, y0: number, x1: number, y1: number, px: number, py: number, octaves: number, seed = 0, gain = 0.5) {
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      this.octaves.push(new NoiseLattice(x0 * f, y0 * f, x1 * f, y1 * f, px * f, py * f, seed + o * 17));
      this.amps.push(amp);
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    this.norm = norm;
  }

  sample(x: number, y: number): number {
    let sum = 0;
    let f = 1;
    for (let o = 0; o < this.octaves.length; o++) {
      sum += this.amps[o] * this.octaves[o].sample(x * f, y * f);
      f *= 2;
    }
    return sum / this.norm;
  }
}

// ---------------------------------------------------------------------------
// Noise and sprite images
// ---------------------------------------------------------------------------

/**
 * 256² tileable noise texture, four independent fbm channels (linear, RepeatWrapping). Useful for
 * flicker, soot, frost and smoke in shaders. Acquire through a SharedScope with key NOISE_KEY.
 */
export const NOISE_KEY = 'proc:noise256';

export function noisePixels(): Uint8Array {
  const n = 256;
  const data = new Uint8Array(n * n * 4);
  const cells = 8;
  const r = new FbmLattice(0, 0, cells, cells, cells, cells, 5, 11);
  const g = new FbmLattice(0, 0, cells, cells, cells, cells, 5, 23);
  const b = new FbmLattice(0, 0, cells * 2, cells * 2, cells * 2, cells * 2, 4, 37);
  const a = new NoiseLattice(0, 0, cells * 4, cells * 4, cells * 4, cells * 4, 51);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x / n) * cells;
      const v = (y / n) * cells;
      const i = (y * n + x) * 4;
      data[i] = Math.round(r.sample(u, v) * 255);
      data[i + 1] = Math.round(g.sample(u, v) * 255);
      data[i + 2] = Math.round(b.sample(u * 2, v * 2) * 255);
      data[i + 3] = Math.round(a.sample(u * 4, v * 4) * 255);
    }
  }
  return data;
}

/** Soft round sprite (white, alpha falloff), 128². Key SOFT_SPRITE_KEY. */
export const SOFT_SPRITE_KEY = 'proc:softSprite';

export function softSpritePixels(): Uint8Array {
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
  return data;
}

// ---------------------------------------------------------------------------
// Stainless steel maps
// ---------------------------------------------------------------------------

/*
 * Generated stainless-steel maps for the vehicle skins. UVs are in metres (u = arc length around the
 * hull, v = height), so one texture repeat covers STEEL_TEX_U × STEEL_TEX_V metres: half the 9 m
 * circumference by eight 1.8 m rings.
 *
 * - albedo (sRGB): brushed grain, weld bead and heat tint (straw/blue) either side of each weld.
 * - orm (linear): R = ambient occlusion, G = roughness, B = metalness (three's ORM convention).
 * - normal (linear, tangent space): ring "pillowing" between welds, the weld bead and its sag, slight
 *   oil-canning. Slopes are stored exaggerated by NORMAL_GAIN and undone with material.normalScale,
 *   which keeps 8-bit precision for the very shallow slopes real rings have.
 */

export const RING_HEIGHT = 1.8;
export const STEEL_TEX_U = Math.PI * 4.5;
export const STEEL_TEX_V = RING_HEIGHT * 8;
export const NORMAL_GAIN = 4;

export interface SteelPixels {
  w: number;
  h: number;
  albedo: Uint8Array;
  orm: Uint8Array;
  normal: Uint8Array;
}

export function steelPixels(q: Quality): SteelPixels {
  const w = q === 'high' ? 1024 : 512;
  const h = q === 'high' ? 2048 : 1024;
  const du = STEEL_TEX_U / w;
  const dv = STEEL_TEX_V / h;
  const rand = seededRandom(9127);
  const rings = 8;
  const seamU: number[] = [];
  const ringGrain: number[] = [];
  for (let i = 0; i < rings; i++) {
    seamU.push(rand() * STEEL_TEX_U);
    ringGrain.push(0.6 + rand() * 0.8);
  }

  const height = new Float32Array(w * h);
  const albedo = new Uint8Array(w * h * 4);
  const orm = new Uint8Array(w * h * 4);

  // Noise periods chosen so the texture tiles exactly.
  const grainPu = 24;
  const grainPv = 1600;
  const wavePu = 14;
  const wavePv = 18;
  const grainN = new NoiseLattice(0, 0, grainPu, grainPv, grainPu, grainPv, 3);
  const waveN = new NoiseLattice(0, 0, wavePu, wavePv, wavePu, wavePv, 5);
  // The vertical seam's bead and heat tint vanish (below 1e-5) beyond this distance, m.
  const seamReach = 0.075;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * dv;
    const ring = Math.min(rings - 1, Math.floor(v / RING_HEIGHT));
    const local = v - ring * RING_HEIGHT;
    const dWeld = Math.min(local, RING_HEIGHT - local); // distance to the nearest circumferential weld, m
    // Ring "pillow": each ring bulges slightly between welds (a few mm), so reflections band at every weld.
    const c = (local - RING_HEIGHT / 2) / (RING_HEIGHT / 2);
    const pillow = 0.0055 * (1 - c * c);
    const sag = -0.0016 * Math.exp(-((dWeld / 0.045) ** 2));
    const beadH = 0.0011 * Math.exp(-((dWeld / 0.0065) ** 2));
    const bead = Math.exp(-((dWeld / 0.008) ** 2));
    const hazStraw = Math.exp(-((dWeld / 0.035) ** 2)) - bead;
    const hazBlue = Math.exp(-((dWeld / 0.016) ** 2)) - bead;
    const g = ringGrain[ring];
    const seam = seamU[ring];
    const gv = (v / STEEL_TEX_V) * grainPv;
    const wv = (v / STEEL_TEX_V) * wavePv;
    const rowH = pillow + sag + beadH;

    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * du;
      const i = y * w + x;

      // Vertical (longitudinal) seam of this ring, narrower heat-affected zone.
      let ds = Math.abs(u - seam);
      ds = Math.min(ds, STEEL_TEX_U - ds);
      let vBead = 0;
      let vHaz = 0;
      let vBeadH = 0;
      if (ds < seamReach) {
        vBead = Math.exp(-((ds / 0.006) ** 2));
        vHaz = Math.exp(-((ds / 0.022) ** 2)) - vBead;
        vBeadH = 0.0008 * Math.exp(-((ds / 0.005) ** 2));
      }

      // Brushed grain: long along u (rolling direction), very short along v.
      const grain = grainN.sample((u / STEEL_TEX_U) * grainPu, gv) - 0.5;
      const fine = hash3i(x, y, 77) - 0.5;
      // Oil-canning: gentle 0.5-1 m undulations.
      const wave = waveN.sample((u / STEEL_TEX_U) * wavePu, wv) - 0.5;

      height[i] = rowH + vBeadH + wave * 0.0022 + grain * 0.00004 * g;

      // Albedo (sRGB bytes): neutral bright steel, faint grain, weld colours.
      let r = 201 + grain * 10 * g + fine * 4;
      let gg = 203 + grain * 10 * g + fine * 4;
      let b = 206 + grain * 10 * g + fine * 4;
      const straw = Math.max(hazStraw, 0) + Math.max(vHaz, 0) * 0.7;
      const blue = Math.max(hazBlue, 0);
      r += straw * 18 - blue * 30;
      gg += straw * 4 - blue * 18;
      b += -straw * 26 + blue * 6;
      const beadAll = Math.max(bead, vBead);
      r = r * (1 - beadAll * 0.35);
      gg = gg * (1 - beadAll * 0.35);
      b = b * (1 - beadAll * 0.33);
      const k = i * 4;
      albedo[k] = clampByte(r);
      albedo[k + 1] = clampByte(gg);
      albedo[k + 2] = clampByte(b);
      albedo[k + 3] = 255;

      // ORM: brushed steel is a blurred mirror, not a polished one (in shade it would otherwise just repeat
      // the sky behind the vehicle and read as glass); roughness rises on the bead and heat-affected zones,
      // grain adds streaky variation.
      const rough = 0.42 + grain * 0.07 * g + fine * 0.02 + beadAll * 0.3 + straw * 0.08;
      orm[k] = clampByte(255 * (1 - beadAll * 0.25));
      orm[k + 1] = clampByte(rough * 255);
      orm[k + 2] = clampByte(255 * (1 - beadAll * 0.15));
      orm[k + 3] = 255;
    }
  }

  // Normals from heights in metres with the true (anisotropic) texel size.
  const normal = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w;
    const yp = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) {
      const xm = x === 0 ? w - 1 : x - 1;
      const xp = x === w - 1 ? 0 : x + 1;
      const sx = ((height[y * w + xp] - height[y * w + xm]) / (2 * du)) * NORMAL_GAIN;
      const sy = ((height[yp + x] - height[ym + x]) / (2 * dv)) * NORMAL_GAIN;
      const inv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
      const k = (y * w + x) * 4;
      normal[k] = clampByte((-sx * inv * 0.5 + 0.5) * 255);
      normal[k + 1] = clampByte((-sy * inv * 0.5 + 0.5) * 255);
      normal[k + 2] = clampByte((inv * 0.5 + 0.5) * 255);
      normal[k + 3] = 255;
    }
  }
  return { w, h, albedo, orm, normal };
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// ---------------------------------------------------------------------------
// Puff atlas: 2×2 billowy puff variants, 256² each.
// R = density, G/B = view-plane normal x/y (encoded 0..1), A = turbulent detail (fire tongues, erosion).
// ---------------------------------------------------------------------------

export const PUFF_ATLAS_KEY = 'fx:puffAtlas';

export function puffAtlasPixels(): Uint8Array {
  const cell = 256;
  const size = cell * 2;
  const data = new Uint8Array(size * size * 4);
  const field = new Float32Array(cell * cell);
  for (let v = 0; v < 4; v++) {
    const rnd = seededRandom(9001 + v * 131);
    // Gaussian metaballs around a dense core; their sum is a smooth, lumpy "cauliflower" field.
    const blobs: Array<{ x: number; y: number; k: number }> = [{ x: 0, y: 0, k: 1 / (0.36 * 0.36) }];
    const nb = 14 + Math.floor(rnd() * 6);
    for (let k = 0; k < nb; k++) {
      const r = 0.12 + rnd() * 0.2;
      const ang = rnd() * Math.PI * 2;
      const off = Math.sqrt(rnd()) * Math.min(0.78 - r, 0.5);
      blobs.push({ x: Math.cos(ang) * off, y: Math.sin(ang) * off, k: 1 / (r * r) });
    }
    // Noise lattices over exactly the coordinate ranges sampled below (same values as tileFbm).
    const warpX = new FbmLattice(-3 + v * 5.1, -3, 3 + v * 5.1, 3, 64, 64, 3, 100 + v);
    const warpY = new FbmLattice(-3, -3 + v * 2.3, 3, 3 + v * 2.3, 64, 64, 3, 200 + v);
    const fineN = new FbmLattice(-7 + v * 1.7, -7 - v * 2.9, 7 + v * 1.7, 7 - v * 2.9, 64, 64, 4, 500 + v);
    const turbN = new FbmLattice(-5 + v * 4.1, -5 + v * 6.7, 5 + v * 4.1, 5 + v * 6.7, 64, 64, 5, 700 + v);
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const x0 = ((i + 0.5) / cell) * 2 - 1;
        const y0 = ((j + 0.5) / cell) * 2 - 1;
        // Domain warp so outlines are ragged rather than circular.
        const x = x0 + (warpX.sample(x0 * 3 + v * 5.1, y0 * 3) - 0.5) * 0.16;
        const y = y0 + (warpY.sample(x0 * 3, y0 * 3 + v * 2.3) - 0.5) * 0.16;
        let f = 0;
        for (const b of blobs) {
          const dx = x - b.x;
          const dy = y - b.y;
          const e = (dx * dx + dy * dy) * b.k;
          // Beyond e = 14 a blob adds less than 1e-6: skip the exp.
          if (e < 14) f += Math.exp(-e);
        }
        field[j * cell + i] = f;
      }
    }
    const ox = (v % 2) * cell;
    const oy = Math.floor(v / 2) * cell;
    const pix = 2 / cell;
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const x = ((i + 0.5) / cell) * 2 - 1;
        const y = ((j + 0.5) / cell) * 2 - 1;
        const r = Math.sqrt(x * x + y * y);
        const f = field[j * cell + i];
        const fx0 = field[j * cell + Math.max(i - 2, 0)];
        const fx1 = field[j * cell + Math.min(i + 2, cell - 1)];
        const fy0 = field[Math.max(j - 2, 0) * cell + i];
        const fy1 = field[Math.min(j + 2, cell - 1) * cell + i];
        // Normal of the field treated as a height map (bumps face outwards at the rim).
        const k = 0.22;
        let gx = ((fx1 - fx0) / (4 * pix)) * k;
        let gy = ((fy1 - fy0) / (4 * pix)) * k;
        // Add a radial bulge so the whole puff reads as a rounded volume.
        gx -= x * 1.1;
        gy -= y * 1.1;
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const nx = -gx * inv;
        const ny = -gy * inv;
        const fine = fineN.sample(x * 7 + v * 1.7, y * 7 - v * 2.9);
        const window = 1 - Math.min(Math.max((r - 0.8) / 0.18, 0), 1);
        const t = Math.min(Math.max((f - 0.16) / 1.25, 0), 1);
        const dens = t * t * (3 - 2 * t) * (0.55 + 0.45 * fine) * window;
        // Ridged turbulence for fire tongues and wispy erosion.
        const turb = turbN.sample(x * 5 + v * 4.1, y * 5 + v * 6.7);
        const ridged = 1 - Math.abs(turb * 2 - 1);
        const detail = Math.min(Math.max(0.1 + ridged * 0.85 + (fine - 0.5) * 0.5, 0), 1);
        const o = ((oy + j) * size + ox + i) * 4;
        data[o] = Math.round(Math.min(Math.max(dens, 0), 1) * 255);
        data[o + 1] = Math.round((Math.min(Math.max(nx, -1), 1) * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round((Math.min(Math.max(ny, -1), 1) * 0.5 + 0.5) * 255);
        data[o + 3] = Math.round(detail * 255);
      }
    }
  }
  return data;
}


// ---------------------------------------------------------------------------
// Jobs (main thread or worker)
// ---------------------------------------------------------------------------

export function steelPixelsKey(q: Quality): string {
  return `veh:steel:${q}:pixels`;
}

export type PixelJob = { kind: 'noise' } | { kind: 'puff' } | { kind: 'steel'; quality: Quality };
export type PixelResult = Uint8Array | SteelPixels;

/**
 * The pixels worth making ahead of time, keyed as generatedOnce (procedural.ts) caches them: noise and
 * smoke puffs always, the steel maps when the quality is known.
 */
export function pixelJobs(q?: Quality): Record<string, PixelJob> {
  const jobs: Record<string, PixelJob> = { [NOISE_KEY]: { kind: 'noise' }, [PUFF_ATLAS_KEY]: { kind: 'puff' } };
  // Only the qualities models are built with (anything else would make a copy no model ever uses).
  if (q === 'high' || q === 'low') jobs[steelPixelsKey(q)] = { kind: 'steel', quality: q };
  return jobs;
}

export function runPixelJob(job: PixelJob): PixelResult {
  switch (job.kind) {
    case 'noise':
      return noisePixels();
    case 'puff':
      return puffAtlasPixels();
    case 'steel':
      return steelPixels(job.quality);
  }
}

/** The buffers of a result, to transfer rather than copy. */
export function pixelBuffers(r: PixelResult): ArrayBuffer[] {
  if (r instanceof Uint8Array) return [r.buffer as ArrayBuffer];
  return [r.albedo.buffer as ArrayBuffer, r.orm.buffer as ArrayBuffer, r.normal.buffer as ArrayBuffer];
}
