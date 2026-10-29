#!/usr/bin/env node
/**
 * Downloads and processes the Earth imagery used by lib/three/earth into public/earth/.
 *
 *   node scripts/fetch-imagery.mjs                 # download what is missing, rebuild public/earth
 *   node scripts/fetch-imagery.mjs --offline       # rebuild from .imagery-cache only
 *   node scripts/fetch-imagery.mjs --patches-only  # skip the (slow) globe textures
 *   node scripts/fetch-imagery.mjs --debug         # also write previews to .imagery-cache/debug
 *
 * Sources (all allow redistribution, see `ATTRIBUTION` below and public/earth/manifest.json):
 *  - NASA Blue Marble Next Generation, July 2004 (public domain): daytime colour (topography + bathymetry
 *    version) and the plain version, whose uniform deep-ocean colour is used to derive the water mask.
 *  - NASA Black Marble 2016 (public domain): night lights.
 *  - Sentinel-2 cloudless 2016 by EOX (CC BY 4.0, WMTS layer `s2cloudless_3857`): high resolution ground
 *    patches around the Starbase launch pads.
 *
 * Downloads are written only into .imagery-cache/ and treated as untrusted data: they are decoded by sharp,
 * never executed. Tile requests are throttled and cached, so re-runs do not hit the servers again.
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.imagery-cache');
const OUT = path.join(ROOT, 'public', 'earth');
const OFFLINE = process.argv.includes('--offline');
const PATCHES_ONLY = process.argv.includes('--patches-only');
const DEBUG = process.argv.includes('--debug');
const USER_AGENT =
  'starship-telemetry-replay/0.1 imagery build script (one-off download for a web visualisation; cached locally, throttled)';

sharp.cache(false);

// ---------------------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------------------

const NASA = {
  dayTopoBathy: {
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73751/world.topo.bathy.200407.3x21600x10800.jpg',
    file: 'nasa/world.topo.bathy.200407.3x21600x10800',
  },
  dayPlain: {
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/world.200407.3x21600x10800.jpg',
    file: 'nasa/world.200407.3x21600x10800',
  },
  night: {
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg',
    file: 'nasa/BlackMarble_2016_3km',
  },
};

/** EOX WMTS, GoogleMapsCompatible tile matrix set "g" (EPSG:3857). `s2cloudless_3857` is the 2016 layer (CC BY 4.0). */
const EOX_LAYER = 's2cloudless_3857';
const EOX_TILE_URL = (z, y, x) => `https://tiles.maps.eox.at/wmts/1.0.0/${EOX_LAYER}/default/g/${z}/${y}/${x}.jpg`;

const ATTRIBUTION = [
  {
    id: 'bmng',
    short: 'NASA',
    text: 'Blue Marble: Next Generation (July 2004, topography and bathymetry), NASA Earth Observatory / Reto Stöckli',
    licence: 'Public domain (NASA imagery; credit requested: "NASA Earth Observatory")',
    urls: [NASA.dayTopoBathy.url, NASA.dayPlain.url],
    usedFor: ['day-4k', 'day-8k', 'mask'],
  },
  {
    id: 'black-marble',
    short: 'NASA',
    text:
      'Black Marble 2016, NASA Earth Observatory images by Joshua Stevens, using Suomi NPP VIIRS data from Miguel Román, NASA Goddard Space Flight Center',
    licence: 'Public domain (NASA imagery; credit requested)',
    urls: [NASA.night.url],
    usedFor: ['night'],
  },
  {
    id: 's2cloudless-2016',
    short: 'Sentinel-2 cloudless 2016 by EOX (CC BY 4.0)',
    text:
      'Sentinel-2 cloudless 2016 by EOX IT Services GmbH (https://s2maps.eu, https://cloudless.eox.at). Contains modified Copernicus Sentinel data 2016. Colour-matched to Blue Marble and reprojected/cropped.',
    licence: 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)',
    urls: [`https://tiles.maps.eox.at/wmts/1.0.0/${EOX_LAYER}/default/g/{z}/{y}/{x}.jpg`, 'https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml'],
    usedFor: ['patch-pad', 'patch-mid', 'patch-wide', 'patch-masks'],
  },
];

