import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Geometry builders for the vehicle hulls. Every skin geometry carries:
 * - position / normal (object space, metres)
 * - uv: steel texture coordinates in metres (u = arc length around the hull, v = height)
 * - aTile: vec4(tileU, tileV, rRef, kind) for the procedural hexagonal heat-shield tiles:
 *   tileU = θ·rRef (θ measured from +Z towards +X), tileV = arc length along the profile,
 *   rRef = radius whose circumference holds a whole number of tiles (so the hex grid closes up),
 *   kind 0 = bare steel, 1 = tiled where the cell lies inside the windward tile boundary, 2 = always tiled.
 *
 * Azimuth convention: θ = 0 on +Z (belly / tower side), x = r·sinθ, z = r·cosθ.
 */

export const TILE_WIDTH = 0.32;

export interface ProfilePoint {
  y: number;
  r: number;
  /** Duplicate this ring so the normal is discontinuous (hard edge). */
  crease?: boolean;
}

export interface LatheOptions {
  segments: number;
  thetaStart?: number;
  thetaLength?: number;
  /** Tile kind written to aTile.w (0 steel, 1 analytic windward boundary, 2 always tiled). */
  tileKind?: number;
  /** Arc-length offset added to tileV (keeps the hex rows continuous across separate pieces). */
  sOffset?: number;
  /** Re-band the tile grid when the radius changes by more than this fraction (cones / nose). */
  bandTolerance?: number;
  /** Flip faces inwards (for interiors). */
  inward?: boolean;
  /**
   * Leave a rectangular opening: faces between the rings at y0 and y1 (both must be profile rings) whose
   * centres lie within halfAngle of the azimuth `theta` are skipped. The cut follows whole segments, so
   * pick halfAngle as a multiple of the segment angle (2π / segments).
   */
  hole?: { y0: number; y1: number; theta: number; halfAngle: number };
}

interface Ring {
  y: number;
  r: number;
  ny: number;
  nr: number;
  s: number;
}

