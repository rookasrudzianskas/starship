import * as THREE from 'three';
import { smoothstep, tileNoise } from '@/lib/three/vehicles/procedural';
import { v3, type MeshBuilder } from './builder';
import { PAINT } from './materials';
import type { StaticBuilders } from './tower';

/**
 * Launch mounts. Pad 1: the original table on six legs with the 20-clamp hold-down ring and the
 * water-cooled steel deflector plate on the ground below. Pad 2: a massive, squat mount block spanning a
 * flame trench whose steel-lined, water-cooled wedge splits the exhaust east and west.
 */

/** Extrudes a shape (drawn in the x/z plane, shape y = −z) upward from y0 to y1. */
function extrudeUp(shape: THREE.Shape, y0: number, y1: number, curveSegments = 64): { g: THREE.BufferGeometry; m: THREE.Matrix4 } {
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments });
  const m = new THREE.Matrix4().makeTranslation(0, y0, 0).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  return { g, m };
}

function appendExtrude(B: MeshBuilder, shape: THREE.Shape, y0: number, y1: number, curveSegments = 64): void {
  const { g, m } = extrudeUp(shape, y0, y1, curveSegments);
  B.geometry(g, m);
  g.dispose();
}

/** Rectangle with chamfered corners and an optional round hole, centred on the origin. */
function chamferedRect(hx: number, hz: number, ch: number, holeR: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-hx + ch, -hz);
  s.lineTo(hx - ch, -hz);
  s.lineTo(hx, -hz + ch);
  s.lineTo(hx, hz - ch);
  s.lineTo(hx - ch, hz);
  s.lineTo(-hx + ch, hz);
  s.lineTo(-hx, hz - ch);
  s.lineTo(-hx, -hz + ch);
  s.closePath();
  if (holeR > 0) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, holeR, 0, Math.PI * 2, true);
    s.holes.push(hole);
  }
  return s;
}

function annulus(rIn: number, rOut: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, rOut, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, rIn, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return s;
}

/** Vertical stiffener ribs, a top lip and a mid band along the straight sides of a chamfered table. */
function tableRibs(B: MeshBuilder, hx: number, hz: number, ch: number, y0: number, y1: number, spacing: number): void {
  // Box spanning [a0, a1] along the side and protruding `out` metres beyond the face at `face`.
  const sideBox = (alongX: boolean, a0: number, a1: number, face: number, out: number, ya: number, yb: number) => {
    const f0 = Math.min(face, face + Math.sign(face) * out);
    const f1 = Math.max(face, face + Math.sign(face) * out);
    if (alongX) B.box(a0, ya, f0, a1, yb, f1);
    else B.box(f0, ya, a0, f1, yb, a1);
  };
  const sides: Array<[boolean, number, number, number]> = [
    [true, -hx + ch, hx - ch, -hz],
    [true, -hx + ch, hx - ch, hz],
    [false, -hz + ch, hz - ch, -hx],
    [false, -hz + ch, hz - ch, hx],
  ];
  for (const [alongX, a0, a1, face] of sides) {
    const n = Math.max(1, Math.round((a1 - a0) / spacing));
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      sideBox(alongX, a - 0.18, a + 0.18, face, 0.4, y0 + 0.3, y1 - 0.45);
    }
    sideBox(alongX, a0, a1, face, 0.32, y1 - 0.45, y1);
    sideBox(alongX, a0, a1, face, 0.22, (y0 + y1) / 2 - 0.15, (y0 + y1) / 2 + 0.15);
  }
}

/** The 20 hold-down clamps around the booster's aft skirt (inner jaw at r ≈ 4.55 m). */
function holdDownRing(B: StaticBuilders, baseY: number): void {
  B.steel.color(PAINT.mountDark);
  appendExtrude(B.steel, annulus(4.9, 7.4), baseY, baseY + 0.7, 72);
  const n = 20;
  for (let k = 0; k < n; k++) {
    const th = ((k + 0.5) / n) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    B.steel.color(PAINT.clamp);
    // Body: radial block on the ring.
    B.steel.boxRotY(c * 5.8, baseY + 0.7 + 0.8, s * 5.8, 1.6, 1.6, 0.85, -th);
    // Jaw leaning in over the skirt edge.
    B.steel.color(PAINT.mountDark);
    B.steel.boxRotY(c * 4.95, baseY + 2.35, s * 4.95, 0.9, 0.7, 0.7, -th);
    // Hydraulic cylinder behind each clamp.
    B.steel.color(PAINT.rail);
    B.steel.tube(v3(c * 6.4, baseY + 0.9, s * 6.4), v3(c * 7.1, baseY + 2.1, s * 7.1), 0.18, 8, true);
  }
}

