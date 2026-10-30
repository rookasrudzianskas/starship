import * as THREE from 'three';
import { hash3i } from '@/lib/three/vehicles/procedural';
import { beamMatrix, InstanceSet, MeshBuilder, v3 } from './builder';
import { PAINT, type PadMaterials } from './materials';

/**
 * Integration tower: square steel lattice of stacked sections (instanced beams), crown with sheaves and
 * a lightning-rod mast, carriage rails, propellant pipes, the ship quick-disconnect arm, and the
 * chopstick carriage with two truss arms that pivot on vertical hinges and close around the booster.
 */

/** Chopstick geometry (metres). Arms point south (−Z) from hinges on the carriage's south face. */
export const CHOPSTICKS = {
  /** Hinge to tip. */
  length: 28,
  /** Arm truss width (x) and depth (y) at the root. */
  width: 2.4,
  depth: 3.2,
  /** Catch rail height above the arm's top chord. */
  railHeight: 0.42,
  /** Hinge offset from the tower centre line (x), so the closed arms' inner faces sit at ±6 m. */
  hingeX: 7.2,
  /** Opening angle at armsOpen = 1. */
  maxOpenDeg: 55,
} as const;

/** Height of the catch-rail top above the arms' underside (PadState.armsHeight), m. */
export const CHOPSTICK_RAIL_TOP = CHOPSTICKS.depth + CHOPSTICKS.railHeight;

export interface TowerSpec {
  /** Tower centre in the pad's authoring frame (east, north), m; index.ts mirrors north onto -Z. */
  x: number;
  z: number;
  /** Top of the crown, m (the mast rises above it). */
  height: number;
  /** Lattice width, m. */
  width: number;
  /** Ship quick-disconnect arm height, m. */
  shipQdHeight: number;
  seed: number;
}

export interface StaticBuilders {
  paint: MeshBuilder;
  steel: MeshBuilder;
  concrete: MeshBuilder;
  cast: MeshBuilder;
  white: MeshBuilder;
  cladding: MeshBuilder;
  plate: MeshBuilder;
  tank: MeshBuilder;
  lights: MeshBuilder;
  paintDetail: MeshBuilder;
  steelDetail: MeshBuilder;
  whiteDetail: MeshBuilder;
}

export interface TowerBuild {
  /** Objects owned by the tower (lattice instances, carriage, arms). Static plates go into the builders. */
  objects: THREE.Object3D[];
  /** Objects hidden on 'low' quality. */
  detail: THREE.Object3D[];
  setArms(height: number, open: number): void;
}

const X = v3(1, 0, 0);
const Y = v3(0, 1, 0);

function tone(hex: number, k: number): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(k);
}

/** Rectangular truss between a and b: four chords, verticals and alternating diagonals on all sides. */
function truss(
  B: MeshBuilder,
  a: THREE.Vector3,
  b: THREE.Vector3,
  width: number,
  depth: number,
  panels: number,
  chord: number,
  web: number,
): void {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.normalize();
  const side = new THREE.Vector3().crossVectors(dir, Y);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  const up = new THREE.Vector3().crossVectors(side, dir).normalize();
  const corner = (i: number, t: number): THREE.Vector3 => {
    const sx = i === 0 || i === 3 ? -1 : 1;
    const sy = i < 2 ? -1 : 1;
    return a
      .clone()
      .addScaledVector(dir, t * len)
      .addScaledVector(side, (sx * (width - chord)) / 2)
      .addScaledVector(up, (sy * (depth - chord)) / 2);
  };
  for (let i = 0; i < 4; i++) B.beam(corner(i, 0), corner(i, 1), chord, chord, up);
  for (let p = 0; p <= panels; p++) {
    const t = p / panels;
    for (let i = 0; i < 4; i++) B.beam(corner(i, t), corner((i + 1) % 4, t), web, web, dir);
    if (p < panels) {
      const t2 = (p + 1) / panels;
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        if (p % 2 === 0) B.beam(corner(i, t), corner(j, t2), web * 0.9, web * 0.9, dir);
        else B.beam(corner(j, t), corner(i, t2), web * 0.9, web * 0.9, dir);
      }
    }
  }
}

