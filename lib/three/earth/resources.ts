import * as THREE from 'three';
import type { Quality } from '@/lib/three/contracts';
import { type AtmosphereModel, IRRADIANCE_SIZE, MS_SIZE, TRANSMITTANCE_SIZE } from './atmosphere';

/** Public URL of the imagery written by scripts/fetch-imagery.mjs. */
export const EARTH_ASSET_BASE = '/earth/';

export type PatchId = 'pad' | 'mid' | 'wide';

export interface ManifestImage {
  file: string;
  bytes: number;
  width: number;
  height: number;
}

export interface PatchManifest extends ManifestImage {
  id: PatchId;
  zoom: number;
  /** EPSG:3857 bounds in metres. u = (x − xmin) / (xmax − xmin), v = (ymax − y) / (ymax − ymin). */
  mercator: { xmin: number; ymin: number; xmax: number; ymax: number };
  bounds: { west: number; south: number; east: number; north: number };
  center: { lat: number; lon: number };
  groundMetresPerPixel: number;
}

export interface AttributionEntry {
  id: string;
  short: string;
  text: string;
  licence: string;
  urls: string[];
}

export interface EarthManifest {
  version: number;
  globe: {
    projection: string;
    day: Array<ManifestImage & { quality: Quality }>;
    night: ManifestImage;
    water: ManifestImage;
  };
  patches: PatchManifest[];
  patchWater: ManifestImage | null;
  attribution: AttributionEntry[];
  creditLine: string;
}

export async function loadManifest(signal?: AbortSignal): Promise<EarthManifest> {
  const res = await fetch(`${EARTH_ASSET_BASE}manifest.json`, { signal });
  if (!res.ok) throw new Error(`Earth manifest: HTTP ${res.status}`);
  return (await res.json()) as EarthManifest;
}

/** Decode off the main thread where possible; older engines reject the options or lack createImageBitmap. */
async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch {
      try {
        return await createImageBitmap(blob);
      } catch {
        // fall through to an <img>
      }
    }
  }
  const src = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(src);
  }
}

export interface ImageTextureOptions {
  srgb: boolean;
  repeatS?: boolean;
  anisotropy: number;
}

/**
 * Load an image as a texture (decoded off the main thread via createImageBitmap). Rows stay in file order
 * (flipY = false): v = 0 is the top row of the image, which every shader here assumes.
 */
export async function loadImageTexture(
  url: string,
  opts: ImageTextureOptions,
  signal?: AbortSignal,
): Promise<THREE.Texture> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  const tex = new THREE.Texture(await decodeImage(blob));
  tex.flipY = false;
  tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = opts.repeatS ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = opts.anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Upload now (predictable hitch at load time instead of on first use) and drop the decoded copy. */
export function uploadAndRelease(renderer: THREE.WebGLRenderer, tex: THREE.Texture): void {
  renderer.initTexture(tex);
  const image: unknown = tex.image;
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
}

/** Half-float RGBA data texture from an RGB float table (linear filtering works everywhere for half floats). */
export function lutTexture(rgb: Float32Array, w: number, h: number): THREE.DataTexture {
  const data = new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = THREE.DataUtils.toHalfFloat(rgb[i * 3]);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(rgb[i * 3 + 1]);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(rgb[i * 3 + 2]);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** GPU copies of the model's tables. */
export function createAtmosphereTextures(model: AtmosphereModel) {
  return {
    transmittance: lutTexture(model.tables.transmittance, ...TRANSMITTANCE_SIZE),
    multipleScattering: lutTexture(model.tables.multipleScattering, ...MS_SIZE),
    groundIrradiance: lutTexture(model.tables.groundIrradiance, IRRADIANCE_SIZE, 1),
  };
}

export type AtmosphereTextures = ReturnType<typeof createAtmosphereTextures>;

/** 1×1 stand-in so samplers are always bound before the imagery arrives. */
export function placeholderTexture(rgba: [number, number, number, number]): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}
