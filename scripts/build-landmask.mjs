#!/usr/bin/env node
/**
 * Builds the simulator's land/sea mask (lib/sim/data/landmask.json) from the water masks the imagery script
 * already derived (public/earth/water-4k.png for the globe, the 'mid' and 'wide' channels of patch-water.png
 * around Starbase). The simulator uses it to tell a splashdown from a touchdown on land.
 *
 *   node scripts/build-landmask.mjs
 *
 * Each grid stores, row by row from the north, run lengths of alternating sea and land cells (starting with
 * sea) as unsigned LEB128 varints, base64 encoded. A cell is land when less than half of it is water.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EARTH = path.join(ROOT, 'public', 'earth');
const OUT = path.join(ROOT, 'lib', 'sim', 'data', 'landmask.json');

/** Globe cells per degree, and the finer cells of the Starbase patches (finest first). */
const GLOBAL_PER_DEG = 4;
const PATCHES = [
  { id: 'mid', channel: 1, perDeg: 256 },
  { id: 'wide', channel: 2, perDeg: 32 },
];
const R_MERC = 6_378_137;

async function grey(file, channel) {
  const { data, info } = await sharp(path.join(EARTH, file)).raw().toBuffer({ resolveWithObject: true });
  const out = new Float32Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels + channel] / 255;
  return { w: info.width, h: info.height, px: out };
}

function varint(bytes, v) {
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
}

/** Run-length encodes a land grid (Uint8Array, 1 = land), row by row. */
function encode(cells, w, h) {
  const bytes = [];
  for (let y = 0; y < h; y++) {
    let cur = 0;
    let run = 0;
    for (let x = 0; x < w; x++) {
      const v = cells[y * w + x];
      if (v === cur) run++;
      else {
        varint(bytes, run);
        cur = v;
        run = 1;
      }
    }
    varint(bytes, run);
  }
  return Buffer.from(bytes).toString('base64');
}

/** Mean water fraction over a lat/lon cell, sampling `src(lat, lon)` on an n × n grid inside it. */
function cellWater(src, lat0, lon0, size, n) {
  let s = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) s += src(lat0 + ((j + 0.5) / n) * size, lon0 + ((i + 0.5) / n) * size);
  return s / (n * n);
}

async function main() {
  // Globe: plate carrée, first row at 90° N, first column at 180° W.
  const g = await grey('water-4k.png', 0);
  const globe = (lat, lon) => {
    const x = Math.min(g.w - 1, Math.max(0, Math.floor(((lon + 180) / 360) * g.w)));
    const y = Math.min(g.h - 1, Math.max(0, Math.floor(((90 - lat) / 180) * g.h)));
    return g.px[y * g.w + x];
  };
  const gw = 360 * GLOBAL_PER_DEG, gh = 180 * GLOBAL_PER_DEG;
  const gCells = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const lat0 = 90 - (y + 1) / GLOBAL_PER_DEG, lon0 = -180 + x / GLOBAL_PER_DEG;
      gCells[y * gw + x] = cellWater(globe, lat0, lon0, 1 / GLOBAL_PER_DEG, 4) < 0.5 ? 1 : 0;
    }
  }

  // Starbase patches (Web Mercator), resampled onto lat/lon cells.
  const manifest = JSON.parse(readFileSync(path.join(EARTH, 'manifest.json'), 'utf8'));
  const regions = [];
  for (const spec of PATCHES) {
    const patch = manifest.patches.find((p) => p.id === spec.id);
    const pw = await grey(manifest.patchWater.file, spec.channel);
    const m = patch.mercator;
    const sample = (lat, lon) => {
      const mx = (R_MERC * lon * Math.PI) / 180;
      const my = R_MERC * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
      const x = Math.min(pw.w - 1, Math.max(0, Math.floor(((mx - m.xmin) / (m.xmax - m.xmin)) * pw.w)));
      const y = Math.min(pw.h - 1, Math.max(0, Math.floor(((m.ymax - my) / (m.ymax - m.ymin)) * pw.h)));
      return pw.px[y * pw.w + x];
    };
    // Whole cells inside the patch footprint.
    const k = spec.perDeg;
    const west = Math.ceil(patch.bounds.west * k) / k;
    const east = Math.floor(patch.bounds.east * k) / k;
    const south = Math.ceil(patch.bounds.south * k) / k;
    const north = Math.floor(patch.bounds.north * k) / k;
    const w = Math.round((east - west) * k), h = Math.round((north - south) * k);
    const cells = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) cells[y * w + x] = cellWater(sample, north - (y + 1) / k, west + x / k, 1 / k, 4) < 0.5 ? 1 : 0;
    }
    regions.push({ west, north, perDeg: k, w, h, runs: encode(cells, w, h) });
  }

  const out = {
    source: 'Derived by scripts/build-landmask.mjs from public/earth water masks (NASA Blue Marble; Sentinel-2 cloudless 2016 by EOX around Starbase).',
    globe: { west: -180, north: 90, perDeg: GLOBAL_PER_DEG, w: gw, h: gh, runs: encode(gCells, gw, gh) },
    regions,
  };
  writeFileSync(OUT, JSON.stringify(out) + '\n');
  const land = (c) => c.reduce((a, v) => a + v, 0) / c.length;
  console.log(`globe ${gw}×${gh} (${(land(gCells) * 100).toFixed(1)}% land), ${regions.map((r) => `${r.w}×${r.h}`).join(' + ')}; ${(JSON.stringify(out).length / 1024).toFixed(1)} KB`);
}

await main();
