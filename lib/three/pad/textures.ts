import * as THREE from 'three';
import { canvasTexture, context2d, generatedOnce, hash3i, makeCanvas, seededRandom, tileFbm } from '@/lib/three/vehicles/procedural';

/**
 * Canvas-generated pad textures. All of them tile and are mapped with metre UVs, so `repeat` encodes
 * the patch size in metres. They are created through a SharedScope (see materials.ts) and shared by
 * every pad instance; the canvases are drawn once per session (generatedOnce).
 */

export const CONCRETE_KEY = 'pad:concrete';
export const PLATE_KEY = 'pad:plate';
export const RING_STEEL_KEY = 'pad:ringSteel';
export const CAST_KEY = 'pad:castConcrete';

/** Concrete patch size in metres (four 6 m slabs each way). */
const CONCRETE_M = 24;
/** Patch sizes in metres of the deflector plate, tank steel and cast concrete textures. */
const PLATE_M = 4;
const RING_STEEL_M = 7.2;
const CAST_M = 4.8;

/** Upsamples a tileable fbm field drawn at `n`² into the target canvas (smooth large-scale variation). */
function drawFbmBase(
  ctx: CanvasRenderingContext2D,
  size: number,
  n: number,
  periods: number,
  seed: number,
  color: (v: number, x: number, y: number) => [number, number, number],
): void {
  const small = makeCanvas(n, n);
  const sctx = context2d(small);
  const img = sctx.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = tileFbm((x / n) * periods, (y / n) * periods, periods, periods, 4, seed);
      const [r, g, b] = color(v, x, y);
      const i = (y * n + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, size, size);
}

/** Adds per-pixel grain (and sparse dark pebbles) to the whole canvas. */
function addGrain(ctx: CanvasRenderingContext2D, w: number, h: number, amp: number, seed: number, pebbles = 0): void {
  const img = ctx.getImageData(0, 0, w, h);
  // A Uint8ClampedArray clamps (and rounds) on assignment, so no explicit clamping is needed.
  const d = img.data;
  const rnd = seededRandom(seed);
  const pebbly = pebbles > 0;
  for (let i = 0; i < d.length; i += 4) {
    let k = (rnd() - 0.5) * 2 * amp;
    if (pebbly && rnd() < pebbles) k -= 25 + rnd() * 30;
    d[i] += k;
    d[i + 1] += k;
    d[i + 2] += k * 0.95;
  }
  ctx.putImageData(img, 0, 0);
}

function stain(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rgba: string): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Light grey broom-finished concrete with 6 m slabs, saw cuts, stains and tyre tracks. 1024² = 24 m. */
function drawConcrete(): HTMLCanvasElement {
  const N = 1024;
  const pxPerM = N / CONCRETE_M;
  const c = makeCanvas(N, N);
  const ctx = context2d(c);
  drawFbmBase(ctx, N, 128, 6, 101, (v) => {
    const g = 150 + v * 52;
    return [g + 4, g + 2, g - 4];
  });
  // Per-slab tone (each 6 m slab poured separately).
  const slab = 6 * pxPerM;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const h = hash3i(sx, sy, 7);
      const a = 0.015 + 0.03 * hash3i(sx, sy, 9);
      ctx.fillStyle = h > 0.5 ? `rgba(255,252,240,${a})` : `rgba(40,38,34,${a})`;
      ctx.fillRect(sx * slab, sy * slab, slab, slab);
    }
  }
  // Broom texture: faint parallel streaks inside each slab.
  const rnd = seededRandom(77);
  ctx.lineWidth = 1;
  for (let i = 0; i < 900; i++) {
    const y = rnd() * N;
    const x = rnd() * N;
    const len = 20 + rnd() * 90;
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rnd() - 0.5) * 2);
    ctx.stroke();
  }
  // Oil and water stains.
  for (let i = 0; i < 14; i++) {
    const x = rnd() * N;
    const y = rnd() * N;
    const r = 10 + rnd() * 50;
    stain(ctx, x, y, r, `rgba(30,28,24,${0.04 + rnd() * 0.08})`);
  }
  // Tyre tracks: long, soft, slightly curved bands.
  for (let i = 0; i < 5; i++) {
    const y0 = rnd() * N;
    const curve = (rnd() - 0.5) * 80;
    ctx.strokeStyle = `rgba(25,24,22,${0.05 + rnd() * 0.05})`;
    ctx.lineWidth = 6 + rnd() * 6;
    for (const off of [0, 1.9 * pxPerM]) {
      ctx.beginPath();
      ctx.moveTo(0, y0 + off);
      ctx.bezierCurveTo(N * 0.33, y0 + off + curve, N * 0.66, y0 + off - curve, N, y0 + off);
      ctx.stroke();
    }
  }
  addGrain(ctx, N, N, 9, 31, 0.004);
  // Sealed slab joints every 6 m: a thin dark line with a faint lighter shoulder.
  for (let k = 0; k <= 4; k++) {
    const p = Math.round(k * 6 * pxPerM);
    ctx.fillStyle = 'rgba(255,255,250,0.10)';
    ctx.fillRect(p - 3, 0, 6, N);
    ctx.fillRect(0, p - 3, N, 6);
    ctx.fillStyle = 'rgba(40,38,35,0.5)';
    ctx.fillRect(p - 1, 0, 2, N);
    ctx.fillRect(0, p - 1, N, 2);
  }
  return c;
}

