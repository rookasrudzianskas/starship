import { flapLeadingEdge } from '@/lib/sim/ship-geometry';
import * as THREE from 'three';
import { ensureSkinAttributes, merge, onlyAttributes } from './geometry';

/**
 * Moving parts: grid fins (booster) and flaps (ship).
 */

function box(w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY !== 0) g.rotateY(rotY);
  g.translate(x, y, z);
  return onlyAttributes(g, ['position', 'normal']);
}

/**
 * Grid fin in its hinge frame: +X radial (root at x = 0, tip at x = span), +Y along the vehicle axis
 * (the lattice's depth / chord), +Z tangential. The lattice plane is perpendicular to the vehicle axis
 * so the airflow along the body passes through the cells; deflection rotates the fin about +X.
 * Includes the hinge shaft reaching back to the hull (x < 0).
 */
export function gridFinGeometry(span: number, width: number, chord: number, cell: number, rootGap: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const t = 0.1;
  const hw = width / 2;
  // Frame: side rails, outer edge and a heavier root beam.
  parts.push(box(span, chord, t, span / 2, 0, hw - t / 2));
  parts.push(box(span, chord, t, span / 2, 0, -hw + t / 2));
  parts.push(box(t, chord, width, span - t / 2, 0, 0));
  parts.push(box(t * 2.2, chord * 1.1, width * 1.02, t * 1.1, 0, 0));
  // Diagonal lattice webs (±45°), clipped to the frame interior.
  const x0 = t * 2.2;
  const x1 = span - t;
  const z0 = -hw + t;
  const z1 = hw - t;
  const step = cell * Math.SQRT2;
  const web = 0.035;
  for (const d of [1, -1]) {
    const cMin = d > 0 ? x0 - z1 : x0 + z0;
    const cMax = d > 0 ? x1 - z0 : x1 + z1;
    for (let c = cMin + step * 0.5; c < cMax; c += step) {
      // Points on x = c + d·z inside [x0, x1] × [z0, z1].
      let za = d > 0 ? x0 - c : c - x1;
      let zb = d > 0 ? x1 - c : c - x0;
      za = Math.max(za, z0);
      zb = Math.min(zb, z1);
      if (zb - za < 0.05) continue;
      const xa = c + d * za;
      const xb = c + d * zb;
      const len = Math.hypot(xb - xa, zb - za);
      const ang = Math.atan2(-(zb - za), xb - xa);
      parts.push(box(len, chord * 0.96, web, (xa + xb) / 2, 0, (za + zb) / 2, ang));
    }
  }
  // Hinge shaft and actuator collar back to the hull.
  const shaft = new THREE.CylinderGeometry(0.17, 0.2, rootGap + 0.1, 12);
  shaft.rotateZ(Math.PI / 2);
  shaft.translate(-rootGap / 2, 0, 0);
  parts.push(onlyAttributes(shaft, ['position', 'normal']));
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Flaps
// ---------------------------------------------------------------------------

export interface FlapPlanform {
  /** Root (hinge) length along +Y. */
  root: number;
  /** Span along +X. */
  span: number;
  /** Tip edge from tipY0 to tipY1 (in the hinge's Y). */
  tipY0: number;
  tipY1: number;
  /** Thickness at the root and the tip. */
  tRoot: number;
  tTip: number;
  /** Rounds the leading (top) edge into a curve instead of a straight sweep (0..1). */
  curve: number;
}

/**
 * Flap slab in its hinge frame: hinge along +Y from y = 0 to root, span along +X (or -X when
 * `mirror`), windward face towards +Z (tiled, aTile kind 2), leeward face towards -Z (steel).
 */
export function flapGeometry(p: FlapPlanform, mirror: boolean, nx = 7, ny = 10): THREE.BufferGeometry {
  const bottom = (a: number) => a * p.tipY0;
  const top = (a: number) => flapLeadingEdge(p.root, p, a);
  const th = (a: number) => p.tRoot + (p.tTip - p.tRoot) * a;
  const sx = mirror ? -1 : 1;

  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const tile: number[] = [];
  const idx: number[] = [];

  const grid = (face: 1 | -1) => {
    const base = pos.length / 3;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const a = i / nx;
        const b = j / ny;
        const x = a * p.span;
        const y = bottom(a) + (top(a) - bottom(a)) * b;
        const z = (face * th(a)) / 2;
        pos.push(sx * x, y, z);
        nrm.push(0, 0, face);
        // Grain along the flap; v stays inside one 1.8 m texture band so no ring welds cross the flap.
        uv.push(y, 0.25 + (x / p.span) * 1.3);
        tile.push(x, y, 0, face > 0 ? 2 : 0);
      }
    }
    const cols = nx + 1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a0 = base + j * cols + i;
        const a1 = a0 + 1;
        const b0 = a0 + cols;
        const b1 = b0 + 1;
        // Counter-clockwise seen from the face's side (before mirroring).
        if (face > 0) idx.push(a0, a1, b0, a1, b1, b0);
        else idx.push(a0, b0, a1, a1, b0, b1);
      }
    }
    return base;
  };
  const wind = grid(1);
  const lee = grid(-1);
  const cols = nx + 1;

  // Edge strips joining the two faces along the outline (root, bottom, tip, top).
  const outline: number[] = [];
  for (let i = 0; i <= nx; i++) outline.push(i); // bottom edge, a = 0..1 at b = 0
  for (let j = 1; j <= ny; j++) outline.push(j * cols + nx); // tip edge
  for (let i = nx - 1; i >= 0; i--) outline.push(ny * cols + i); // top edge
  for (let j = ny - 1; j >= 1; j--) outline.push(j * cols); // root edge
  outline.push(0);
  for (let k = 0; k < outline.length - 1; k++) {
    const ia = outline[k];
    const ib = outline[k + 1];
    const base = pos.length / 3;
    const pa = [pos[(wind + ia) * 3], pos[(wind + ia) * 3 + 1]];
    const pb = [pos[(wind + ib) * 3], pos[(wind + ib) * 3 + 1]];
    // Outward in-plane normal of this outline segment (outline runs counter-clockwise for +X spans).
    let ex = pb[1] - pa[1];
    let ey = -(pb[0] - pa[0]);
    const l = Math.hypot(ex, ey) || 1;
    ex /= l;
    ey /= l;
    if (mirror) {
      ex = -ex;
      ey = -ey;
    }
    for (const src of [wind + ia, wind + ib, lee + ia, lee + ib]) {
      pos.push(pos[src * 3], pos[src * 3 + 1], pos[src * 3 + 2]);
      nrm.push(ex, ey, 0);
      uv.push(uv[src * 2], uv[src * 2 + 1]);
      tile.push(0, 0, 0, 0);
    }
    idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  if (mirror) {
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aTile', new THREE.Float32BufferAttribute(tile, 4));
  g.setIndex(idx);
  ensureSkinAttributes(g);
  g.computeBoundingSphere();
  return g;
}

/**
 * Hinge frame for a flap whose hinge runs from p0 to p1 on the hull, with the neutral (0°) flap plane
 * perpendicular to the belly axis (+Z). Returns the pivot transform; the flap geometry is built in it.
 * For `right` flaps (span towards -X) the local X axis points inboard so local +Z is still windward.
 */
export function flapPivot(p0: THREE.Vector3, p1: THREE.Vector3, right: boolean): THREE.Object3D {
  const pivot = new THREE.Object3D();
  const y = p1.clone().sub(p0).normalize();
  const zb = new THREE.Vector3(0, 0, 1);
  // Outward direction perpendicular to the hinge and to the belly axis.
  const out = right ? zb.clone().cross(y) : y.clone().cross(zb);
  out.normalize();
  const x = right ? out.clone().negate() : out;
  const z = x.clone().cross(y).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  pivot.quaternion.setFromRotationMatrix(m);
  pivot.position.copy(p0);
  return pivot;
}