/** Centre of the Starbase ground patches: midway between Pad 1 (25.99683, −97.1542) and Pad 2 (25.99545, −97.15565). */
const PATCH_CENTER = { lat: (25.99683 + 25.99545) / 2, lon: (-97.1542 + -97.15565) / 2 };

/**
 * Ground patches. `window` is the square crop in native tile pixels at `zoom`; `size` the output size.
 * pad ≈ 8.8 km, mid ≈ 79 km, wide ≈ 704 km across (at 26° N).
 */
const PATCHES = [
  { id: 'pad', zoom: 15, window: 2048, size: 2048, quality: 84 },
  { id: 'mid', zoom: 12, window: 2304, size: 2048, quality: 84 },
  { id: 'wide', zoom: 9, window: 2560, size: 2560, quality: 84 },
];
const PATCH_MASK_SIZE = 1024;

// ---------------------------------------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Image type from magic bytes; anything else (an error page, say) is rejected and never cached. */
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

/** Cached file for `base` (path without extension), if any. */
function cached(base) {
  for (const ext of ['jpg', 'png']) if (existsSync(`${base}.${ext}`)) return `${base}.${ext}`;
  return null;
}

/** Download `url` to `${base}.jpg|png` (by content). Returns the cached path. */
async function download(url, base, { retries = 3 } = {}) {
  const hit = cached(base);
  if (hit) return hit;
  if (OFFLINE) throw new Error(`--offline and not cached: ${url}`);
  await fs.mkdir(path.dirname(base), { recursive: true });
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const type = imageType(buf);
      if (!type) throw new Error(`not a JPEG/PNG image: ${url}`);
      const dest = `${base}.${type}`;
      await fs.writeFile(`${dest}.part`, buf);
      await fs.rename(`${dest}.part`, dest);
      return dest;
    } catch (err) {
      lastError = err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastError;
}

/** Fetch many tiles with a small concurrency and a minimum spacing between request starts. */
async function downloadTiles(jobs, { concurrency = 3, spacingMs = 120 } = {}) {
  let next = 0;
  let lastStart = 0;
  let fetched = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      job.file = cached(job.base);
      if (job.file) continue;
      const wait = lastStart + spacingMs - Date.now();
      lastStart = Math.max(Date.now(), lastStart + spacingMs);
      if (wait > 0) await sleep(wait);
      job.file = await download(job.url, job.base);
      fetched++;
      if (fetched % 25 === 0) console.log(`  … ${fetched} tiles fetched`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return fetched;
}

// ---------------------------------------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------------------------------------

/** EPSG:3857 (spherical Web Mercator) constants. */
const WM_R = 6378137;
const WM_HALF = Math.PI * WM_R; // 20037508.342789244

const deg = Math.PI / 180;
const mercX = (lonDeg) => WM_R * lonDeg * deg;
const mercY = (latDeg) => WM_R * Math.log(Math.tan(Math.PI / 4 + (latDeg * deg) / 2));
const mercToLon = (x) => x / WM_R / deg;
const mercToLat = (y) => (2 * Math.atan(Math.exp(y / WM_R)) - Math.PI / 2) / deg;

/** Global pixel coordinates (top-left origin) at a zoom level of the GoogleMapsCompatible matrix set. */
function mercToPixel(x, y, zoom) {
  const scale = (256 * 2 ** zoom) / (2 * WM_HALF);
  return [(x + WM_HALF) * scale, (WM_HALF - y) * scale];
}
function pixelToMerc(px, py, zoom) {
  const scale = (2 * WM_HALF) / (256 * 2 ** zoom);
  return [px * scale - WM_HALF, WM_HALF - py * scale];
}

// ---------------------------------------------------------------------------------------------------------
// Pixel helpers
// ---------------------------------------------------------------------------------------------------------

const srgbToLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb8 = (l) => {
  const c = Math.min(Math.max(l, 0), 1);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
};
const SRGB_LUT = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i));
const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

