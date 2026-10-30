import maskData from './data/landmask.json';

/**
 * Coarse land/sea mask (see scripts/build-landmask.mjs): quarter-degree cells over the globe and 1/32°
 * cells around Starbase, where boosters come down a few kilometres off the beach.
 */
interface Grid {
  west: number;
  north: number;
  perDeg: number;
  w: number;
  h: number;
  runs: string;
}

interface MaskFile {
  globe: Grid;
  regions: Grid[];
}

interface Bits {
  g: Grid;
  bits: Uint8Array; // 1 bit per cell, row-major from the north-west corner
}

let decoded: { globe: Bits; regions: Bits[] } | null = null;

function base64Bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Expands a grid's run lengths (alternating sea/land from the start of each row) into a bitmap. */
function decode(g: Grid): Bits {
  const bytes = base64Bytes(g.runs);
  const bits = new Uint8Array(Math.ceil((g.w * g.h) / 8));
  let p = 0;
  for (let y = 0; y < g.h; y++) {
    let x = 0;
    let land = false;
    while (x < g.w) {
      let run = 0;
      let shift = 0;
      let c: number;
      do {
        c = bytes[p++];
        run |= (c & 0x7f) << shift;
        shift += 7;
      } while (c & 0x80);
      if (land) for (let k = y * g.w + x, end = k + run; k < end; k++) bits[k >> 3] |= 1 << (k & 7);
      x += run;
      land = !land;
    }
  }
  return { g, bits };
}

function lookup(b: Bits, lat: number, lon: number): boolean | null {
  const g = b.g;
  const x = Math.floor((lon - g.west) * g.perDeg);
  const y = Math.floor((g.north - lat) * g.perDeg);
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) return null;
  const k = y * g.w + x;
  return (b.bits[k >> 3] & (1 << (k & 7))) !== 0;
}

/** True if the point (degrees) is on land rather than at sea. */
export function isLand(lat: number, lon: number): boolean {
  if (!decoded) {
    const m = maskData as MaskFile;
    decoded = { globe: decode(m.globe), regions: m.regions.map(decode) };
  }
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  for (const r of decoded.regions) {
    const v = lookup(r, lat, l);
    if (v !== null) return v;
  }
  return lookup(decoded.globe, Math.max(-89.999, Math.min(89.999, lat)), l) ?? false;
}
