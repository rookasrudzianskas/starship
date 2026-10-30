import * as THREE from 'three';
import { type AtmosphereModel, IRRADIANCE_SIZE, MS_SIZE, TRANSMITTANCE_SIZE } from './atmosphere';
import { type DecodedImage, releaseImage } from './imagery';

export { EARTH_ASSET_BASE } from './imagery';
export type { AttributionEntry, EarthManifest, ManifestImage, PatchId, PatchManifest } from './imagery';

export interface ImageTextureOptions {
  /** sRGB-encoded colour (the GPU decodes it to linear); otherwise raw data. */
  srgb: boolean;
  /** Greyscale data kept as one channel (R8): a quarter of the memory of RGBA. */
  single?: boolean;
  repeatS?: boolean;
  anisotropy: number;
}

/**
 * Sampler and format set-up for imagery. Rows stay in file order (flipY = false): v = 0 is the top row of the
 * image, which every shader here assumes.
 */
function configure(tex: THREE.Texture, opts: ImageTextureOptions): void {
  tex.flipY = false;
  tex.format = opts.single ? THREE.RedFormat : THREE.RGBAFormat;
  tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = opts.repeatS ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = opts.anisotropy;
}

/** Pixels per band: 1 MB of RGBA, a fraction of a millisecond to crop and hand over on a desktop. */
const BAND_PIXELS = 256 * 1024;
/**
 * Pixels per frame: least, first and most. The browser hands texture data to its GPU process through a buffer of
 * limited size, and once more arrives than that process drains between frames the next upload call blocks until
 * it catches up (10–20 ms on a desktop). So the budget adapts: it halves whenever an upload blocks, and grows by a
 * band after each frame that used it all without blocking.
 */
const SLICE_PIXELS: [number, number, number] = [BAND_PIXELS, 4 * BAND_PIXELS, 8 * BAND_PIXELS];
/** An upload call that takes longer than this (ms) was kept waiting by the GPU process. */
const BLOCKED_MS = 3;
/** Time each frame may spend (ms), within the idle time the browser reports. */
const SLICE_MS: [number, number] = [2, 8];
/** Without requestIdleCallback (Safari), work this long just after each frame. */
const FALLBACK_SLICE_MS = 4;

interface UploadJob {
  image: ImageBitmap;
  texture: THREE.Texture;
  /** Next row to copy; -1 until the texture's storage is allocated. */
  y: number;
  rows: number;
  finish(texture: THREE.Texture | null): void;
  fail(err: unknown): void;
}

/**
 * Uploads decoded images to the GPU in horizontal bands, a few per frame, so even the 8K day texture never stalls
 * the main thread (in one go it blocks for ~0.2 s on a desktop and far longer on a phone). Each texture's storage
 * is allocated up front with every mip level but no pixels; bands cropped from the image are copied in during idle
 * time after a frame, and the last band generates the mip chain. A texture is only handed out once it is complete.
 */
