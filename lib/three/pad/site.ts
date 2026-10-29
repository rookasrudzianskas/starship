import * as THREE from 'three';
import type { PadId } from '@/lib/sim/types';
import { hash3i, smoothstep, tileNoise } from '@/lib/three/vehicles/procedural';
import { MeshBuilder, v3 } from './builder';
import type { StaticBuilders } from './tower';

/**
 * Pad surroundings: the concrete apron (with soot baked into vertex colours), the propellant tank farm
 * (vertical stainless tanks, horizontal white tanks, pipe rack), deluge water tanks, support buildings
 * and light poles. Pad 1's tank farm sits west of the mount, Pad 2's east.
 */

const APRON_Y = 0.25;

function noise2(x: number, z: number, scale: number, seed: number): number {
  return tileNoise(x / scale + 100, z / scale + 100, 8192, 8192, seed);
}

/** Exhaust scorching around the mount (1 = clean concrete). */
function apronShade(pad: PadId, x: number, z: number): number {
  const r = Math.hypot(x, z);
  const n = noise2(x, z, 9, 1) * 0.65 + noise2(x, z, 3, 2) * 0.35;
  let s: number;
  if (pad === 'pad1') {
    // Radial blast pattern: dark core, streaky rays.
    const th = Math.atan2(z, x);
    const rays = Math.pow(0.5 + 0.5 * Math.sin(th * 13 + n * 4), 3);
    s = 0.75 * Math.exp(-((r / 24) ** 2)) + 0.35 * Math.exp(-r / 40) * (0.4 + 0.9 * n) + 0.28 * Math.exp(-r / 50) * rays;
  } else {
    // Exhaust leaves the trench east and west: two widening scorch fans.
    const ax = Math.abs(x);
    const fan = Math.exp(-Math.max(0, ax - 24) / 55) * Math.exp(-((z / (12 + 0.45 * Math.max(0, ax - 24))) ** 2)) * smoothstep(18, 26, ax);
    s = 0.7 * fan * (0.6 + 0.6 * n) + 0.3 * Math.exp(-((r / 32) ** 2)) * (0.5 + n);
  }
  const grime = 0.94 + 0.06 * noise2(x, z, 25, 5);
  return Math.max(0.28, (1 - Math.min(0.72, s)) * grime);
}

function buildApron(B: MeshBuilder, pad: PadId, side: number): void {
  const x0 = side < 0 ? -178 : -102;
  const x1 = side < 0 ? 102 : 178;
  const z0 = -96;
  const z1 = 86;
  const nx = Math.round((x1 - x0) / 3.5);
  const nz = Math.round((z1 - z0) / 3.5);
  const base = B.vertexCount;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const z = z0 + ((z1 - z0) * j) / nz;
      // Perceptual shade to linear vertex colour.
      const k = Math.pow(apronShade(pad, x, z), 2.2);
      // Soot is warm (brown-black): darker areas lose a little blue.
      B.rgb(k, k * (0.97 + 0.03 * k), k * (0.9 + 0.1 * k));
      B.vertex(x, APRON_Y, z, 0, 1, 0, x, z);
    }
  }
  const row = nx + 1;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = base + j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      B.tri(a, c, b);
      B.tri(b, c, d);
    }
  }
  // Slab edges, so the apron reads as a raised pad over the surrounding ground.
  B.rgb(0.8, 0.8, 0.78);
  const lo = -1.2;
  B.quad(v3(x0, lo, z0), v3(x1, lo, z0), v3(x1, APRON_Y, z0), v3(x0, APRON_Y, z0));
  B.quad(v3(x1, lo, z1), v3(x0, lo, z1), v3(x0, APRON_Y, z1), v3(x1, APRON_Y, z1));
  B.quad(v3(x0, lo, z1), v3(x0, lo, z0), v3(x0, APRON_Y, z0), v3(x0, APRON_Y, z1));
  B.quad(v3(x1, lo, z0), v3(x1, lo, z1), v3(x1, APRON_Y, z1), v3(x1, APRON_Y, z0));
}

