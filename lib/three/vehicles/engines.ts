import * as THREE from 'three';
import type { Quality } from '@/lib/three/contracts';

/**
 * Raptor engine geometry, generated as one lathe profile per engine type that runs down the inside of
 * the bell from the throat, round the exit lip, back up the outer wall and over the chamber/powerhead. Vertex colours
 * carry the finish (sooty interior, bronze-grey regeneratively cooled wall, silver RVac extension).
 * aPart.x weights the combustion glow seen inside the bell (strongest near the throat), aPart.y marks
 * the radiatively cooled RVac extension that glows dull red after a long burn, aPart.z the sooty
 * inner wall.
 * Origin: centre of the nozzle exit plane, engine axis +Y (plume goes along -Y).
 */

export type EngineKind = 'r2' | 'r3' | 'rvac2' | 'rvac3';

interface Ring {
  y: number;
  r: number;
  color: [number, number, number];
  glow: number;
  ext: number;
  /** 1 on the inner (sooty, non-metallic) wall of the bell. */
  inner?: number;
  crease?: boolean;
}

interface EngineSpec {
  exitR: number;
  throatR: number;
  bellLen: number;
  /** Bell contour exponent (higher = faster initial expansion). */
  k: number;
  /** Where the radiatively cooled extension ends (fraction of the bell from the exit), 0 for none. */
  extFrac: number;
  innerExit: [number, number, number];
  innerThroat: [number, number, number];
  outerExit: [number, number, number];
  outerTop: [number, number, number];
  extOuter?: [number, number, number];
  head: 'r2' | 'r3';
  topY: number;
}