/** Surface of revolution about +Y from a (y, r) profile, bottom to top. */
export function lathe(profile: ProfilePoint[], o: LatheOptions): THREE.BufferGeometry {
  const seg = o.segments;
  const t0 = o.thetaStart ?? -Math.PI;
  const tl = o.thetaLength ?? Math.PI * 2;
  const kind = o.tileKind ?? 0;
  const tol = o.bandTolerance ?? 0.045;

  // Arc length along the profile.
  const sArr: number[] = [0];
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    sArr.push(sArr[i - 1] + Math.hypot(b.y - a.y, b.r - a.r));
  }
  const segNormal = (i: number): [number, number] => {
    const a = profile[i];
    const b = profile[i + 1];
    const dy = b.y - a.y;
    const dr = b.r - a.r;
    const len = Math.hypot(dy, dr) || 1;
    return [dy / len, -dr / len]; // (radial, vertical)
  };

  // Rings with normals (creases duplicated).
  const rings: Ring[] = [];
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    const s = sArr[i] + (o.sOffset ?? 0);
    const prev = i > 0 ? segNormal(i - 1) : null;
    const next = i < profile.length - 1 ? segNormal(i) : null;
    if (p.crease && prev && next) {
      rings.push({ y: p.y, r: p.r, nr: prev[0], ny: prev[1], s });
      rings.push({ y: p.y, r: p.r, nr: next[0], ny: next[1], s });
    } else {
      const a = prev ?? next ?? [1, 0];
      const b = next ?? prev ?? [1, 0];
      let nr = a[0] + b[0];
      let ny = a[1] + b[1];
      const l = Math.hypot(nr, ny) || 1;
      nr /= l;
      ny /= l;
      rings.push({ y: p.y, r: p.r, nr, ny, s });
    }
  }

  // Tile bands: rRef is constant within a band and gives an integer number of tiles round the hull.
  const rRefOf = (r: number) => {
    const n = Math.max(6, Math.round((2 * Math.PI * Math.max(r, 0.05)) / TILE_WIDTH));
    return (n * TILE_WIDTH) / (2 * Math.PI);
  };
  const bandRef: number[] = [];
  const bandStart: boolean[] = [];
  let curRef = rRefOf(rings[0].r);
  for (let i = 0; i < rings.length; i++) {
    const want = rRefOf(rings[i].r);
    const start = i === 0 || Math.abs(want - curRef) / curRef > tol;
    if (start) curRef = want;
    bandRef.push(curRef);
    bandStart.push(start && i > 0);
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tiles: number[] = [];
  const index: number[] = [];
  const cols = seg + 1;
  let rowBase = 0;

  const emitRow = (ring: Ring, rRef: number) => {
    const start = positions.length / 3;
    for (let j = 0; j <= seg; j++) {
      const th = t0 + (tl * j) / seg;
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      positions.push(ring.r * sn, ring.y, ring.r * cs);
      const sign = o.inward ? -1 : 1;
      normals.push(ring.nr * sn * sign, ring.ny * sign, ring.nr * cs * sign);
      uvs.push(th * Math.max(ring.r, 0.01), ring.y);
      tiles.push(th * rRef, ring.s, rRef, kind);
    }
    return start;
  };

  // Columns (segments) inside the opening, for ring pairs within its height.
  let holeCols: boolean[] | null = null;
  if (o.hole) {
    const h = o.hole;
    holeCols = [];
    for (let j = 0; j < seg; j++) {
      const th = t0 + (tl * (j + 0.5)) / seg - h.theta;
      holeCols.push(Math.abs(Math.atan2(Math.sin(th), Math.cos(th))) < h.halfAngle);
    }
  }
  const skipFor = (a: Ring, b: Ring) => {
    if (!holeCols || !o.hole) return null;
    const ym = (a.y + b.y) / 2;
    return ym > o.hole.y0 && ym < o.hole.y1 ? holeCols : null;
  };

  for (let i = 0; i < rings.length; i++) {
    if (bandStart[i]) {
      // Close the previous band with this ring at the old reference radius, then start a new row.
      const closeRow = emitRow(rings[i], bandRef[i - 1]);
      pushQuads(index, rowBase, closeRow, cols, o.inward ?? false, skipFor(rings[i - 1], rings[i]));
      rowBase = emitRow(rings[i], bandRef[i]);
      continue;
    }
    const row = emitRow(rings[i], bandRef[i]);
    if (i > 0 && !(rings[i].y === rings[i - 1].y && rings[i].r === rings[i - 1].r)) {
      pushQuads(index, rowBase, row, cols, o.inward ?? false, skipFor(rings[i - 1], rings[i]));
    }
    rowBase = row;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aTile', new THREE.Float32BufferAttribute(tiles, 4));
  g.setIndex(index);
  return g;
}

function pushQuads(index: number[], a: number, b: number, cols: number, inward: boolean, skip: boolean[] | null = null) {
  for (let j = 0; j < cols - 1; j++) {
    if (skip?.[j]) continue;
    const a0 = a + j;
    const a1 = a + j + 1;
    const b0 = b + j;
    const b1 = b + j + 1;
    // Outward faces are counter-clockwise seen from outside (θ increases towards +X on the +Z side).
    if (inward) {
      index.push(a0, b0, a1, a1, b0, b1);
    } else {
      index.push(a0, a1, b0, a1, b1, b0);
    }
  }
}

/**
 * Raised strip along the hull (raceway / chine / fairing): a rounded cross-section extruded along y,
 * sitting on a cylinder of radius `r` at azimuth `theta`. Ends taper down over `taper` metres.
 */
export function hullStrip(opts: {
  theta: number;
  r: number;
  y0: number;
  y1: number;
  width: number;
  height: number;
  taper?: number;
  steps?: number;
  tileKind?: number;
}): THREE.BufferGeometry {
  const steps = opts.steps ?? 8;
  const hw = opts.width / 2;
  // Cross-section in (tangential, radial) coordinates: steep sides, rounded crown.
  const cs: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI - (Math.PI * i) / steps;
    cs.push([Math.cos(a) * hw, opts.height * Math.pow(Math.max(Math.sin(a), 0), 0.35) - 0.03]);
  }
  const csN: Array<[number, number]> = cs.map((_, i) => {
    const p0 = cs[Math.max(0, i - 1)];
    const p1 = cs[Math.min(cs.length - 1, i + 1)];
    const dx = p1[0] - p0[0];
    const dh = p1[1] - p0[1];
    const l = Math.hypot(dx, dh) || 1;
    return [-dh / l, dx / l];
  });
  const taper = opts.taper ?? 0;
  const ys = taper > 0 ? [opts.y0, opts.y0 + taper, opts.y1 - taper, opts.y1] : [opts.y0, opts.y1];
  const scaleAt = (k: number) => (taper > 0 && (k === 0 || k === ys.length - 1) ? 0.08 : 1);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const sn = Math.sin(opts.theta);
  const cn = Math.cos(opts.theta);
  // Local frame: radial (sn, 0, cn), tangential (cn, 0, -sn).
  for (let k = 0; k < ys.length; k++) {
    const sc = scaleAt(k);
    for (let i = 0; i < cs.length; i++) {
      const tx = cs[i][0];
      const rr = opts.r + cs[i][1] * sc;
      positions.push(sn * rr + cn * tx, ys[k], cn * rr - sn * tx);
      const [nt, nrad] = csN[i];
      normals.push(sn * nrad + cn * nt, 0, cn * nrad - sn * nt);
      uvs.push(tx + opts.theta * opts.r, ys[k]);
    }
  }
  const n = cs.length;
  for (let k = 0; k < ys.length - 1; k++) {
    for (let i = 0; i < n - 1; i++) {
      const a = k * n + i;
      const b = (k + 1) * n + i;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  ensureSkinAttributes(g, opts.tileKind ?? 0);
  return g;
}

/** Box with metre UVs and skin attributes, centred at the origin. */
export function skinBox(w: number, h: number, d: number, tileKind = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (ny > 0.5) uv.setXY(i, x, z);
    else if (nx > 0.5) uv.setXY(i, z, y);
    else uv.setXY(i, x, y);
  }
  ensureSkinAttributes(g, tileKind);
  return g;
}

/** Adds a constant aTile attribute (if missing) so geometries can be merged with lathe output. */
export function ensureSkinAttributes(g: THREE.BufferGeometry, tileKind = 0): THREE.BufferGeometry {
  if (!g.getAttribute('aTile')) {
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) a[i * 4 + 3] = tileKind;
    g.setAttribute('aTile', new THREE.BufferAttribute(a, 4));
  }
  if (!g.getAttribute('uv')) {
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!g.index) {
    const n = g.getAttribute('position').count;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(i);
    g.setIndex(idx);
  }
  return g;
}

