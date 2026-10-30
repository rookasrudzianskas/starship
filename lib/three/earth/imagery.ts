import type { Quality } from '@/lib/three/contracts';

/**
 * Earth imagery: the manifest written by scripts/fetch-imagery.mjs, downloads and decoding. Shared by the prefetch
 * (prefetch.ts, which the replay page imports eagerly) and the Earth itself, so it must stay free of three.js.
 */

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

/** Globe day colour levels: a small preview for the opening view, the 4K ('low') and the 8K ('high'). */
export type DayLevel = 'preview' | Quality;

export interface EarthManifest {
  version: number;
  globe: {
    projection: string;
    day: Array<ManifestImage & { quality: DayLevel }>;
    night: ManifestImage;
    water: ManifestImage;
  };
  patches: PatchManifest[];
  patchWater: ManifestImage | null;
  attribution: AttributionEntry[];
  creditLine: string;
}

export type DecodedImage = ImageBitmap | HTMLImageElement;

/** The day texture for a level, falling back to the 4K when the manifest has no such file. */
export function dayImage(m: EarthManifest, level: DayLevel): ManifestImage & { quality: DayLevel } {
  const find = (q: DayLevel) => m.globe.day.find((d) => d.quality === q);
  return find(level) ?? find('low') ?? m.globe.day[0];
}

/** What the opening view needs (the Earth's `ready` waits for exactly these): the ground around the pad, a small globe. */
export function openingImages(m: EarthManifest): string[] {
  const files = m.patches.map((p) => p.file);
  if (m.patchWater) files.push(m.patchWater.file);
  files.push(dayImage(m, 'preview').file);
  return files;
}

/** What follows straight after: the full-resolution globe colour, water and city lights. */
export function followUpImages(m: EarthManifest): string[] {
  const files = [dayImage(m, 'low').file, m.globe.water.file, m.globe.night.file];
  return files.filter((f, i) => files.indexOf(f) === i && f !== dayImage(m, 'preview').file);
}

let manifestRequest: Promise<EarthManifest> | null = null;
let manifestLoaded: EarthManifest | null = null;

/** The manifest if it has already arrived (say, through the prefetch), so the Earth can build on it synchronously. */
export function loadedManifest(): EarthManifest | null {
  return manifestLoaded;
}

/** The imagery manifest, fetched once per page (after a failure, the next call tries again). */
export function loadManifest(): Promise<EarthManifest> {
  if (!manifestRequest) {
    const request = fetch(`${EARTH_ASSET_BASE}manifest.json`).then(async (res) => {
      if (!res.ok) throw new Error(`Earth manifest: HTTP ${res.status}`);
      manifestLoaded = (await res.json()) as EarthManifest;
      return manifestLoaded;
    });
    manifestRequest = request;
    request.catch(() => {
      if (manifestRequest === request) manifestRequest = null;
    });
  }
  return manifestRequest;
}

/** Decode off the main thread where possible; older engines reject the options or lack createImageBitmap. */
async function decodeImage(blob: Blob): Promise<DecodedImage> {
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

/** Free a decoded image's pixels once they are on the GPU (or no longer wanted). */
export function releaseImage(image: DecodedImage): void {
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
}

async function download(file: string, signal?: AbortSignal): Promise<Blob> {
  const url = `${EARTH_ASSET_BASE}${file}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.blob();
}

interface Prefetched {
  blob: Promise<Blob>;
  /** Decoded pixels, when decoding was asked for up front. */
  image: Promise<DecodedImage> | null;
  expiry: ReturnType<typeof setTimeout> | null;
}

/** A prefetch no Earth has taken after this long is dropped: decoded pixels take 4 bytes per texel. */
const PREFETCH_TTL_MS = 30_000;

const prefetched = new Map<string, Prefetched>();
/** Files an Earth is downloading itself, so a late prefetch does not fetch them a second time. */
const loading = new Set<string>();

function drop(file: string, entry: Prefetched): void {
  if (prefetched.get(file) !== entry) return;
  prefetched.delete(file);
  entry.image?.then(releaseImage, () => {});
}

/**
 * Start downloading an image ahead of the Earth, and with `decode` decoding it too, unless that is already under
 * way. Resolves (never rejects) once the download has finished, whether or not an Earth has taken it meanwhile.
 */
export function prefetchImage(file: string, decode: boolean): Promise<void> {
  const current = prefetched.get(file);
  if (current) return current.blob.then(
    () => {},
    () => {},
  );
  if (loading.has(file)) return Promise.resolve();
  const blob = download(file);
  const entry: Prefetched = { blob, image: decode ? blob.then(decodeImage) : null, expiry: null };
  prefetched.set(file, entry);
  (entry.image ?? blob).then(
    () => {
      if (prefetched.get(file) === entry) entry.expiry = setTimeout(() => drop(file, entry), PREFETCH_TTL_MS);
    },
    () => {
      if (prefetched.get(file) === entry) prefetched.delete(file);
    },
  );
  return blob.then(
    () => {},
    () => {},
  );
}

/**
 * Download and decode an image, taking over its prefetch if there is one. Each call hands out its own decoded image:
 * the caller uploads it and then frees it with releaseImage. A prefetch already under way cannot be aborted, so
 * check for cancellation after awaiting.
 */
export function loadImage(file: string, signal?: AbortSignal): Promise<DecodedImage> {
  const entry = prefetched.get(file);
  if (entry) {
    prefetched.delete(file);
    if (entry.expiry !== null) clearTimeout(entry.expiry);
    return entry.image ?? entry.blob.then(decodeImage);
  }
  loading.add(file);
  const request = download(file, signal).then(decodeImage);
  const done = () => loading.delete(file);
  request.then(done, done);
  return request;
}