/** One chopstick arm in its hinge frame: hinge axis = local Y through the origin, arm along −Z. */
function buildArmGeometry(): THREE.BufferGeometry {
  const B = new MeshBuilder();
  const L = CHOPSTICKS.length;
  const W = CHOPSTICKS.width;
  const D = CHOPSTICKS.depth;
  const half = W / 2;
  const m = 0.42;
  const taperStart = 0.55 * L;
  // The underside rises toward the tip; the top (with the catch rail) stays level.
  const bottomAt = (s: number) => (s < taperStart ? 0 : ((s - taperStart) / (L - taperStart)) * (D - 1.7));
  const panels = 12;
  const panel = L / panels;
  B.color(PAINT.arm);
  for (const sx of [-1, 1]) {
    const x = sx * (half - m / 2);
    B.beam(v3(x, D - m / 2, 0.2), v3(x, D - m / 2, -L), m, m, X);
    B.beam(v3(x, m / 2, 0.2), v3(x, m / 2, -taperStart), m, m, X);
    B.beam(v3(x, m / 2, -taperStart), v3(x, bottomAt(L) + m / 2, -L), m, m, X);
  }
  for (let i = 0; i <= panels; i++) {
    const s = i * panel;
    const yb = bottomAt(s) + m;
    const yt = D - m;
    for (const sx of [-1, 1]) {
      const x = sx * (half - m / 2);
      B.beam(v3(x, yb, -s), v3(x, yt, -s), 0.3, 0.3, X);
      if (i < panels) {
        const s2 = (i + 1) * panel;
        const yb2 = bottomAt(s2) + m;
        if (i % 2 === 0) B.beam(v3(x, yb, -s), v3(x, yt, -s2), 0.26, 0.26, X);
        else B.beam(v3(x, yt, -s), v3(x, yb2, -s2), 0.26, 0.26, X);
      }
    }
    B.beam(v3(-half + m, D - m / 2, -s), v3(half - m, D - m / 2, -s), 0.28, 0.28, Y);
    B.beam(v3(-half + m, bottomAt(s) + m / 2, -s), v3(half - m, bottomAt(s) + m / 2, -s), 0.28, 0.28, Y);
  }
  // Solid root around the hinge, hinge knuckles and the tip cap.
  B.color(PAINT.carriage);
  B.box(-half - 0.1, 0, -3.0, half + 0.1, D, 0.5);
  B.color(PAINT.mountDark);
  B.tube(v3(0, -1.0, 0), v3(0, 0.0, 0), 0.9, 16, true);
  B.tube(v3(0, D, 0), v3(0, D + 1.0, 0), 0.9, 16, true);
  B.color(PAINT.arm);
  B.box(-half, bottomAt(L), -L - 0.35, half, D, -L + 0.15);
  // Catch rail along the inner top edge (inner face is −X for the east arm) with landing pads.
  B.color(PAINT.rail);
  B.box(-half - 0.05, D, -L + 0.6, -half + 0.8, D + CHOPSTICKS.railHeight, -2.6);
  B.color(0x1d1e20);
  for (let s = 4.2; s < L - 1.2; s += 3.4) {
    B.box(-half + 0.05, D + CHOPSTICKS.railHeight, -s - 0.4, -half + 0.7, D + CHOPSTICKS.railHeight + 0.16, -s + 0.4);
  }
  // Inner face plating near the root (hydraulics and cable trays behind it).
  B.color(PAINT.carriage);
  B.box(-half - 0.02, 0.3, -9.0, -half + 0.08, D - 0.3, -3.0);
  return B.build();
}