async function rawRgb(input, width, height) {
  const { data, info } = await sharp(input, { limitInputPixels: false })
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error('expected RGB');
  return data;
}

async function fileInfo(file) {
  const st = await fs.stat(path.join(OUT, file));
  return { file, bytes: st.size };
}

// ---------------------------------------------------------------------------------------------------------
// Globe textures
// ---------------------------------------------------------------------------------------------------------

/**
 * Water fraction of a Blue Marble pixel from the topo-bathy (`tb`) and plain (`pl`) mosaics. The two are identical
 * on land (bar relief shading); over the sea the topo-bathy version is coloured by depth while the plain one keeps
 * the observed, dark water colour, so the blue-channel difference marks seas. Lakes (no bathymetry) are caught as
 * dark, blue-leaning pixels of the plain mosaic.
 */
function bmWater(tb, pl, p) {
  const ocean = smoothstep(4, 18, tb[p + 2] - pl[p + 2]);
  const r = pl[p];
  const g = pl[p + 1];
  const b = pl[p + 2];
  const lake = r < 20 && b >= r + 4 && b >= g - 20 && r + g + b < 75 ? 1 : 0;
  return Math.max(ocean, lake);
}

async function buildGlobe() {
  const dayTB = await download(NASA.dayTopoBathy.url, path.join(CACHE, NASA.dayTopoBathy.file));
  const dayPlain = await download(NASA.dayPlain.url, path.join(CACHE, NASA.dayPlain.file));
  const night = await download(NASA.night.url, path.join(CACHE, NASA.night.file));

  // Day colour: land from the topo-bathy mosaic (relief shading), water from the plain mosaic, whose observed
  // water colour (dark deep ocean, turquoise shallow banks) is a far better albedo than the bathymetry colour ramp.
  console.log('globe: day colour + water mask');
  const W = 8192;
  const H = 4096;
  const tb = await rawRgb(dayTB, W, H);
  const pl = await rawRgb(dayPlain, W, H);
  const mask = Buffer.alloc(W * H);
  const day = Buffer.alloc(W * H * 3);
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    const w = bmWater(tb, pl, p);
    mask[i] = Math.round(255 * w);
    for (let c = 0; c < 3; c++) day[p + c] = linearToSrgb8(SRGB_LUT[tb[p + c]] * (1 - w) + SRGB_LUT[pl[p + c]] * w);
  }
  await sharp(day, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toFile(path.join(OUT, 'day-8k.jpg'));
  await sharp(day, { raw: { width: W, height: H, channels: 3 } })
    .resize(4096, 2048, { kernel: 'lanczos3', fit: 'fill' })
    .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toFile(path.join(OUT, 'day-4k.jpg'));
  await sharp(mask, { raw: { width: W, height: H, channels: 1 } })
    .resize(4096, 2048, { kernel: 'cubic', fit: 'fill' })
    .png({ compressionLevel: 9, palette: false })
    .toFile(path.join(OUT, 'water-4k.png'));

  // Night lights: Black Marble's moonlit base map is blue-dominated (R ≈ 0.45–0.6 B) while artificial light is
  // warm white (R ≥ B), so R − 0.66 B isolates the lights. Stored as one channel; the shader tints it.
  console.log('globe: night lights');
  const NW = 4096;
  const NH = 2048;
  const n = await rawRgb(night, NW, NH);
  const lights = Buffer.alloc(NW * NH);
  for (let i = 0, p = 0; i < lights.length; i++, p += 3) {
    const l = Math.min(1, Math.max(0, n[p] - 0.66 * n[p + 2] - 4) / (255 * 0.36));
    lights[i] = Math.round(255 * l ** 0.9);
  }
  await sharp(lights, { raw: { width: NW, height: NH, channels: 1 } })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(path.join(OUT, 'night-4k.jpg'));
}