function verticalTank(B: MeshBuilder, x: number, z: number, r: number, h: number): void {
  B.lathe(
    [
      [r + 0.45, 0],
      [r + 0.45, 1.3],
      [r, 1.3],
      [r, h],
      [r * 0.95, h + 0.75],
      [r * 0.82, h + 1.7],
      [r * 0.6, h + 2.55],
      [r * 0.32, h + 3.1],
      [0, h + 3.3],
    ],
    40,
    x,
    z,
    APRON_Y,
  );
}

function horizontalTank(B: MeshBuilder, x: number, y: number, z: number, r: number, len: number): void {
  const t = new MeshBuilder();
  const hl = len / 2;
  t.lathe(
    [
      [0, -hl - 1.0],
      [r * 0.5, -hl - 0.85],
      [r * 0.82, -hl - 0.5],
      [r, -hl],
      [r, hl],
      [r * 0.82, hl + 0.5],
      [r * 0.5, hl + 0.85],
      [0, hl + 1.0],
    ],
    28,
    0,
    0,
  );
  const g = t.build();
  const m = new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
  B.geometry(g, m);
  g.dispose();
}

function buildTankFarm(B: StaticBuilders, side: number): void {
  // Vertical stainless propellant tanks in two rows on a raised containment slab.
  B.cast.color(0xcfcdc7);
  B.cast.box(side * 102, 0, -30, side * 150, APRON_Y + 0.6, 12);
  const rows = [-19, 2];
  const xs = [112, 126, 140];
  for (const rz of rows) {
    for (const x of xs) {
      const k = 0.9 + 0.1 * hash3i(x, rz, 4);
      B.tank.rgb(k, k, k);
      const h = 24 + 7 * hash3i(x, rz, 9);
      verticalTank(B.tank, side * x, rz, 4.5, h);
      // Top platform and access stair.
      B.steelDetail.color(0xa7abaf);
      B.steelDetail.box(side * x - 1.5, APRON_Y + h + 3.3, rz - 1.5, side * x + 1.5, APRON_Y + h + 3.5, rz + 1.5);
      B.steelDetail.beam(v3(side * x + side * 4.8, APRON_Y, rz - 2), v3(side * x + side * 4.8, APRON_Y + h + 1, rz - 2), 0.9, 0.9, v3(1, 0, 0));
    }
  }
  // Horizontal tanks (white) on concrete saddles.
  for (let i = 0; i < 4; i++) {
    const z = -66 + i * 7.5;
    const x = side * 95;
    B.white.color(0xeceeed);
    horizontalTank(B.white, x, APRON_Y + 3.4, z, 2.3, 24);
    B.cast.color(0xc4c2bc);
    for (const dx of [-8, 0, 8]) B.cast.box(x + dx - 0.6, 0, z - 2.0, x + dx + 0.6, APRON_Y + 2.0, z + 2.0);
  }
  // Pipe rack from the tank farm toward the mount.
  const rackZ = 14;
  const xFar = side * 104;
  const xNear = side * 26;
  B.paintDetail.color(0x6d7176);
  const steps = Math.round(Math.abs(xFar - xNear) / 8);
  for (let i = 0; i <= steps; i++) {
    const x = xNear + ((xFar - xNear) * i) / steps;
    B.paintDetail.beam(v3(x, APRON_Y, rackZ), v3(x, APRON_Y + 5.2, rackZ), 0.4, 0.4, v3(1, 0, 0));
    B.paintDetail.beam(v3(x, APRON_Y + 5.2, rackZ - 1.8), v3(x, APRON_Y + 5.2, rackZ + 1.8), 0.35, 0.45, v3(0, 1, 0));
  }
  B.steel.color(0xc9ccce);
  for (const [dz, r] of [
    [-1.1, 0.35],
    [0, 0.48],
    [1.1, 0.3],
  ] as Array<[number, number]>) {
    B.steel.tube(v3(xFar, APRON_Y + 5.7 + r * 0.3, rackZ + dz), v3(xNear, APRON_Y + 5.7 + r * 0.3, rackZ + dz), r, 12, true);
  }
}