export function makeConcreteTexture(): THREE.CanvasTexture {
  const t = canvasTexture(generatedOnce(CONCRETE_KEY, drawConcrete), { srgb: true, repeat: true, anisotropy: 8 });
  t.repeat.set(1 / CONCRETE_M, 1 / CONCRETE_M);
  return t;
}

/** Water-cooled steel deflector plate: dark steel with staggered water holes and heat tint. 512² = 4 m. */
function drawPlate(): HTMLCanvasElement {
  const N = 512;
  const M = PLATE_M;
  const c = makeCanvas(N, N);
  const ctx = context2d(c);
  drawFbmBase(ctx, N, 64, 4, 211, (v) => {
    const g = 88 + v * 44;
    return [g + 4, g + 1, g - 3];
  });
  const rnd = seededRandom(5);
  // Heat tint blotches (straw / blue temper colours).
  for (let i = 0; i < 18; i++) {
    const blue = rnd() > 0.5;
    stain(ctx, rnd() * N, rnd() * N, 40 + rnd() * 90, blue ? 'rgba(70,80,120,0.12)' : 'rgba(130,95,50,0.12)');
  }
  addGrain(ctx, N, N, 7, 17);
  // Staggered hole grid every 0.25 m.
  const step = N / (M / 0.25);
  for (let row = 0; row < M / 0.25; row++) {
    for (let col = 0; col < M / 0.25; col++) {
      const x = (col + (row % 2) * 0.5) * step + step / 2;
      const y = row * step + step / 2;
      ctx.fillStyle = 'rgba(150,150,150,0.35)';
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgb(18,18,20)';
      ctx.beginPath();
      ctx.arc(x, y, 4.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Plate seams every 2 m.
  ctx.fillStyle = 'rgba(20,20,22,0.7)';
  for (let k = 0; k <= 2; k++) {
    const p = Math.round((k * N) / 2);
    ctx.fillRect(p - 1.5, 0, 3, N);
    ctx.fillRect(0, p - 1.5, N, 3);
  }
  return c;
}

export function makePlateTexture(): THREE.CanvasTexture {
  const t = canvasTexture(generatedOnce(PLATE_KEY, drawPlate), { srgb: true, repeat: true, anisotropy: 8 });
  t.repeat.set(1 / PLATE_M, 1 / PLATE_M);
  return t;
}

/** Stainless tank shell built from 1.8 m rings: brushed streaks, ring welds and one seam per ring. */
function drawRingSteel(): HTMLCanvasElement {
  const W = 512;
  const H = 512;
  const MH = RING_STEEL_M;
  const c = makeCanvas(W, H);
  const ctx = context2d(c);
  ctx.fillStyle = 'rgb(196,198,201)';
  ctx.fillRect(0, 0, W, H);
  const rnd = seededRandom(91);
  const ringPx = (1.8 / MH) * H;
  for (let r = 0; r < 4; r++) {
    const tone = (rnd() - 0.5) * 14;
    ctx.fillStyle = tone > 0 ? `rgba(255,255,255,${tone / 120})` : `rgba(0,0,0,${-tone / 120})`;
    ctx.fillRect(0, r * ringPx, W, ringPx);
  }
  // Brushed streaks run around the circumference.
  for (let i = 0; i < 1100; i++) {
    const y = rnd() * H;
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
    ctx.lineWidth = 0.6 + rnd();
    ctx.beginPath();
    ctx.moveTo(rnd() * W - 40, y);
    ctx.lineTo(rnd() * W + 60, y + (rnd() - 0.5));
    ctx.stroke();
  }
  // Circumferential welds with heat tint either side.
  for (let r = 0; r <= 4; r++) {
    const y = Math.round(r * ringPx);
    ctx.fillStyle = 'rgba(150,120,80,0.08)';
    ctx.fillRect(0, y - 3, W, 6);
    ctx.fillStyle = 'rgba(70,70,74,0.25)';
    ctx.fillRect(0, y - 0.75, W, 1.5);
  }
  for (let r = 0; r < 4; r++) {
    const x = Math.round(rnd() * W);
    ctx.fillStyle = 'rgba(70,70,74,0.14)';
    ctx.fillRect(x - 0.75, r * ringPx, 1.5, ringPx);
  }
  addGrain(ctx, W, H, 6, 3);
  return c;
}

export function makeRingSteelTexture(): THREE.CanvasTexture {
  const t = canvasTexture(generatedOnce(RING_STEEL_KEY, drawRingSteel), { srgb: true, repeat: true, anisotropy: 8 });
  t.repeat.set(1 / RING_STEEL_M, 1 / RING_STEEL_M);
  return t;
}

/**
 * Cast-in-place concrete for walls, legs and footings: smooth, with faint 2.4 m formwork panel seams,
 * form-tie holes and soft weathering. 512² = 4.8 m.
 */
function drawCastConcrete(): HTMLCanvasElement {
  const N = 512;
  const M = CAST_M;
  const pxPerM = N / M;
  const c = makeCanvas(N, N);
  const ctx = context2d(c);
  drawFbmBase(ctx, N, 64, 4, 303, (v) => {
    const g = 158 + v * 44;
    return [g + 3, g + 1, g - 3];
  });
  const rnd = seededRandom(19);
  for (let i = 0; i < 14; i++) stain(ctx, rnd() * N, rnd() * N, 30 + rnd() * 70, `rgba(60,58,52,${0.04 + rnd() * 0.06})`);
  addGrain(ctx, N, N, 6, 13, 0.002);
  // Formwork panel seams (2.4 m) and tie holes on a 0.6 m grid.
  const panel = 2.4 * pxPerM;
  ctx.fillStyle = 'rgba(60,58,54,0.22)';
  for (let k = 0; k <= 2; k++) {
    const p = Math.round(k * panel);
    ctx.fillRect(p - 0.75, 0, 1.5, N);
    ctx.fillRect(0, p - 0.75, N, 1.5);
  }
  const tie = 0.6 * pxPerM;
  for (let y = tie / 2; y < N; y += tie) {
    for (let x = tie / 2; x < N; x += tie) {
      ctx.fillStyle = 'rgba(45,43,40,0.35)';
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

export function makeCastConcreteTexture(): THREE.CanvasTexture {
  const t = canvasTexture(generatedOnce(CAST_KEY, drawCastConcrete), { srgb: true, repeat: true, anisotropy: 8 });
  t.repeat.set(1 / CAST_M, 1 / CAST_M);
  return t;
}
