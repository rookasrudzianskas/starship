import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { StarlinkSwarm } from '@/lib/three/contracts';
import { SharedScope, canvasTexture, context2d, makeCanvas, seededRandom } from '@/lib/three/vehicles/procedural';

/**
 * Starlink satellites leaving the Pez dispenser, one InstancedMesh per swarm (one draw call).
 * 'starlink-sim': the flat steel mass simulators flown on the early door tests (2.7 × 0.3 × 6.4 m).
 * 'starlink-v3': a flat-panel bus (2.9 × 0.35 × 7.5 m) with its two long solar arrays still folded
 * into stacks on the top face, phased-array antenna tiles underneath.
 * Local axes: X width, Y thickness (+Y = solar array side), Z length.
 */

type Region = [number, number, number, number]; // u0, v0, u1, v1 in the atlas

const SOLAR: Region = [0, 0, 0.5, 0.5];
const ANTENNA: Region = [0.5, 0, 1, 0.5];
const SIDE: Region = [0, 0.5, 0.5, 1];
const EDGE: Region = [0.5, 0.5, 1, 0.75];
const SIM: Region = [0.5, 0.75, 1, 1];

const ATLAS_KEY = 'fx:starlinkAtlas';
const ORM_KEY = 'fx:starlinkOrm';
const N = 512;

function px(r: Region): { x: number; y: number; w: number; h: number } {
  return { x: r[0] * N, y: r[1] * N, w: (r[2] - r[0]) * N, h: (r[3] - r[1]) * N };
}

/** Colour atlas (sRGB). */
function makeAtlas(): THREE.CanvasTexture {
  const c = makeCanvas(N, N);
  const g = context2d(c);
  const rnd = seededRandom(5150);
  // Solar cells: deep blue glass cells on a silver grid.
  {
    const { x, y, w, h } = px(SOLAR);
    g.fillStyle = '#8a929c';
    g.fillRect(x, y, w, h);
    const cols = 8;
    const rows = 12;
    const cw = w / cols;
    const ch = h / rows;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = 18 + Math.floor(rnd() * 10);
        g.fillStyle = `rgb(${k - 8}, ${k + 4}, ${k + 40})`;
        g.fillRect(x + i * cw + 1.5, y + j * ch + 1.5, cw - 3, ch - 3);
        // Bus bars inside each cell.
        g.fillStyle = 'rgba(150,160,175,0.35)';
        g.fillRect(x + i * cw + cw * 0.33, y + j * ch + 1.5, 1, ch - 3);
        g.fillRect(x + i * cw + cw * 0.66, y + j * ch + 1.5, 1, ch - 3);
      }
    }
    // Panel hinge line across the middle of the fold stack.
    g.fillStyle = '#6d747d';
    g.fillRect(x, y + h / 2 - 2, w, 4);
  }
  // Antenna face: dark grey bus with lighter phased-array tiles.
  {
    const { x, y, w, h } = px(ANTENNA);
    g.fillStyle = '#3a3e45';
    g.fillRect(x, y, w, h);
    // A few large phased-array panels (light grey radomes) plus small fittings.
    const panels: Array<[number, number, number, number]> = [
      [0.06, 0.05, 0.42, 0.28],
      [0.52, 0.05, 0.42, 0.28],
      [0.06, 0.38, 0.88, 0.22],
      [0.06, 0.66, 0.42, 0.28],
      [0.52, 0.66, 0.42, 0.28],
    ];
    for (const [px0, py0, pw, ph] of panels) {
      const k = 96 + Math.floor(rnd() * 14);
      g.fillStyle = `rgb(${k}, ${k + 2}, ${k + 6})`;
      g.fillRect(x + px0 * w, y + py0 * h, pw * w, ph * h);
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(x + px0 * w, y + (py0 + ph) * h - 2, pw * w, 2);
    }
  }
  // Bus sides: grey panels with seams.
  {
    const { x, y, w, h } = px(SIDE);
    g.fillStyle = '#5a5e64';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#44474c';
    for (let k = 1; k < 6; k++) g.fillRect(x + (w * k) / 6, y, 2, h);
    g.fillRect(x, y + h * 0.5, w, 2);
  }
  // Folded array stack edges: thin layers.
  {
    const { x, y, w, h } = px(EDGE);
    for (let k = 0; k < 16; k++) {
      g.fillStyle = k % 2 === 0 ? '#1d2433' : '#7c838d';
      g.fillRect(x, y + (h * k) / 16, w, h / 16);
    }
  }
  // Mass simulator: plain dark steel plate with bolt rows.
  {
    const { x, y, w, h } = px(SIM);
    g.fillStyle = '#323a48';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#4a5260';
    g.fillRect(x, y, w, 3);
    g.fillRect(x, y + h - 3, w, 3);
    g.fillRect(x, y, 3, h);
    g.fillRect(x + w - 3, y, 3, h);
    g.fillStyle = '#596170';
    for (let k = 0; k < 12; k++) {
      g.fillRect(x + 8 + (k * (w - 16)) / 11, y + 8, 2, 2);
      g.fillRect(x + 8 + (k * (w - 16)) / 11, y + h - 10, 2, 2);
    }
  }
  return canvasTexture(c, { srgb: true, repeat: false, mipmaps: true, anisotropy: 4 });
}