// ---------------------------------------------------------------------------------------------------------
// Starbase ground patches (Sentinel-2 cloudless 2016)
// ---------------------------------------------------------------------------------------------------------

function patchGeometry(spec) {
  const [cx, cy] = mercToPixel(mercX(PATCH_CENTER.lon), mercY(PATCH_CENTER.lat), spec.zoom);
  const x0 = Math.round(cx - spec.window / 2);
  const y0 = Math.round(cy - spec.window / 2);
  const x1 = x0 + spec.window;
  const y1 = y0 + spec.window;
  const [mx0, my1] = pixelToMerc(x0, y0, spec.zoom); // top-left: west / north
  const [mx1, my0] = pixelToMerc(x1, y1, spec.zoom); // bottom-right: east / south
  return { x0, y0, x1, y1, mercator: { xmin: mx0, ymin: my0, xmax: mx1, ymax: my1 } };
}

async function stitchPatch(spec) {
  const g = patchGeometry(spec);
  const tx0 = Math.floor(g.x0 / 256);
  const ty0 = Math.floor(g.y0 / 256);
  const tx1 = Math.floor((g.x1 - 1) / 256);
  const ty1 = Math.floor((g.y1 - 1) / 256);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push({
        tx,
        ty,
        url: EOX_TILE_URL(spec.zoom, ty, tx),
        base: path.join(CACHE, 'eox', EOX_LAYER, String(spec.zoom), String(ty), String(tx)),
        file: null,
      });
    }
  }
  console.log(`patch ${spec.id}: zoom ${spec.zoom}, ${jobs.length} tiles`);
  const fetched = await downloadTiles(jobs);
  if (fetched) console.log(`  fetched ${fetched} new tiles`);

  const W = (tx1 - tx0 + 1) * 256;
  const H = (ty1 - ty0 + 1) * 256;
  const mosaic = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(jobs.map((j) => ({ input: j.file, left: (j.tx - tx0) * 256, top: (j.ty - ty0) * 256 })))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      if (info.channels !== 3 || info.width !== W || info.height !== H) throw new Error('unexpected mosaic layout');
      return data;
    });
  const cropped = await sharp(mosaic, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left: g.x0 - tx0 * 256, top: g.y0 - ty0 * 256, width: spec.window, height: spec.window })
    .resize(spec.size, spec.size, { kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  if (DEBUG) {
    await fs.mkdir(path.join(CACHE, 'debug'), { recursive: true });
    await sharp(cropped, { raw: { width: spec.size, height: spec.size, channels: 3 } })
      .resize(1024)
      .png()
      .toFile(path.join(CACHE, 'debug', `raw-${spec.id}.png`));
  }
  return { ...g, rgb: cropped, tiles: jobs.length };
}

/**
 * Blue Marble around the patches at native resolution: linear land colour (topo-bathy) and a smooth water colour
 * field (plain mosaic), where the water colour is a normalised convolution blur(colour·w)/blur(w) so coastal pixels
 * that mix land and sea in Blue Marble do not tint the patch water brown.
 */
async function blueMarbleRegion(merc, marginDeg) {
  const dayTB = cached(path.join(CACHE, NASA.dayTopoBathy.file));
  const dayPlain = cached(path.join(CACHE, NASA.dayPlain.file));
  if (!dayTB || !dayPlain) throw new Error('Blue Marble mosaics missing from the cache; run without --patches-only first');
  const meta = await sharp(dayTB, { limitInputPixels: false }).metadata();
  const lonW = mercToLon(merc.xmin) - marginDeg;
  const lonE = mercToLon(merc.xmax) + marginDeg;
  const latN = mercToLat(merc.ymax) + marginDeg;
  const latS = mercToLat(merc.ymin) - marginDeg;
  const left = Math.floor(((lonW + 180) / 360) * meta.width);
  const top = Math.floor(((90 - latN) / 180) * meta.height);
  const w = Math.ceil(((lonE + 180) / 360) * meta.width) - left;
  const h = Math.ceil(((90 - latS) / 180) * meta.height) - top;
  const crop = (file) =>
    sharp(file, { limitInputPixels: false }).extract({ left, top, width: w, height: h }).removeAlpha().raw().toBuffer();
  const tb = await crop(dayTB);
  const pl = await crop(dayPlain);

  const n = w * h;
  const water = new Float32Array(n);
  const land = new Float32Array(n * 3);
  const num = new Float32Array(n * 3);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const wt = bmWater(tb, pl, p);
    water[i] = wt;
    for (let c = 0; c < 3; c++) {
      land[p + c] = SRGB_LUT[tb[p + c]];
      num[p + c] = SRGB_LUT[pl[p + c]] * wt;
    }
  }
  // Separable box blur (radius 4 px ≈ 7 km) of colour·w and w.
  const R = 4;
  const blur = (src, ch) => {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < ch; c++) {
          let acc = 0;
          for (let k = -R; k <= R; k++) acc += src[(y * w + Math.min(w - 1, Math.max(0, x + k))) * ch + c];
          tmp[(y * w + x) * ch + c] = acc;
        }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < ch; c++) {
          let acc = 0;
          for (let k = -R; k <= R; k++) acc += tmp[(Math.min(h - 1, Math.max(0, y + k)) * w + x) * ch + c];
          out[(y * w + x) * ch + c] = acc;
        }
    return out;
  };
  const numB = blur(num, 3);
  const denB = blur(water, 1);
  let mean = [0, 0, 0];
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    wsum += water[i];
    for (let c = 0; c < 3; c++) mean[c] += num[i * 3 + c];
  }
  mean = mean.map((v) => v / Math.max(wsum, 1e-6));
  const waterColour = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const d = denB[i];
    const t = smoothstep(0.02, 0.5, d); // fall back to the regional mean far from any water
    for (let c = 0; c < 3; c++) waterColour[i * 3 + c] = (d > 1e-6 ? numB[i * 3 + c] / d : mean[c]) * t + mean[c] * (1 - t);
  }

  /** Bilinear sample of a field at lat/lon (degrees). */
  const sample = (field, ch, lat, lon, out) => {
    const fx = ((lon + 180) / 360) * meta.width - left - 0.5;
    const fy = ((90 - lat) / 180) * meta.height - top - 0.5;
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(h - 2, Math.floor(fy)));
    const wx = Math.min(Math.max(fx - x0, 0), 1);
    const wy = Math.min(Math.max(fy - y0, 0), 1);
    for (let c = 0; c < ch; c++) {
      const i00 = (y0 * w + x0) * ch + c;
      const i01 = ((y0 + 1) * w + x0) * ch + c;
      out[c] =
        (field[i00] * (1 - wx) + field[i00 + ch] * wx) * (1 - wy) + (field[i01] * (1 - wx) + field[i01 + ch] * wx) * wy;
    }
    return out;
  };
  // Fraction of water within ±R px (≈ ±7 km): gates S2 water detection to the vicinity of known water.
  const near = denB.map((v) => v / (2 * R + 1) ** 2);
  return {
    land: (lat, lon, out) => sample(land, 3, lat, lon, out),
    water: (lat, lon, out) => sample(waterColour, 3, lat, lon, out),
    waterFraction: (lat, lon, out) => sample(water, 1, lat, lon, out),
    waterNearby: (lat, lon, out) => sample(near, 1, lat, lon, out),
  };
}