/** Carriage frame in its own frame: origin at the tower centre line at the arms' underside height. */
function buildCarriageGeometry(half: number): THREE.BufferGeometry {
  const B = new MeshBuilder();
  const C = half + 1.3;
  const yLevels = [-0.4, 4.9, 10.1];
  B.color(PAINT.carriage);
  for (const [cx, cz] of [
    [-C, -C],
    [C, -C],
    [C, C],
    [-C, C],
  ]) {
    B.beam(v3(cx, -0.9, cz), v3(cx, 10.6, cz), 0.95, 0.95, X);
  }
  const corners: Array<[number, number]> = [
    [-C, -C],
    [C, -C],
    [C, C],
    [-C, C],
  ];
  for (let f = 0; f < 4; f++) {
    const [ax, az] = corners[f];
    const [bx, bz] = corners[(f + 1) % 4];
    const n = v3(az === bz ? 0 : Math.sign(ax), 0, az === bz ? Math.sign(az) : 0);
    for (const y of yLevels) B.beam(v3(ax, y, az), v3(bx, y, bz), 0.8, 1.0, n);
    if (f !== 0) {
      for (let k = 0; k < 2; k++) {
        const y0 = yLevels[k];
        const y1 = yLevels[k + 1];
        B.beam(v3(ax, y0, az), v3(bx, y1, bz), 0.45, 0.45, n);
        B.beam(v3(bx, y0, bz), v3(ax, y1, az), 0.45, 0.45, n);
      }
    }
  }
  // Front girder carrying both hinges.
  B.color(PAINT.towerDark);
  B.box(-CHOPSTICKS.hingeX - 1.3, -0.7, -C - 1.4, CHOPSTICKS.hingeX + 1.3, 3.7, -C + 0.3);
  // Hinge housings.
  B.color(PAINT.mountDark);
  for (const sx of [-1, 1]) B.tube(v3(sx * CHOPSTICKS.hingeX, -1.3, -C - 0.6), v3(sx * CHOPSTICKS.hingeX, 4.5, -C - 0.6), 1.05, 18, true);
  // Guide shoes on the tower rails and the hoist sheave block on top.
  B.color(PAINT.rail);
  for (const sx of [-1, 1]) {
    for (const y of [0.4, 9.2]) B.box(sx * (half - 0.55) - 0.65, y, -half - 1.05, sx * (half - 0.55) + 0.65, y + 1.5, -half - 0.6);
  }
  // Outriggers carrying the arm actuators' rear clevises.
  B.color(PAINT.towerDark);
  for (const sx of [-1, 1]) {
    const x0 = sx > 0 ? C - 0.2 : -C - 2.2;
    B.box(x0, 0.5, -C + 1.3, x0 + 2.4, 2.9, -C + 3.5);
  }
  B.color(PAINT.towerDark);
  B.box(-3.2, 10.6, -C - 0.2, 3.2, 12.0, -C + 1.6);
  return B.build();
}

