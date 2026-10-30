import * as THREE from 'three';

/**
 * Geometry accumulation helpers for the pad. Static structures are appended into one MeshBuilder per
 * material (one draw call each); repeated lattice members go into InstanceSets drawn as InstancedMeshes.
 * UVs are in metres so tiling textures keep a constant world scale; vertex colours carry per-part tint
 * and baked soot.
 */

type V3 = THREE.Vector3;

const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _col = new THREE.Color();
const _nm = new THREE.Matrix3();
const _nax = new THREE.Vector3();
const _naz = new THREE.Vector3();

/** Builds an orthonormal right-handed frame with `ay` along `dir` and `ax` as close as possible to `hint`. */
function frameFromDir(dir: V3, hint: V3, ax: V3, ay: V3, az: V3): void {
  ay.copy(dir).normalize();
  ax.copy(hint).addScaledVector(ay, -hint.dot(ay));
  if (ax.lengthSq() < 1e-8) {
    ax.set(1, 0, 0).addScaledVector(ay, -ay.x);
    if (ax.lengthSq() < 1e-8) ax.set(0, 0, 1).addScaledVector(ay, -ay.z);
  }
  ax.normalize();
  az.crossVectors(ax, ay).normalize();
}

export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private cr = 1;
  private cg = 1;
  private cb = 1;
  private ca = 1;

  /** `alpha`: vertex colours carry a fourth, alpha component (for a material with vertex alpha). */
  constructor(private readonly alpha = false) {}

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get isEmpty(): boolean {
    return this.idx.length === 0;
  }

  /** Sets the vertex colour for following primitives (sRGB hex/strings are converted to linear). */
  color(c: THREE.ColorRepresentation): this {
    _col.set(c);
    this.cr = _col.r;
    this.cg = _col.g;
    this.cb = _col.b;
    return this;
  }

  /** Sets the vertex alpha for following primitives (only kept by a builder made with alpha). */
  opacity(a: number): this {
    this.ca = a;
    return this;
  }

  /** Sets the vertex colour from linear components. */
  rgb(r: number, g: number, b: number): this {
    this.cr = r;
    this.cg = g;
    this.cb = b;
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(this.cr, this.cg, this.cb);
    if (this.alpha) this.col.push(this.ca);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): this {
    this.idx.push(a, b, c);
    return this;
  }

  /** Planar quad, counter-clockwise when seen from its front. UVs in metres along the p0→p1 and p0→p3 edges. */
  quad(p0: V3, p1: V3, p2: V3, p3: V3, u0 = 0, v0 = 0): this {
    _e1.subVectors(p1, p0);
    _e2.subVectors(p3, p0);
    _n.crossVectors(_e1, _e2).normalize();
    const w = _e1.length();
    const h = _e2.length();
    const a = this.vertex(p0.x, p0.y, p0.z, _n.x, _n.y, _n.z, u0, v0);
    const b = this.vertex(p1.x, p1.y, p1.z, _n.x, _n.y, _n.z, u0 + w, v0);
    const c = this.vertex(p2.x, p2.y, p2.z, _n.x, _n.y, _n.z, u0 + w, v0 + h);
    const d = this.vertex(p3.x, p3.y, p3.z, _n.x, _n.y, _n.z, u0, v0 + h);
    this.idx.push(a, b, c, a, c, d);
    return this;
  }

  /** Triangle with a flat normal (counter-clockwise front). UVs from the planar x/z or x/y projection. */
  triangle(p0: V3, p1: V3, p2: V3): this {
    _e1.subVectors(p1, p0);
    _e2.subVectors(p2, p0);
    _n.crossVectors(_e1, _e2).normalize();
    const flat = Math.abs(_n.y) > 0.7;
    const uvOf = (p: V3): [number, number] => (flat ? [p.x, p.z] : [p.x + p.z, p.y]);
    const [u0, v0] = uvOf(p0);
    const [u1, v1] = uvOf(p1);
    const [u2, v2] = uvOf(p2);
    const a = this.vertex(p0.x, p0.y, p0.z, _n.x, _n.y, _n.z, u0, v0);
    const b = this.vertex(p1.x, p1.y, p1.z, _n.x, _n.y, _n.z, u1, v1);
    const c = this.vertex(p2.x, p2.y, p2.z, _n.x, _n.y, _n.z, u2, v2);
    this.idx.push(a, b, c);
    return this;
  }

  /** Box centred at c with a right-handed orthonormal frame (ax, ay, az) and half extents. */
  orientedBox(c: V3, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number, skipBottom = false): this {
    // Each face: centre, U, V with U × V = outward normal.
    const face = (n: V3, s: number, u: V3, hu: number, v: V3, hv: number, hn: number) => {
      _c.copy(c).addScaledVector(n, s * hn);
      _p0.copy(_c).addScaledVector(u, -hu).addScaledVector(v, -hv);
      _p1.copy(_c).addScaledVector(u, hu).addScaledVector(v, -hv);
      _p2.copy(_c).addScaledVector(u, hu).addScaledVector(v, hv);
      _p3.copy(_c).addScaledVector(u, -hu).addScaledVector(v, hv);
      this.quad(_p0, _p1, _p2, _p3);
    };
    // Side faces keep U horizontal (perpendicular to ay) and V along ay, so tiling textures stay upright.
    const naz = _naz.copy(az).negate();
    const nax = _nax.copy(ax).negate();
    face(ax, 1, naz, hz, ay, hy, hx); // +X: -az × ay = ax
    face(ax, -1, az, hz, ay, hy, hx); // -X: az × ay = -ax
    face(ay, 1, az, hz, ax, hx, hy); // +Y: az × ax = ay
    if (!skipBottom) face(ay, -1, ax, hx, az, hz, hy); // -Y: ax × az = -ay
    face(az, 1, ax, hx, ay, hy, hz); // +Z: ax × ay = az
    face(az, -1, nax, hx, ay, hy, hz); // -Z: -ax × ay = -az
    return this;
  }

  /** Axis-aligned box from its min and max corners. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): this {
    _c.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const ax = new THREE.Vector3(1, 0, 0);
    const ay = new THREE.Vector3(0, 1, 0);
    const az = new THREE.Vector3(0, 0, 1);
    return this.orientedBox(_c.clone(), ax, ay, az, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2);
  }

  /** Box centred at (cx, cy, cz), size (sx, sy, sz), rotated by `rotY` radians about +Y. */
  boxRotY(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rotY: number): this {
    const c = Math.cos(rotY);
    const s = Math.sin(rotY);
    const ax = new THREE.Vector3(c, 0, -s);
    const ay = new THREE.Vector3(0, 1, 0);
    const az = new THREE.Vector3(s, 0, c);
    return this.orientedBox(new THREE.Vector3(cx, cy, cz), ax, ay, az, sx / 2, sy / 2, sz / 2);
  }

  /** Rectangular beam along a→b; `w` is measured along `hint` (projected), `d` across both. */
  beam(a: V3, b: V3, w: number, d: number, hint: V3 = new THREE.Vector3(0, 1, 0)): this {
    _ay.subVectors(b, a);
    const len = _ay.length();
    if (len < 1e-6) return this;
    frameFromDir(_ay, hint, _ax, _ay, _az);
    const c = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    return this.orientedBox(c, _ax.clone(), _ay.clone(), _az.clone(), w / 2, len / 2, d / 2);
  }

  /** Cylinder along a→b with radius r (UV u = arc length, v = distance along the axis, metres). */
  tube(a: V3, b: V3, r: number, segments = 10, caps = false, r2 = r): this {
    _ay.subVectors(b, a);
    const len = _ay.length();
    if (len < 1e-6) return this;
    frameFromDir(_ay, new THREE.Vector3(1, 0, 0), _ax, _ay, _az);
    const ax = _ax.clone();
    const ay = _ay.clone();
    const az = _az.clone();
    const slope = (r - r2) / len;
    const base = this.vertexCount;
    for (let i = 0; i <= segments; i++) {
      const th = (i / segments) * Math.PI * 2;
      const cx = Math.cos(th);
      const sz = Math.sin(th);
      const nx = ax.x * cx + az.x * sz;
      const ny = ax.y * cx + az.y * sz;
      const nz = ax.z * cx + az.z * sz;
      // Normal tilts along the axis for tapered tubes.
      const nlen = Math.sqrt(1 + slope * slope);
      const tnx = (nx + ay.x * slope) / nlen;
      const tny = (ny + ay.y * slope) / nlen;
      const tnz = (nz + ay.z * slope) / nlen;
      this.vertex(a.x + nx * r, a.y + ny * r, a.z + nz * r, tnx, tny, tnz, th * r, 0);
      this.vertex(b.x + nx * r2, b.y + ny * r2, b.z + nz * r2, tnx, tny, tnz, th * r, len);
    }
    for (let i = 0; i < segments; i++) {
      const i0 = base + i * 2;
      // Winding: outward faces counter-clockwise (axis × tangent points outwards).
      this.idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
    if (caps) {
      for (const [p, rr, sgn] of [
        [a, r, -1],
        [b, r2, 1],
      ] as Array<[V3, number, number]>) {
        const ci = this.vertex(p.x, p.y, p.z, ay.x * sgn, ay.y * sgn, ay.z * sgn, 0, 0);
        const ring = this.vertexCount;
        for (let i = 0; i <= segments; i++) {
          const th = (i / segments) * Math.PI * 2;
          const nx = ax.x * Math.cos(th) + az.x * Math.sin(th);
          const ny = ax.y * Math.cos(th) + az.y * Math.sin(th);
          const nz = ax.z * Math.cos(th) + az.z * Math.sin(th);
          this.vertex(p.x + nx * rr, p.y + ny * rr, p.z + nz * rr, ay.x * sgn, ay.y * sgn, ay.z * sgn, nx * rr, nz * rr);
        }
        for (let i = 0; i < segments; i++) {
          if (sgn > 0) this.idx.push(ci, ring + i + 1, ring + i);
          else this.idx.push(ci, ring + i, ring + i + 1);
        }
      }
    }
    return this;
  }

  /**
   * Surface of revolution about the vertical axis through (cx, cz). `profile` is [radius, y] from bottom
   * to top. UVs: u = arc length at the largest radius, v = profile arc length (metres).
   */
  lathe(profile: Array<[number, number]>, segments: number, cx: number, cz: number, y0 = 0): this {
    const rMax = profile.reduce((m, p) => Math.max(m, p[0]), 0);
    const base = this.vertexCount;
    // Per-profile-point normals from neighbouring segments.
    const n = profile.length;
    const pn: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const a = profile[Math.max(0, i - 1)];
      const b = profile[Math.min(n - 1, i + 1)];
      const dr = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dr, dy) || 1;
      pn.push([dy / l, -dr / l]);
    }
    let vAcc = 0;
    const vs: number[] = [0];
    for (let i = 1; i < n; i++) {
      vAcc += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
      vs.push(vAcc);
    }
    for (let s = 0; s <= segments; s++) {
      const th = (s / segments) * Math.PI * 2;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      for (let i = 0; i < n; i++) {
        const [r, y] = profile[i];
        this.vertex(cx + c * r, y0 + y, cz + sn * r, c * pn[i][0], pn[i][1], sn * pn[i][0], th * rMax, vs[i]);
      }
    }
    for (let s = 0; s < segments; s++) {
      for (let i = 0; i < n - 1; i++) {
        const a = base + s * n + i;
        const b = base + (s + 1) * n + i;
        this.idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    return this;
  }

  /** Appends a (possibly indexed) geometry transformed by `m`, using the current vertex colour. */
  geometry(g: THREE.BufferGeometry, m?: THREE.Matrix4): this {
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    if (!pos) return this;
    const base = this.vertexCount;
    if (m) _nm.getNormalMatrix(m);
    const v = new THREE.Vector3();
    const nn = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (m) v.applyMatrix4(m);
      if (nor) {
        nn.fromBufferAttribute(nor, i);
        if (m) nn.applyMatrix3(_nm).normalize();
      } else nn.set(0, 1, 0);
      this.vertex(v.x, v.y, v.z, nn.x, nn.y, nn.z, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) this.idx.push(base + i);
    return this;
  }

  /**
   * Darkens every vertex added since `from` by f(x, y, z) (baked soot/grime). `f` is a perceptual
   * (display-space) factor; it is converted to linear so 0.5 really looks half as bright.
   */
  shade(f: (x: number, y: number, z: number) => number, from = 0): this {
    const stride = this.alpha ? 4 : 3;
    for (let i = from; i < this.vertexCount; i++) {
      const k = Math.pow(Math.max(0, f(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2])), 2.2);
      this.col[i * stride] *= k;
      this.col[i * stride + 1] *= k;
      this.col[i * stride + 2] *= k;
    }
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, this.alpha ? 4 : 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Transforms for instanced unit primitives: a unit box (BoxGeometry(1,1,1)) stretched into beams and a
 * unit cylinder (radius 1, height 1, centred) stretched into tubes. Each instance has its own colour.
 */
export class InstanceSet {
  private mats: number[] = [];
  private cols: number[] = [];
  private m = new THREE.Matrix4();

  get count(): number {
    return this.cols.length / 3;
  }

  private push(color: THREE.ColorRepresentation): void {
    this.m.toArray(this.mats, this.mats.length);
    _col.set(color);
    this.cols.push(_col.r, _col.g, _col.b);
  }

  /** Box beam a→b; `w` along `hint` (projected perpendicular to the beam), `d` across. */
  beam(a: V3, b: V3, w: number, d: number, hint: V3, color: THREE.ColorRepresentation): this {
    _ay.subVectors(b, a);
    const len = _ay.length();
    if (len < 1e-6) return this;
    frameFromDir(_ay, hint, _ax, _ay, _az);
    this.m.set(
      _ax.x * w, _ay.x * len, _az.x * d, (a.x + b.x) / 2,
      _ax.y * w, _ay.y * len, _az.y * d, (a.y + b.y) / 2,
      _ax.z * w, _ay.z * len, _az.z * d, (a.z + b.z) / 2,
      0, 0, 0, 1,
    );
    this.push(color);
    return this;
  }

  /** Round tube a→b with radius r (unit cylinder instance). */
  tube(a: V3, b: V3, r: number, color: THREE.ColorRepresentation): this {
    return this.beam(a, b, r, r, new THREE.Vector3(1, 0, 0), color);
  }

  toMesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.InstancedMesh {
    const n = this.count;
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(n, 1));
    mesh.count = n;
    mesh.instanceMatrix.array.set(this.mats);
    mesh.instanceMatrix.needsUpdate = true;
    if (n > 0) {
      const ic = new THREE.InstancedBufferAttribute(new Float32Array(this.cols), 3);
      mesh.instanceColor = ic;
    }
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
    return mesh;
  }
}

/** Writes a beam/tube transform between two points into `m` (unit primitive scaled to w × len × d). */
export function beamMatrix(a: V3, b: V3, w: number, d: number, hint: V3, m: THREE.Matrix4): THREE.Matrix4 {
  _ay.subVectors(b, a);
  const len = Math.max(_ay.length(), 1e-6);
  frameFromDir(_ay, hint, _ax, _ay, _az);
  return m.set(
    _ax.x * w, _ay.x * len, _az.x * d, (a.x + b.x) / 2,
    _ax.y * w, _ay.y * len, _az.y * d, (a.y + b.y) / 2,
    _ax.z * w, _ay.z * len, _az.z * d, (a.z + b.z) / 2,
    0, 0, 0, 1,
  );
}

export const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