/** Keeps only the listed attributes (so heterogeneous pieces can be merged). */
export function onlyAttributes(g: THREE.BufferGeometry, names: string[]): THREE.BufferGeometry {
  for (const k of Object.keys(g.attributes)) if (!names.includes(k)) g.deleteAttribute(k);
  if (!g.index) {
    const n = g.getAttribute('position').count;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(i);
    g.setIndex(idx);
  }
  return g;
}

/** Merges geometries (disposing the inputs). All inputs must share the same attribute set. */
export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(geos, false);
  if (!m) throw new Error('mergeGeometries failed (attribute mismatch)');
  for (const g of geos) g.dispose();
  m.computeBoundingSphere();
  m.computeBoundingBox();
  return m;
}

/** Applies a matrix built from position / Euler rotation / scale to a geometry. */
export function place(
  g: THREE.BufferGeometry,
  pos: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])),
    new THREE.Vector3(...scale),
  );
  g.applyMatrix4(m);
  return g;
}

/** Rotation that turns +X into the outward radial direction at azimuth θ (θ from +Z towards +X). */
export function radialYaw(theta: number): number {
  // Rotating +X about +Y by φ gives (cosφ, 0, -sinφ); we want (sinθ, 0, cosθ) → φ = θ - π/2.
  return theta - Math.PI / 2;
}

/** Flat, outward-facing patch of a cylinder (for doors, plates): arc from θa to θb, y0..y1, radius r. */
export function cylinderPatch(r: number, thetaA: number, thetaB: number, y0: number, y1: number, segs: number, tileKind = 0): THREE.BufferGeometry {
  return lathe(
    [
      { y: y0, r },
      { y: y1, r },
    ],
    { segments: segs, thetaStart: thetaA, thetaLength: thetaB - thetaA, tileKind },
  );
}