/** Occlusion/roughness/metalness atlas (linear): R = 1, G = roughness, B = metalness. */
function makeOrm(): THREE.CanvasTexture {
  const c = makeCanvas(N, N);
  const g = context2d(c);
  const fill = (r: Region, rough: number, metal: number) => {
    const { x, y, w, h } = px(r);
    g.fillStyle = `rgb(255, ${Math.round(rough * 255)}, ${Math.round(metal * 255)})`;
    g.fillRect(x, y, w, h);
  };
  fill(SOLAR, 0.16, 0.0);
  fill(ANTENNA, 0.6, 0.2);
  fill(SIDE, 0.45, 0.6);
  fill(EDGE, 0.5, 0.35);
  fill(SIM, 0.42, 0.65);
  // Silver grid between solar cells is metallic.
  {
    const { x, y, w, h } = px(SOLAR);
    g.fillStyle = `rgb(255, ${Math.round(0.35 * 255)}, ${Math.round(0.85 * 255)})`;
    const cols = 8;
    const rows = 12;
    for (let i = 0; i <= cols; i++) g.fillRect(x + (i * w) / cols - 1.5, y, 3, h);
    for (let j = 0; j <= rows; j++) g.fillRect(x, y + (j * h) / rows - 1.5, w, 3);
  }
  return canvasTexture(c, { srgb: false, repeat: false, mipmaps: true, anisotropy: 4 });
}

interface FaceRegions {
  px: Region;
  nx: Region;
  py: Region;
  ny: Region;
  pz: Region;
  nz: Region;
}

/** Box with each face mapped to an atlas region (BoxGeometry face order: +x, -x, +y, -y, +z, -z). */
function atlasBox(w: number, h: number, d: number, cx: number, cy: number, cz: number, f: FaceRegions): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const order: Region[] = [f.px, f.nx, f.py, f.ny, f.pz, f.nz];
  for (let face = 0; face < 6; face++) {
    const r = order[face];
    for (let k = 0; k < 4; k++) {
      const i = face * 4 + k;
      uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
    }
  }
  g.translate(cx, cy, cz);
  return g;
}

function makeGeometry(kind: 'starlink-sim' | 'starlink-v3'): THREE.BufferGeometry {
  if (kind === 'starlink-sim') {
    return atlasBox(2.7, 0.3, 6.4, 0, 0, 0, { px: SIM, nx: SIM, py: SIM, ny: SIM, pz: SIM, nz: SIM });
  }
  const parts: THREE.BufferGeometry[] = [];
  const W = 2.9;
  const H = 0.35;
  const L = 7.5;
  parts.push(atlasBox(W, H, L, 0, 0, 0, { px: SIDE, nx: SIDE, py: ANTENNA, ny: ANTENNA, pz: SIDE, nz: SIDE }));
  // Two folded solar array stacks on the top face.
  const aw = 2.72;
  const ah = 0.12;
  const al = 3.62;
  for (const z of [-1.86, 1.86]) {
    parts.push(atlasBox(aw, ah, al, 0, H / 2 + ah / 2, z, { px: EDGE, nx: EDGE, py: SOLAR, ny: EDGE, pz: EDGE, nz: EDGE }));
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!merged) throw new Error('Starlink geometry merge failed');
  return merged;
}

export function createStarlinkSwarm(capacity: number, kind: 'starlink-sim' | 'starlink-v3'): StarlinkSwarm {
  const cap = Math.max(1, Math.floor(capacity));
  const scope = new SharedScope();
  const map = scope.get(ATLAS_KEY, makeAtlas);
  const orm = scope.get(ORM_KEY, makeOrm);
  const geometry = makeGeometry(kind);
  const material = new THREE.MeshStandardMaterial({
    map,
    roughnessMap: orm,
    metalnessMap: orm,
    roughness: 1,
    metalness: 1,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.name = `starlink-${kind}`;
  mesh.count = 0;
  // Positions are rewritten camera-relative every frame, so a cached bounding sphere would be stale.
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const object = new THREE.Group();
  object.name = 'starlink-swarm';
  object.add(mesh);
  const m = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);

  return {
    object,
    setCount(n: number) {
      mesh.count = Math.min(Math.max(Math.floor(n), 0), cap);
    },
    setSatellite(i: number, position: THREE.Vector3, quaternion: THREE.Quaternion) {
      if (i < 0 || i >= cap) return;
      m.compose(position, quaternion, one);
      mesh.setMatrixAt(i, m);
    },
    commit() {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, Math.max(mesh.count, 1) * 16);
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      object.remove(mesh);
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      scope.releaseAll();
    },
  };
}