/**
 * Water in a Sentinel-2 cloudless patch (8-bit sRGB): open and coastal water is blue-leaning (B > R) and not bright;
 * soil, vegetation, sand and surf are not. The layer's open-ocean fill colour (24, 44, 78) is water too.
 */
function s2Water(r, g, b) {
  const fill = Math.abs(r - 24) + Math.abs(g - 44) + Math.abs(b - 78) < 14 ? 1 : 0;
  const w = smoothstep(3, 14, b - r) * (1 - smoothstep(150, 190, g));
  return Math.max(w, fill);
}

/**
 * Patch water: S2 colour test, trusted only near water Blue Marble knows about (so dark vegetation inland is not
 * flooded); well offshore everything is water (hides the cloud-mask mosaic of the S2 sea).
 */
function patchWater(bm, rgb, p, lat, lon, tmp) {
  const nearby = bm.waterNearby(lat, lon, tmp)[0];
  const s2 = s2Water(rgb[p], rgb[p + 1], rgb[p + 2]);
  const fill = Math.abs(rgb[p] - 24) + Math.abs(rgb[p + 1] - 44) + Math.abs(rgb[p + 2] - 78) < 14 ? 1 : 0;
  return Math.max(fill, s2 * smoothstep(0.03, 0.2, nearby), smoothstep(0.93, 0.995, nearby));
}