export class TextureStreamer {
  private readonly jobs: UploadJob[] = [];
  /** Never uploaded itself: carries each band into copyTextureToTexture. */
  private readonly carrier = new THREE.Texture();
  private readonly at = new THREE.Vector2();
  private readonly region = new THREE.Box2();
  private cancelWait: (() => void) | null = null;
  private slicePixels = SLICE_PIXELS[1];
  private running = false;
  private disposed = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  /**
   * Resolves with the complete texture, or with null if the streamer was disposed first; rejects if the upload
   * failed. The image is released in every case.
   */
  upload(image: DecodedImage, opts: ImageTextureOptions): Promise<THREE.Texture | null> {
    if (this.disposed) {
      releaseImage(image);
      return Promise.resolve(null);
    }
    if (typeof ImageBitmap === 'undefined' || !(image instanceof ImageBitmap)) {
      // An <img> (no createImageBitmap) cannot be cropped: upload it in one go.
      const tex = new THREE.Texture(image);
      configure(tex, opts);
      tex.needsUpdate = true;
      try {
        this.renderer.initTexture(tex);
      } catch (err) {
        tex.dispose();
        return Promise.reject(err);
      }
      return Promise.resolve(tex);
    }
    const texture = new THREE.Texture({ width: image.width, height: image.height });
    configure(texture, opts);
    // Allocate the storage on the first use, but transfer nothing: the bands are copied in afterwards.
    texture.source.dataReady = false;
    texture.needsUpdate = true;
    return new Promise((finish, fail) => {
      const rows = Math.max(1, Math.min(image.height, Math.floor(BAND_PIXELS / image.width)));
      this.jobs.push({ image, texture, y: -1, rows, finish, fail });
      void this.run();
    });
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.jobs.length && !this.disposed) {
      const budget = await this.nextSlice();
      if (this.disposed) break;
      const end = performance.now() + Math.min(Math.max(budget - 1, SLICE_MS[0]), SLICE_MS[1]);
      let pixels = 0;
      let blocked = false;
      do {
        const job = this.jobs[0];
        try {
          const moved = await this.step(job);
          pixels += moved.pixels;
          blocked = moved.blocked;
        } catch (err) {
          // A failed upload must not hold up the others.
          if (this.jobs[0] === job) this.jobs.shift();
          releaseImage(job.image);
          job.texture.dispose();
          job.fail(err);
        }
      } while (this.jobs.length && !this.disposed && !blocked && pixels < this.slicePixels && performance.now() < end);
      if (blocked) this.slicePixels = Math.max(SLICE_PIXELS[0], this.slicePixels / 2);
      else if (pixels >= this.slicePixels) this.slicePixels = Math.min(SLICE_PIXELS[2], this.slicePixels + BAND_PIXELS);
    }
    this.running = false;
  }

  /** Resolves with a time budget (ms) in the idle time after the next frame. */
  private nextSlice(): Promise<number> {
    return new Promise((resolve) => {
      let idle = 0;
      let timer = 0;
      const frame = requestAnimationFrame(() => {
        if (typeof requestIdleCallback === 'function') {
          // The timeout keeps uploads going while frames leave no idle time.
          idle = requestIdleCallback((deadline) => resolve(deadline.timeRemaining()), { timeout: 100 });
        } else {
          timer = window.setTimeout(() => resolve(FALLBACK_SLICE_MS), 0);
        }
      });
      this.cancelWait = () => {
        cancelAnimationFrame(frame);
        if (idle) cancelIdleCallback(idle);
        clearTimeout(timer);
        resolve(0);
      };
    });
  }

  /** Advance the first job by one band (or its allocation): the pixels moved, and whether the GPU process lagged. */
  private async step(job: UploadJob): Promise<{ pixels: number; blocked: boolean }> {
    if (job.y < 0) {
      const t0 = performance.now();
      this.renderer.initTexture(job.texture);
      job.texture.generateMipmaps = false;
      job.y = 0;
      return { pixels: 0, blocked: performance.now() - t0 > BLOCKED_MS };
    }
    const { image } = job;
    const rows = Math.min(job.rows, image.height - job.y);
    let band: ImageBitmap | null = null;
    try {
      band = await createImageBitmap(image, 0, job.y, image.width, rows);
    } catch {
      // Cropping failed (memory pressure, say): copy the rows out of the whole image instead, which some engines
      // do by converting the whole image every time.
    }
    if (this.disposed) {
      band?.close();
      return { pixels: 0, blocked: false };
    }
    const last = job.y + rows >= image.height;
    // The whole mip chain is generated once, with the last band.
    job.texture.generateMipmaps = last;
    this.carrier.image = band ?? image;
    if (!band) {
      this.region.min.set(0, job.y);
      this.region.max.set(image.width, job.y + rows);
    }
    const t0 = performance.now();
    this.renderer.copyTextureToTexture(this.carrier, job.texture, band ? null : this.region, this.at.set(0, job.y));
    const blocked = performance.now() - t0 > BLOCKED_MS;
    this.carrier.image = null;
    band?.close();
    job.y += rows;
    if (last) {
      this.jobs.shift();
      releaseImage(image);
      job.finish(job.texture);
    }
    return { pixels: image.width * rows, blocked };
  }

  /** Drop every pending upload: their images are released and their promises resolve with null. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelWait?.();
    for (const job of this.jobs.splice(0)) {
      releaseImage(job.image);
      job.texture.dispose();
      job.finish(null);
    }
  }
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