const SPECS: Record<EngineKind, EngineSpec> = {
  r2: {
    exitR: 0.65,
    throatR: 0.2,
    bellLen: 1.75,
    k: 2.0,
    extFrac: 0,
    innerExit: [0.11, 0.1, 0.09],
    innerThroat: [0.03, 0.026, 0.024],
    outerExit: [0.3, 0.28, 0.26],
    outerTop: [0.17, 0.155, 0.145],
    head: 'r2',
    topY: 2.45,
  },
  r3: {
    exitR: 0.65,
    throatR: 0.2,
    bellLen: 1.8,
    k: 1.9,
    extFrac: 0,
    innerExit: [0.13, 0.125, 0.12],
    innerThroat: [0.035, 0.03, 0.028],
    outerExit: [0.36, 0.36, 0.36],
    outerTop: [0.3, 0.3, 0.31],
    head: 'r3',
    topY: 2.6,
  },
  rvac2: {
    exitR: 1.15,
    throatR: 0.2,
    bellLen: 3.35,
    k: 2.3,
    extFrac: 0.62,
    innerExit: [0.1, 0.095, 0.09],
    innerThroat: [0.03, 0.026, 0.024],
    outerExit: [0.66, 0.66, 0.67],
    outerTop: [0.24, 0.22, 0.21],
    extOuter: [0.62, 0.62, 0.63],
    head: 'r2',
    topY: 4.1,
  },
  rvac3: {
    exitR: 1.15,
    throatR: 0.2,
    bellLen: 3.35,
    k: 2.3,
    extFrac: 0.62,
    innerExit: [0.11, 0.105, 0.1],
    innerThroat: [0.032, 0.028, 0.026],
    outerExit: [0.7, 0.7, 0.71],
    outerTop: [0.4, 0.4, 0.41],
    extOuter: [0.66, 0.66, 0.67],
    head: 'r3',
    topY: 4.2,
  },
};

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function engineProfile(kind: EngineKind, detail: number, withHead: boolean): Ring[] {
  const s = SPECS[kind];
  const bell = (u: number) => {
    // u = 1 at the exit, 0 at the throat.
    const f = 0.12 * u + 0.88 * (1 - Math.pow(1 - u, s.k));
    return s.throatR + (s.exitR - s.throatR) * f;
  };
  const wall = kind.startsWith('rvac') ? 0.018 : 0.03;
  const n = Math.max(6, Math.round(10 * detail));
  const rings: Ring[] = [];
  // Inner wall, throat -> exit.
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const y = (1 - u) * s.bellLen;
    const isExt = s.extFrac > 0 && u > 1 - s.extFrac;
    rings.push({
      y,
      r: bell(u) - wall,
      color: lerp3(s.innerThroat, s.innerExit, Math.pow(u, 0.7)),
      glow: Math.pow(1 - u, 1.6),
      ext: isExt ? 1 : 0,
      inner: 1,
    });
  }
  // Exit lip.
  const lipColor: [number, number, number] = kind.startsWith('rvac') ? [0.7, 0.7, 0.71] : [0.5, 0.48, 0.45];
  rings.push({ y: 0, r: s.exitR - wall, color: lipColor, glow: 0, ext: s.extFrac > 0 ? 1 : 0, crease: true });
  rings.push({ y: 0, r: s.exitR + 0.012, color: lipColor, glow: 0, ext: s.extFrac > 0 ? 1 : 0, crease: true });
  if (!kind.startsWith('rvac')) {
    // Raptor's stiffening ring just above the exit.
    rings.push({ y: 0.07, r: s.exitR + 0.02, color: lipColor, glow: 0, ext: 0, crease: true });
    rings.push({ y: 0.12, r: bell(1 - 0.12 / s.bellLen) + 0.004, color: s.outerExit, glow: 0, ext: 0, crease: true });
  }
  // Outer wall, exit -> throat.
  for (let i = 1; i <= n; i++) {
    const u = 1 - i / n;
    const y = (1 - u) * s.bellLen;
    if (!kind.startsWith('rvac') && y < 0.13) continue;
    const isExt = s.extFrac > 0 && u > 1 - s.extFrac;
    const c = isExt && s.extOuter ? s.extOuter : lerp3(s.outerTop, s.outerExit, Math.pow(u, 1.2));
    rings.push({ y, r: bell(u), color: c, glow: 0, ext: isExt ? 1 : 0 });
    if (s.extFrac > 0 && Math.abs(u - (1 - s.extFrac)) < 0.5 / n) {
      // Flange between the regen section and the extension.
      rings.push({ y: y + 0.01, r: bell(u) + 0.05, color: [0.3, 0.29, 0.28], glow: 0, ext: 0, crease: true });
      rings.push({ y: y + 0.07, r: bell(u) + 0.05, color: [0.3, 0.29, 0.28], glow: 0, ext: 0, crease: true });
    }
  }
  if (!withHead) {
    rings.push({ y: s.bellLen + 0.25, r: s.throatR + 0.12, color: [0.15, 0.15, 0.16], glow: 0, ext: 0, crease: true });
    rings.push({ y: s.bellLen + 0.3, r: 0.01, color: [0.12, 0.12, 0.13], glow: 0, ext: 0 });
    return rings;
  }
  const by = s.bellLen;
  if (s.head === 'r2') {
    const dark: [number, number, number] = [0.13, 0.13, 0.14];
    const mid: [number, number, number] = [0.3, 0.29, 0.28];
    rings.push({ y: by + 0.05, r: 0.3, color: dark, glow: 0, ext: 0, crease: true });
    rings.push({ y: by + 0.55, r: 0.33, color: mid, glow: 0, ext: 0 });
    rings.push({ y: by + 0.62, r: 0.46, color: dark, glow: 0, ext: 0, crease: true });
    rings.push({ y: s.topY - 0.25, r: 0.5, color: dark, glow: 0, ext: 0, crease: true });
    rings.push({ y: s.topY, r: 0.2, color: dark, glow: 0, ext: 0, crease: true });
    rings.push({ y: s.topY + 0.02, r: 0.01, color: dark, glow: 0, ext: 0 });
  } else {
    // Raptor 3: one smooth shroud over the powerhead.
    const shroud: [number, number, number] = [0.4, 0.4, 0.41];
    rings.push({ y: by + 0.02, r: s.throatR + 0.05, color: shroud, glow: 0, ext: 0, crease: true });
    rings.push({ y: by + 0.35, r: 0.42, color: shroud, glow: 0, ext: 0 });
    rings.push({ y: s.topY - 0.3, r: 0.6, color: shroud, glow: 0, ext: 0 });
    rings.push({ y: s.topY, r: 0.45, color: shroud, glow: 0, ext: 0, crease: true });
    rings.push({ y: s.topY + 0.01, r: 0.01, color: shroud, glow: 0, ext: 0 });
  }
  return rings;
}