async function buildPatches(manifest) {
  const results = [];
  for (const spec of PATCHES) results.push({ spec, ...(await stitchPatch(spec)) });
  const wide = results.find((r) => r.spec.id === 'wide');
  const bm = await blueMarbleRegion(wide.mercator, 0.5);

  const pixelLatLon = (r, i, j) => {
    const m = r.mercator;
    const size = r.spec.size;
    return [
      mercToLat(m.ymax - ((j + 0.5) / size) * (m.ymax - m.ymin)),
      mercToLon(m.xmin + ((i + 0.5) / size) * (m.xmax - m.xmin)),
    ];
  };

  // Colour transfer S2 → Blue Marble: per-channel gain on linear land colour, estimated on the wide patch where the
  // two overlap over hundreds of km (water excluded: the products render water differently).
  const sumS2 = [0, 0, 0];
  const sumBM = [0, 0, 0];
  {
    const size = wide.spec.size;
    const tmp = [0, 0, 0];
    const wf = [0];
    for (let j = 0; j < size; j += 4)
      for (let i = 0; i < size; i += 4) {
        const p = (j * size + i) * 3;
        const [lat, lon] = pixelLatLon(wide, i, j);
        if (patchWater(bm, wide.rgb, p, lat, lon, wf) > 0.01) continue;
        if (bm.waterFraction(lat, lon, wf)[0] > 0.01) continue;
        bm.land(lat, lon, tmp);
        for (let c = 0; c < 3; c++) {
          sumS2[c] += SRGB_LUT[wide.rgb[p + c]];
          sumBM[c] += tmp[c];
        }
      }
  }
  const gain = sumS2.map((v, c) => (v > 0 ? sumBM[c] / v : 1));
  console.log('S2 → BMNG land colour gain (linear):', gain.map((g) => g.toFixed(3)).join(' '));

  const maskChannels = [];
  for (const r of results) {
    const { spec } = r;
    const size = spec.size;
    const out = Buffer.alloc(size * size * 3);
    const water8 = Buffer.alloc(size * size);
    const wc = [0, 0, 0];
    const wf = [0];
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const k = j * size + i;
        const p = k * 3;
        const [lat, lon] = pixelLatLon(r, i, j);
        const w = patchWater(bm, r.rgb, p, lat, lon, wf);
        water8[k] = Math.round(w * 255);
        if (w > 0) bm.water(lat, lon, wc);
        for (let c = 0; c < 3; c++) {
          const landLin = SRGB_LUT[r.rgb[p + c]] * gain[c];
          out[p + c] = linearToSrgb8(w > 0 ? landLin * (1 - w) + wc[c] * w : landLin);
        }
      }
    const file = `patch-${spec.id}.jpg`;
    await sharp(out, { raw: { width: size, height: size, channels: 3 } })
      .jpeg({ quality: spec.quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toFile(path.join(OUT, file));
    if (DEBUG) {
      await sharp(out, { raw: { width: size, height: size, channels: 3 } })
        .resize(1024)
        .png()
        .toFile(path.join(CACHE, 'debug', `final-${spec.id}.png`));
    }
    const { data: maskData, info: maskInfo } = await sharp(water8, { raw: { width: size, height: size, channels: 1 } })
      .resize(PATCH_MASK_SIZE, PATCH_MASK_SIZE, { kernel: 'cubic' })
      .extractChannel(0)
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (maskInfo.channels !== 1 || maskData.length !== PATCH_MASK_SIZE * PATCH_MASK_SIZE) throw new Error('mask layout');
    maskChannels.push(maskData);

    const m = r.mercator;
    const centerLat = mercToLat((m.ymin + m.ymax) / 2);
    manifest.patches.push({
      id: spec.id,
      ...(await fileInfo(file)),
      width: size,
      height: size,
      zoom: spec.zoom,
      tiles: r.tiles,
      projection:
        'EPSG:3857 spherical Web Mercator (R = 6378137 m): x = R·lon, y = R·ln(tan(π/4 + lat/2)). u is linear in x from xmin (u = 0, west edge) to xmax; v is linear in y from ymax (v = 0, first/top row, north edge) to ymin.',
      mercator: { xmin: m.xmin, ymin: m.ymin, xmax: m.xmax, ymax: m.ymax },
      bounds: { west: mercToLon(m.xmin), south: mercToLat(m.ymin), east: mercToLon(m.xmax), north: mercToLat(m.ymax) },
      center: { lat: centerLat, lon: mercToLon((m.xmin + m.xmax) / 2) },
      groundMetresPerPixel: ((m.xmax - m.xmin) / size) * Math.cos(centerLat * deg),
      colourGain: gain,
      waterChannel: ['r', 'g', 'b'][maskChannels.length - 1],
      note: 'Water pixels replaced with the Blue Marble water colour so patches blend into the globe.',
      attribution: 's2cloudless-2016',
    });
  }

  const packed = Buffer.alloc(PATCH_MASK_SIZE * PATCH_MASK_SIZE * 3);
  for (let i = 0; i < PATCH_MASK_SIZE * PATCH_MASK_SIZE; i++)
    for (let c = 0; c < 3; c++) packed[i * 3 + c] = maskChannels[c][i];
  await sharp(packed, { raw: { width: PATCH_MASK_SIZE, height: PATCH_MASK_SIZE, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT, 'patch-water.png'));
  manifest.patchWater = {
    ...(await fileInfo('patch-water.png')),
    width: PATCH_MASK_SIZE,
    height: PATCH_MASK_SIZE,
    channels: 'water fraction: r = pad, g = mid, b = wide; each channel spans its own patch footprint (same u/v as the patch)',
    attribution: 's2cloudless-2016',
  };
}

// ---------------------------------------------------------------------------------------------------------

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await fs.mkdir(CACHE, { recursive: true });

  const manifest = {
    version: 1,
    generated: new Date().toISOString(),
    globe: {},
    patches: [],
    patchWater: null,
    attribution: ATTRIBUTION,
    creditLine: 'Imagery NASA · Sentinel-2 cloudless 2016 by EOX (CC BY 4.0)',
  };

  if (!PATCHES_ONLY) await buildGlobe();
  const equirect =
    'Equirectangular (plate carrée) on WGS84 latitude/longitude, pixel-is-area: u = (lon + 180°) / 360°, v = (90° − lat) / 180° (first/top row at 90° N, first column at 180° W).';
  manifest.globe = {
    projection: equirect,
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    day: [
      { quality: 'low', ...(await fileInfo('day-4k.jpg')), width: 4096, height: 2048, attribution: 'bmng' },
      { quality: 'high', ...(await fileInfo('day-8k.jpg')), width: 8192, height: 4096, attribution: 'bmng' },
    ],
    night: { ...(await fileInfo('night-4k.jpg')), width: 4096, height: 2048, channels: 'grey: artificial light intensity', attribution: 'black-marble' },
    water: { ...(await fileInfo('water-4k.png')), width: 4096, height: 2048, channels: 'grey: water fraction (1 = water)', attribution: 'bmng' },
  };

  await buildPatches(manifest);

  await fs.writeFile(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  let total = 0;
  for (const f of await fs.readdir(OUT)) total += (await fs.stat(path.join(OUT, f))).size;
  console.log(`public/earth: ${(total / 1e6).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