function building(B: MeshBuilder, x0: number, z0: number, x1: number, z1: number, h: number, wall: number, roof: number): void {
  B.color(wall);
  B.box(x0, 0, z0, x1, APRON_Y + h, z1);
  B.color(roof);
  B.box(x0 - 0.15, APRON_Y + h, z0 - 0.15, x1 + 0.15, APRON_Y + h + 0.5, z1 + 0.15);
}

function buildBuildings(B: StaticBuilders, side: number): void {
  // Pad control / electrical building, workshop, small sheds.
  building(B.white, -side * 84, -70, -side * 60, -56, 9, 0xe4e5e3, 0x9a9ea2);
  building(B.white, side * 30, -90, side * 62, -74, 12, 0xd2d4d5, 0x7f8388);
  building(B.white, -side * 30, 40, -side * 18, 50, 5, 0xdfe0de, 0x8e9296);
  // Darker blue-grey band on the workshop (doors) and roof units.
  B.paint.color(0x3e4d5e);
  B.paint.box(Math.min(side * 36, side * 48), APRON_Y, -74.2, Math.max(side * 36, side * 48), APRON_Y + 8, -73.9);
  B.steelDetail.color(0x9fa3a7);
  for (let i = 0; i < 4; i++) {
    const x = -side * (64 + i * 5);
    B.steelDetail.box(x - 1.2, APRON_Y + 9.5, -66, x + 1.2, APRON_Y + 11, -63);
  }
  // Deluge water tanks (tall white pressure vessels) on the opposite side from the tank farm.
  for (let i = 0; i < 3; i++) {
    B.white.color(0xf0f1f0);
    const x = -side * (56 + i * 8.5);
    B.white.lathe(
      [
        [3.4, 0],
        [3.4, 1.0],
        [3.0, 1.0],
        [3.0, 20],
        [2.6, 21.3],
        [1.6, 22.2],
        [0, 22.6],
      ],
      28,
      x,
      -40,
      APRON_Y,
    );
  }
  // Small GSE skids and containers scattered around.
  for (let i = 0; i < 10; i++) {
    const x = (hash3i(i, 1, 21) - 0.5) * 150;
    const z = -40 - hash3i(i, 2, 21) * 45;
    if (Math.abs(x) < 30) continue;
    B.white.color(hash3i(i, 3, 21) > 0.5 ? 0xd8dad9 : 0xa9adb0);
    B.white.boxRotY(x, APRON_Y + 1.3, z, 6, 2.6, 2.5, hash3i(i, 4, 21) * Math.PI);
  }
}

function buildPoles(B: StaticBuilders, side: number): void {
  const spots: Array<[number, number]> = [
    [-70 * side, 62],
    [62 * side, 60],
    [-58 * side, -78],
    [80 * side, -40],
  ];
  for (const [x, z] of spots) {
    B.steel.color(0xb4b8bb);
    B.steel.tube(v3(x, APRON_Y, z), v3(x, 34, z), 0.38, 10, false, 0.2);
    B.steel.color(0x8a8e92);
    B.steel.box(x - 1.6, 33.6, z - 0.6, x + 1.6, 34.6, z + 0.6);
    B.white.color(0xfafaf0);
    B.white.box(x - 1.4, 33.3, z - 0.5, x + 1.4, 33.6, z + 0.5);
  }
}

export function buildSite(pad: PadId, B: StaticBuilders): void {
  const side = pad === 'pad1' ? -1 : 1;
  buildApron(B.concrete, pad, side);
  buildTankFarm(B, side);
  buildBuildings(B, side);
  buildPoles(B, side);
}

export { APRON_Y };