/** Planar polar disc (top face) with metre UVs; returns nothing, adds into B. */
function polarDisc(B: MeshBuilder, y: number, radii: number[], segments: number): void {
  const base = B.vertexCount;
  for (let i = 0; i < radii.length; i++) {
    for (let s = 0; s <= segments; s++) {
      const th = (s / segments) * Math.PI * 2;
      const x = Math.cos(th) * radii[i];
      const z = Math.sin(th) * radii[i];
      B.vertex(x, y, z, 0, 1, 0, x, z);
    }
  }
  const row = segments + 1;
  for (let i = 0; i < radii.length - 1; i++) {
    for (let s = 0; s < segments; s++) {
      const a = base + i * row + s;
      const b = a + row;
      // Counter-clockwise seen from above (+Y).
      B.tri(a, a + 1, b);
      B.tri(a + 1, b + 1, b);
    }
  }
}

function soot(x: number, z: number, scale: number): number {
  return tileNoise(x / scale + 50, z / scale + 50, 4096, 4096, 3) * 0.6 + tileNoise(x / (scale * 0.3), z / (scale * 0.3), 4096, 4096, 8) * 0.4;
}

export function buildMountPad1(B: StaticBuilders, mountHeight: number): void {
  const top = mountHeight;
  const tableBottom = top - 4.4;
  // Six legs on a ring, each on a footing, with steel caps.
  const concreteStart = B.cast.vertexCount;
  for (let k = 0; k < 6; k++) {
    const th = ((k + 0.5) / 6) * Math.PI * 2;
    const x = Math.cos(th) * 10.8;
    const z = Math.sin(th) * 10.8;
    B.cast.color(0xc9c7c1);
    B.cast.boxRotY(x, 0.6, z, 5.4, 1.2, 5.4, -th);
    B.cast.color(0xbdbbb5);
    B.cast.boxRotY(x, tableBottom / 2, z, 3.4, tableBottom, 3.4, -th);
  }
  // Exhaust soot on the legs' inner faces and lower parts.
  B.cast.shade((x, y, z) => {
    const r = Math.hypot(x, z);
    const inner = smoothstep(12.5, 9.5, r);
    const low = smoothstep(14, 2, y);
    return 1 - 0.55 * Math.min(1, inner * (0.55 + 0.45 * low) + 0.2 * low);
  }, concreteStart);

  const paintStart = B.paint.vertexCount;
  B.paint.color(PAINT.mountSteel);
  appendExtrude(B.paint, chamferedRect(13, 13, 3.5, 4.9), tableBottom, top, 72);
  B.paint.color(0x6f7378);
  tableRibs(B.paint, 13, 13, 3.5, tableBottom, top, 2.1);
  // Radial girders under the table, between the throat and the legs.
  B.paint.color(PAINT.mountDark);
  for (let k = 0; k < 6; k++) {
    const th = ((k + 0.5) / 6) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    B.paint.beam(v3(c * 5.4, tableBottom - 0.9, s * 5.4), v3(c * 10.0, tableBottom - 0.9, s * 10.0), 1.6, 1.8, v3(-s, 0, c));
  }
  // Booster quick-disconnect on the tower side, with its protective hood.
  B.paint.color(PAINT.towerLight);
  B.paint.box(-1.7, top, 7.2, 1.7, top + 3.2, 10.2);
  B.paint.color(PAINT.mountDark);
  B.paint.box(-2.1, top + 3.2, 6.6, 2.1, top + 3.8, 10.6);
  B.paint.box(-1.2, top + 0.6, 5.6, 1.2, top + 2.6, 7.2);
  B.paint.shade((x, y, z) => {
    const r = Math.hypot(x, z);
    const n = soot(x, z, 6);
    const throat = smoothstep(9.5, 5.0, r);
    const under = y < tableBottom + 0.05 ? 0.35 : 0;
    return 1 - Math.min(0.75, throat * (0.5 + 0.35 * n) + under);
  }, paintStart);

  holdDownRing(B, top);

  // Railing around the table edge.
  B.steelDetail.color(0xb5b8bb);
  const hx = 12.8;
  const edges: Array<[number, number, number, number]> = [
    [-hx + 3.4, -hx, hx - 3.4, -hx],
    [hx, -hx + 3.4, hx, hx - 3.4],
    [hx - 3.4, hx, -hx + 3.4, hx],
    [-hx, hx - 3.4, -hx, -hx + 3.4],
  ];
  for (const [x0, z0, x1, z1] of edges) {
    for (const y of [top + 0.55, top + 1.1]) B.steelDetail.beam(v3(x0, y, z0), v3(x1, y, z1), 0.08, 0.08, v3(0, 1, 0));
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.round(len / 2.2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      B.steelDetail.beam(v3(x, top, z), v3(x, top + 1.1, z), 0.07, 0.07, v3(1, 0, 0));
    }
  }

  // Water-cooled steel deflector plate on the ground, sooty and heat-tinted in the middle.
  const plateStart = B.plate.vertexCount;
  B.plate.color(0xffffff);
  polarDisc(B.plate, 1.3, [0, 1.6, 3.2, 4.8, 6.4, 8.0, 9.4, 10.6], 56);
  B.plate.lathe(
    [
      [11.8, 0],
      [10.6, 1.3],
    ],
    56,
    0,
    0,
  );
  B.plate.shade((x, _y, z) => {
    const r = Math.hypot(x, z);
    const n = soot(x, z, 3);
    return 0.42 + 0.58 * smoothstep(2.0, 10.5, r + (n - 0.5) * 3);
  }, plateStart);
  // Supply mains running out from the plate (away from the tower).
  B.steel.color(0x9da1a5);
  for (const deg of [-30, -90, -150]) {
    const th = THREE.MathUtils.degToRad(deg);
    const c = Math.cos(th);
    const s = Math.sin(th);
    B.steel.tube(v3(c * 11.4, 0.8, s * 11.4), v3(c * 36, 0.8, s * 36), 0.7, 14, true);
    B.cast.color(0xc4c2bc);
    for (let d = 16; d < 36; d += 6) B.cast.boxRotY(c * d, 0.35, s * d, 1.0, 0.7, 2.2, -th);
  }
}

