import * as THREE from 'three';
import { dataTexture, generatedOnce } from './procedural';
import { STEEL_TEX_U, STEEL_TEX_V, steelPixels, steelPixelsKey } from './pixels';
import type { Quality } from '@/lib/three/contracts';

/**
 * Generated stainless-steel maps for the vehicle skins (albedo, ORM and normal; see steelPixels in
 * pixels.ts). UVs are in metres (u = arc length around the hull, v = height), so one texture repeat
 * covers STEEL_TEX_U × STEEL_TEX_V metres: half the 9 m circumference by eight 1.8 m rings.
 */

export { NORMAL_GAIN, RING_HEIGHT, STEEL_TEX_U, STEEL_TEX_V } from './pixels';

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
  const px = generatedOnce(steelPixelsKey(q), () => steelPixels(q));
  const maps = {
    albedo: dataTexture(px.albedo, px.w, px.h, { srgb: true, anisotropy: 8 }),
    orm: dataTexture(px.orm, px.w, px.h, { srgb: false, anisotropy: 8 }),
    normal: dataTexture(px.normal, px.w, px.h, { srgb: false, anisotropy: 8 }),
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