/** Builds the engine geometry (position, normal, color, aPart), axis +Y, exit plane at y = 0. */
export function engineGeometry(kind: EngineKind, q: Quality, withHead: boolean): THREE.BufferGeometry {
  const seg = q === 'high' ? 28 : 16;
  const rings = engineProfile(kind, q === 'high' ? 1 : 0.6, withHead);
  // Expand creases into duplicated rings with one-sided normals.
  type R2 = Ring & { nr: number; ny: number };
  const segN = (a: Ring, b: Ring): [number, number] => {
    const dy = b.y - a.y;
    const dr = b.r - a.r;
    const l = Math.hypot(dy, dr) || 1;
    return [dy / l, -dr / l];
  };
  const out: R2[] = [];
  for (let i = 0; i < rings.length; i++) {
    const p = rings[i];
    const prev = i > 0 ? segN(rings[i - 1], p) : null;
    const next = i < rings.length - 1 ? segN(p, rings[i + 1]) : null;
    if (p.crease && prev && next) {
      out.push({ ...p, nr: prev[0], ny: prev[1] });
      out.push({ ...p, nr: next[0], ny: next[1] });
    } else {
      const a = prev ?? next ?? [1, 0];
      const b = next ?? prev ?? [1, 0];
      const l = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1;
      out.push({ ...p, nr: (a[0] + b[0]) / l, ny: (a[1] + b[1]) / l });
    }
  }
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  for (const r of out) {
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      pos.push(r.r * sn, r.y, r.r * cs);
      nrm.push(r.nr * sn, r.ny, r.nr * cs);
      col.push(r.color[0], r.color[1], r.color[2]);
      part.push(r.glow, r.ext, r.inner ?? 0);
    }
  }
  const cols = seg + 1;
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i];
    const b = out[i + 1];
    if (a.y === b.y && a.r === b.r) continue;
    for (let j = 0; j < seg; j++) {
      const a0 = i * cols + j;
      const a1 = a0 + 1;
      const b0 = (i + 1) * cols + j;
      const b1 = b0 + 1;
      idx.push(a0, a1, b0, a1, b1, b0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Engine material: vertex-coloured metal; per-instance aGlow (x = combustion glow 0..1,
 * y = extension heat 0..1) adds emission inside the bell and on the RVac extension.
 */
export function createEngineMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.8, roughness: 0.46 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 aPart;\nattribute vec2 aGlow;\nvarying vec3 vPart;\nvarying vec2 vGlow;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart = aPart;\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPart;\nvarying vec2 vGlow;')
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        // Sooty inner wall: rough and mostly non-metallic.
        roughnessFactor = mix(roughnessFactor, 0.8, vPart.z);
        metalnessFactor = mix(metalnessFactor, 0.25, vPart.z);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.78, 0.55) * (vPart.x * vGlow.x * 7.0);
        totalEmissiveRadiance += vec3(1.0, 0.22, 0.04) * (vPart.y * vGlow.y * 1.4);`,
      );
  };
  m.customProgramCacheKey = () => 'veh-engine-v1';
  return m;
}

/** Exit radius the geometry was built with (for instance scaling). */
export function engineExitRadius(kind: EngineKind): number {
  return SPECS[kind].exitR;
}
