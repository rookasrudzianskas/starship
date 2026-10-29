import * as THREE from 'three';
import { dataTexture, hash3i, seededRandom, tileNoise } from './procedural';
import type { Quality } from '@/lib/three/contracts';

/**
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

export interface SteelMaps {
  albedo: THREE.DataTexture;
  orm: THREE.DataTexture;
  normal: THREE.DataTexture;
  dispose(): void;
}

export function steelMapsKey(q: Quality): string {
  return `veh:steel:${q}`;
}

export function makeSteelMaps(q: Quality): SteelMaps {
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

    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * du;
      const i = y * w + x;

      // Vertical (longitudinal) seam of this ring, narrower heat-affected zone.
      let ds = Math.abs(u - seamU[ring]);
      ds = Math.min(ds, STEEL_TEX_U - ds);
      const vBead = Math.exp(-((ds / 0.006) ** 2));
      const vHaz = Math.exp(-((ds / 0.022) ** 2)) - vBead;
      const vBeadH = 0.0008 * Math.exp(-((ds / 0.005) ** 2));

      // Brushed grain: long along u (rolling direction), very short along v.
      const grain = tileNoise((u / STEEL_TEX_U) * grainPu, (v / STEEL_TEX_V) * grainPv, grainPu, grainPv, 3) - 0.5;
      const fine = hash3i(x, y, 77) - 0.5;
      // Oil-canning: gentle 0.5-1 m undulations.
      const wave = tileNoise((u / STEEL_TEX_U) * wavePu, (v / STEEL_TEX_V) * wavePv, wavePu, wavePv, 5) - 0.5;

      height[i] = pillow + sag + beadH + vBeadH + wave * 0.0022 + grain * 0.00004 * g;

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

      // ORM: roughness rises on the bead and heat-affected zones; grain adds streaky variation.
      const rough = 0.3 + grain * 0.07 * g + fine * 0.02 + beadAll * 0.3 + straw * 0.08;
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
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
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

  const maps = {
    albedo: dataTexture(albedo, w, h, { srgb: true, anisotropy: 8 }),
    orm: dataTexture(orm, w, h, { srgb: false, anisotropy: 8 }),
    normal: dataTexture(normal, w, h, { srgb: false, anisotropy: 8 }),
    dispose() {
      maps.albedo.dispose();
      maps.orm.dispose();
      maps.normal.dispose();
    },
  };
  // Hull UVs are in metres: one repeat per STEEL_TEX_U × STEEL_TEX_V.
  for (const t of [maps.albedo, maps.orm, maps.normal]) t.repeat.set(1 / STEEL_TEX_U, 1 / STEEL_TEX_V);
  return maps;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Fallback environment (equirectangular sky over dark ground) used only when the scene has no
 * environment map, so the metal does not render black. three converts it to a PMREM on first use.
 */
export const FALLBACK_ENV_KEY = 'veh:fallbackEnv';

export function makeFallbackEnv(): THREE.DataTexture {
  const w = 128;
  const h = 64;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    // Row 0 is the bottom (v = 0) since data textures are not flipped: elevation -90° .. +90°.
    const el = ((y + 0.5) / h - 0.5) * Math.PI;
    const s = Math.sin(el);
    let r: number;
    let g: number;
    let b: number;
    if (s >= 0) {
      const t = Math.pow(s, 0.5);
      r = 150 + (40 - 150) * t;
      g = 172 + (85 - 172) * t;
      b = 198 + (160 - 198) * t;
    } else {
      const t = Math.min(1, -s * 3);
      r = 110 + (52 - 110) * t;
      g = 112 + (50 - 112) * t;
      b = 112 + (44 - 112) * t;
    }
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      data[k] = r;
      data[k + 1] = g;
      data[k + 2] = b;
      data[k + 3] = 255;
    }
  }
  const t = dataTexture(data, w, h, { srgb: true, repeat: false, mipmaps: false, anisotropy: 1 });
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}