export function buildTower(spec: TowerSpec, B: StaticBuilders, mats: PadMaterials): TowerBuild {
  const S = spec.width;
  const h = S / 2;
  const ox = spec.x;
  const oz = spec.z;
  const topY = spec.height - 6;
  const sections = 9;
  const secH = topY / sections;
  const bays = 2;
  const bayH = secH / bays;

  const main = new InstanceSet();
  const inner = new InstanceSet();
  const tubes = new InstanceSet();

  const P = (x: number, y: number, z: number) => v3(ox + x, y, oz + z);
  const corners: Array<[number, number]> = [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ];
  // Faces in order south, east, north, west with outward normals.
  const faces = corners.map((c, i) => {
    const d = corners[(i + 1) % 4];
    const n = c[1] === d[1] ? v3(0, 0, Math.sign(c[1])) : v3(Math.sign(c[0]), 0, 0);
    return { a: c, b: d, n };
  });

  // Sections were fabricated separately: vary their paint a little (grey, lighter grey, warm primer).
  const sectionPaint = [PAINT.tower, 0x4b4a47, PAINT.tower, 0x505255, 0x46433f, PAINT.tower, 0x4a4b4d, 0x43403c, PAINT.tower];
  for (let s = 0; s < sections; s++) {
    const y0 = s * secH;
    const y1 = (s + 1) * secH;
    const k = 0.92 + 0.16 * hash3i(s, spec.seed, 3);
    const paintHex = sectionPaint[(s + spec.seed * 3) % sectionPaint.length];
    const colCol = tone(paintHex, k * 0.95);
    for (const [cx, cz] of corners) main.beam(P(cx, y0, cz), P(cx, y1, cz), 1.15, 1.15, X, colCol);
    for (let b = 0; b < bays; b++) {
      const ya = y0 + b * bayH;
      const yb = ya + bayH;
      for (const f of faces) {
        const heavy = b === bays - 1;
        const hc = tone(paintHex, k * (heavy ? 0.9 : 1.0));
        // Horizontal at the top of the bay.
        main.beam(P(f.a[0], yb, f.a[1]), P(f.b[0], yb, f.b[1]), heavy ? 0.85 : 0.55, heavy ? 1.25 : 0.8, f.n, hc);
        // X bracing, the two diagonals nudged apart where they cross.
        const dc = tone(paintHex, k * (1.02 + 0.08 * hash3i(s * 7 + b, f.a[0] * 3 + f.a[1], 11)));
        const off = f.n.clone().multiplyScalar(0.12);
        main.beam(P(f.a[0], ya, f.a[1]).add(off), P(f.b[0], yb, f.b[1]).add(off), 0.36, 0.42, f.n, dc);
        main.beam(P(f.b[0], ya, f.b[1]).sub(off), P(f.a[0], yb, f.a[1]).sub(off), 0.36, 0.42, f.n, dc);
      }
    }
    // Plan bracing at each section level.
    const pc = tone(PAINT.towerDark, k);
    main.beam(P(-h, y1 - 0.5, -h), P(h, y1 - 0.5, h), 0.4, 0.5, Y, pc);
    main.beam(P(h, y1 - 0.5, -h), P(-h, y1 - 0.5, h), 0.4, 0.5, Y, pc);
  }
  // Ground-level horizontals.
  for (const f of faces) main.beam(P(f.a[0], 0.6, f.a[1]), P(f.b[0], 0.6, f.b[1]), 0.9, 1.2, f.n, tone(PAINT.towerDark, 1));

  // Carriage rails on the south face, standing proud of the lattice.
  for (const sx of [-1, 1]) {
    const x = sx * (h - 0.55);
    main.beam(P(x, 4, -h - 0.5), P(x, topY - 1.5, -h - 0.5), 0.5, 0.75, v3(0, 0, -1), tone(PAINT.rail, 0.95));
  }

  // Elevator / stair core in the north-west quadrant (seen through the lattice).
  const c0x = -h + 0.9;
  const c1x = -h + 4.4;
  const c0z = h - 4.4;
  const c1z = h - 0.9;
  const coreCol = tone(PAINT.towerLight, 1);
  for (const [cx, cz] of [
    [c0x, c0z],
    [c1x, c0z],
    [c1x, c1z],
    [c0x, c1z],
  ]) {
    inner.beam(P(cx, 0, cz), P(cx, topY, cz), 0.4, 0.4, X, coreCol);
  }
  const step = 4.0;
  for (let y = step; y < topY; y += step) {
    inner.beam(P(c0x, y, c0z), P(c1x, y, c0z), 0.25, 0.3, v3(0, 0, -1), coreCol);
    inner.beam(P(c1x, y, c0z), P(c1x, y, c1z), 0.25, 0.3, X, coreCol);
    inner.beam(P(c1x, y, c1z), P(c0x, y, c1z), 0.25, 0.3, v3(0, 0, 1), coreCol);
    // Switchback stair flights on the core's east and south faces.
    const ys = y - step;
    const stairCol = tone(PAINT.rail, 0.8);
    inner.beam(P(c1x + 0.4, ys, c1z - 0.3), P(c1x + 0.4, ys + step / 2, c0z + 0.3), 0.3, 0.9, X, stairCol);
    inner.beam(P(c1x + 0.4, ys + step / 2, c0z + 0.3), P(c1x + 0.4, y, c1z - 0.3), 0.3, 0.9, X, stairCol);
  }

  // Propellant and water lines inside the west face up to the ship QD arm level, with brackets.
  // (Kept inside the lattice so the chopstick carriage, which wraps the tower, can pass.)
  const pipeTop = spec.shipQdHeight + 2;
  const pipes: Array<[number, number, number]> = [
    [-1.2, 0.36, 0xd6d8da],
    [-2.3, 0.5, 0xc4c7ca],
    [-3.4, 0.32, 0xa9adb1],
  ];
  for (const [pz, r, col] of pipes) tubes.tube(P(-h + 1.1, 0.4, pz), P(-h + 1.1, pipeTop, pz), r, col);
  for (let y = 6; y < pipeTop; y += 8) inner.beam(P(-h, y, -0.8), P(-h + 1.6, y, -3.9), 0.3, 0.3, Y, tone(PAINT.towerDark, 1));

  // --- Static plates and fittings (merged into the shared builders) ---------------------------------
  const paint = B.paint;
  // Floor decks on the north half (grating platforms) at section levels.
  B.paintDetail.color(PAINT.towerLight);
  for (let s = 1; s < sections; s++) {
    const y = s * secH;
    B.paintDetail.box(ox - h + 0.6, y - 0.15, oz + 0.4, ox + h - 0.6, y + 0.15, oz + h - 0.6);
  }
  // Foundation.
  B.cast.color(0xd4d2cc);
  B.cast.box(ox - h - 2.5, -0.5, oz - h - 2.5, ox + h + 2.5, 1.2, oz + h + 2.5);
  // Hoist drawworks house at the north foot of the tower.
  B.cladding.color(0xd9dadb);
  B.cladding.box(ox - 7, 0, oz + h + 3, ox + 7, 7, oz + h + 13);
  B.white.color(0x8b8f94);
  B.white.box(ox - 7.3, 7, oz + h + 2.7, ox + 7.3, 7.6, oz + h + 13.3);

  // Crown: deck, sheave house, sheaves, mast.
  paint.color(PAINT.towerDark);
  paint.box(ox - h - 1.2, topY, oz - h - 1.2, ox + h + 1.2, topY + 1.0, oz + h + 1.2);
  paint.color(PAINT.tower);
  paint.box(ox - 4.8, topY + 1.0, oz - h + 0.4, ox + 4.8, topY + 5.6, oz + h - 2.2);
  paint.color(PAINT.towerDark);
  paint.box(ox - 5.2, topY + 5.6, oz - h, ox + 5.2, topY + 6.1, oz + h - 1.8);
  B.steel.color(PAINT.rail);
  for (const sx of [-4.4, -2.4, 2.4, 4.4]) {
    B.steel.tube(P(sx - 0.35, topY + 3.0, -h - 0.9), P(sx + 0.35, topY + 3.0, -h - 0.9), 1.55, 18, true);
    paint.color(PAINT.towerDark);
    paint.box(ox + sx - 0.55, topY + 1.0, oz - h - 1.4, ox + sx - 0.4, topY + 4.6, oz - h - 0.4);
    paint.box(ox + sx + 0.4, topY + 1.0, oz - h - 1.4, ox + sx + 0.55, topY + 4.6, oz - h - 0.4);
  }
  B.steel.color(0xb8bcc0);
  B.steel.tube(P(0, topY + 6.1, 1.5), P(0, spec.height + 8, 1.5), 0.42, 12, false, 0.28);
  B.steel.tube(P(0, spec.height + 8, 1.5), P(0, spec.height + 13, 1.5), 0.2, 8, true, 0.07);
  // Aviation lights on the crown corners, mid-height and the mast.
  const lightAt = (x: number, y: number, z: number, r = 0.32) => B.lights.tube(P(x, y - r, z), P(x, y + r, z), r, 8, true);
  for (const [cx, cz] of corners) lightAt(cx * 1.15, topY + 1.4, cz * 1.15);
  // Mid-height lights on the north face, inside the carriage's clearance.
  for (const lx of [-3, 3]) lightAt(lx, topY * 0.5, h + 0.45);
  lightAt(0, spec.height + 8.3, 1.5, 0.3);

  // Ship quick-disconnect arm on an outrigger off the west face, swung back (retracted) along the west
  // side, clear of the carriage's travel.
  const qdPivot = P(-h - 2.7, spec.shipQdHeight, -2.0);
  const qdDir = v3(-0.28, 0, 1).normalize();
  const qdEnd = qdPivot.clone().addScaledVector(qdDir, 15);
  paint.color(PAINT.tower);
  truss(paint, qdPivot.clone().add(v3(0, 1.3, 0)), qdEnd.clone().add(v3(0, 1.3, 0)), 2.0, 2.6, 6, 0.36, 0.22);
  paint.color(PAINT.mountDark);
  paint.tube(qdPivot.clone().add(v3(0, -0.8, 0)), qdPivot.clone().add(v3(0, 3.6, 0)), 0.65, 14, true);
  paint.color(PAINT.towerLight);
  paint.beam(qdEnd.clone().add(v3(0, -0.2, 0)), qdEnd.clone().add(v3(0, 2.9, 0)), 2.6, 1.6, qdDir);
  // Its outrigger bracket on the tower's west face.
  paint.color(PAINT.towerDark);
  paint.box(ox - h - 2.2, spec.shipQdHeight - 1.2, oz - 3.2, ox - h + 0.2, spec.shipQdHeight + 4.0, oz - 0.8);

  // --- Instanced lattice meshes ------------------------------------------------------------------------
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false);
  const latticeMesh = main.toMesh(boxGeo, mats.paintInst);
  latticeMesh.name = 'tower-lattice';
  const innerMesh = inner.toMesh(boxGeo, mats.paintInst);
  innerMesh.name = 'tower-core';
  const pipeMesh = tubes.toMesh(cylGeo, mats.steelInst);
  pipeMesh.name = 'tower-pipes';
  for (const m of [latticeMesh, innerMesh, pipeMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }

  // --- Carriage and chopsticks ------------------------------------------------------------------------
  const carriage = new THREE.Group();
  carriage.name = 'chopstick-carriage';
  carriage.position.set(ox, 60, oz);
  const carriageMesh = new THREE.Mesh(buildCarriageGeometry(h), mats.paint);
  carriageMesh.castShadow = true;
  carriageMesh.receiveShadow = true;
  carriage.add(carriageMesh);

  const C = h + 1.3;
  const hingeZ = -C - 0.6;
  const armGeo = buildArmGeometry();
  const armEast = new THREE.Group();
  armEast.name = 'chopstick-east';
  armEast.position.set(CHOPSTICKS.hingeX, 0, hingeZ);
  const armWest = new THREE.Group();
  armWest.name = 'chopstick-west';
  armWest.position.set(-CHOPSTICKS.hingeX, 0, hingeZ);
  armWest.scale.set(-1, 1, 1); // mirror image: inner face toward +X
  for (const g of [armEast, armWest]) {
    const mesh = new THREE.Mesh(armGeo, mats.paint);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    carriage.add(g);
  }

  // Hydraulic actuators between the carriage sides and the arms (re-aimed every update).
  const actuators = new THREE.InstancedMesh(cylGeo, mats.steelInst, 2);
  actuators.name = 'chopstick-actuators';
  actuators.castShadow = true;
  actuators.frustumCulled = false;
  const actCol = new THREE.Color(PAINT.rail);
  actuators.setColorAt(0, actCol);
  actuators.setColorAt(1, actCol);
  carriage.add(actuators);

  const maxOpen = THREE.MathUtils.degToRad(CHOPSTICKS.maxOpenDeg);
  const tmpM = new THREE.Matrix4();
  const anchor = new THREE.Vector3();
  const attach = new THREE.Vector3();
  const setArms = (height: number, open: number) => {
    carriage.position.y = height;
    const phi = THREE.MathUtils.clamp(open, 0, 1) * maxOpen;
    armEast.rotation.y = -phi;
    armWest.rotation.y = phi;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const ax = CHOPSTICKS.width / 2 + 0.6;
    const az = -6.5;
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? 1 : -1;
      anchor.set(sx * (C + 1.6), 1.7, -C + 2.4);
      // Arm-local attachment point rotated about the hinge (mirrored for the west arm).
      attach.set(sx * (ax * c - az * s) + sx * CHOPSTICKS.hingeX, 1.7, ax * s + az * c + hingeZ);
      actuators.setMatrixAt(i, beamMatrix(anchor, attach, 0.3, 0.3, Y, tmpM));
    }
    actuators.instanceMatrix.needsUpdate = true;
  };
  setArms(60, 1);

  return {
    objects: [latticeMesh, innerMesh, pipeMesh, carriage],
    detail: [innerMesh],
    setArms,
  };
}