export function buildMountPad2(B: StaticBuilders, mountHeight: number): void {
  const top = mountHeight;
  const deckBottom = top - 6.5;
  const trenchHalf = 11; // trench inner half-width (z)
  const wallLen = 23; // wall half-length (x)

  // Trench side walls (concrete), steel-lined on the inside.
  const concreteStart = B.cast.vertexCount;
  B.cast.color(0xc6c4be);
  B.cast.box(-wallLen, 0, trenchHalf, wallLen, deckBottom, trenchHalf + 8);
  B.cast.box(-wallLen, 0, -trenchHalf - 8, wallLen, deckBottom, -trenchHalf);
  // Buttresses on the outer faces.
  B.cast.color(0xbdbbb5);
  for (const sz of [-1, 1]) {
    for (let x = -wallLen + 3; x <= wallLen - 3; x += 7.5) {
      // No buttresses where the tower foundation meets the north wall.
      if (sz > 0 && Math.abs(x) < 10.5) continue;
      const z0 = sz * (trenchHalf + 8);
      B.cast.box(x - 1.2, 0, Math.min(z0, z0 + sz * 3), x + 1.2, deckBottom - 4, Math.max(z0, z0 + sz * 3));
    }
  }
  B.cast.shade((x, y, z) => {
    const inTrench = Math.abs(z) < trenchHalf + 0.6 ? 1 : 0;
    const ends = smoothstep(wallLen - 6, wallLen, Math.abs(x));
    return 1 - 0.5 * Math.min(1, inTrench * 0.6 + ends * 0.3 * smoothstep(deckBottom, 0, y));
  }, concreteStart);

  // Steel liners on the trench walls and the water-cooled wedge that splits the exhaust.
  const plateStart = B.plate.vertexCount;
  B.plate.color(0xffffff);
  for (const sz of [-1, 1]) {
    const zIn = sz * trenchHalf;
    B.plate.box(-wallLen + 1, 0.3, Math.min(zIn, zIn - sz * 0.35), wallLen - 1, deckBottom - 0.4, Math.max(zIn, zIn - sz * 0.35));
  }
  const ridgeY = 9.5;
  const footX = 25;
  const zw = trenchHalf - 0.35;
  for (const sx of [-1, 1]) {
    // Sloped face from the ridge down toward this trench mouth (front face up/out).
    const p0 = v3(0, ridgeY, sx > 0 ? -zw : zw);
    const p1 = v3(0, ridgeY, sx > 0 ? zw : -zw);
    const p2 = v3(sx * footX, 0.4, sx > 0 ? zw : -zw);
    const p3 = v3(sx * footX, 0.4, sx > 0 ? -zw : zw);
    B.plate.quad(p0, p1, p2, p3);
  }
  B.plate.shade((x, y, z) => {
    const n = soot(x, z, 3);
    const nearRidge = smoothstep(14, 0, Math.abs(x));
    return 1 - Math.min(0.7, 0.25 + 0.4 * nearRidge * (0.6 + 0.5 * n) + 0.1 * smoothstep(4, 0, y));
  }, plateStart);

  // Mount block spanning the trench, with longitudinal girders visible from the trench mouths.
  const paintStart = B.paint.vertexCount;
  B.paint.color(PAINT.mountSteel);
  appendExtrude(B.paint, chamferedRect(16, trenchHalf + 8, 4.5, 5.0), deckBottom, top, 72);
  B.paint.color(0x6f7378);
  tableRibs(B.paint, 16, trenchHalf + 8, 4.5, deckBottom, top, 2.4);
  B.paint.color(PAINT.mountDark);
  for (const sx of [-1, 1]) {
    B.paint.box(sx * 7.5 - 1.1, deckBottom - 2.4, -trenchHalf, sx * 7.5 + 1.1, deckBottom, trenchHalf);
  }
  B.paint.box(-16, deckBottom - 1.4, -trenchHalf, 16, deckBottom, -trenchHalf + 1.6);
  B.paint.box(-16, deckBottom - 1.4, trenchHalf - 1.6, 16, deckBottom, trenchHalf);
  // Side plating bands and service platforms.
  B.paint.color(PAINT.towerLight);
  for (const sx of [-1, 1]) B.paint.box(sx * 16 - 0.4, deckBottom + 1.5, -12, sx * 16 + 0.4, deckBottom + 2.3, 12);
  // Booster quick-disconnect with hood on the tower side.
  B.paint.color(PAINT.towerLight);
  B.paint.box(-1.8, top, 7.4, 1.8, top + 3.4, 10.6);
  B.paint.color(PAINT.mountDark);
  B.paint.box(-2.2, top + 3.4, 6.8, 2.2, top + 4.0, 11.0);
  B.paint.box(-1.2, top + 0.6, 5.7, 1.2, top + 2.6, 7.4);
  B.paint.shade((x, y, z) => {
    const r = Math.hypot(x, z);
    const n = soot(x, z, 6);
    const throat = smoothstep(10, 5.0, r);
    const under = y < deckBottom + 0.05 ? 0.4 : 0;
    return 1 - Math.min(0.75, throat * (0.5 + 0.35 * n) + under);
  }, paintStart);

  holdDownRing(B, top);

  // Railings along the block's long edges and the deluge mains along the wall feet.
  B.steelDetail.color(0xb5b8bb);
  for (const sx of [-1, 1]) {
    const x = sx * 15.8;
    for (const y of [top + 0.55, top + 1.1]) B.steelDetail.beam(v3(x, y, -14), v3(x, y, 14), 0.08, 0.08, v3(0, 1, 0));
    for (let z = -14; z <= 14; z += 2.33) B.steelDetail.beam(v3(x, top, z), v3(x, top + 1.1, z), 0.07, 0.07, v3(1, 0, 0));
  }
  // (South side only: the tower foundation abuts the north wall.)
  B.steel.color(0x9da1a5);
  const zm = -(trenchHalf + 12.5);
  B.steel.tube(v3(-wallLen - 12, 0.9, zm), v3(wallLen + 12, 0.9, zm), 0.75, 14, true);
  for (let x = -wallLen + 6.75; x < wallLen; x += 7.5) {
    B.steel.tube(v3(x, 0.9, zm), v3(x, deckBottom - 1, -(trenchHalf + 8.6)), 0.35, 10, true);
  }
}
