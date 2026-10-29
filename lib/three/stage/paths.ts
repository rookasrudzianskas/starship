import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { EARTH_J2, EARTH_J2_RADIUS, EARTH_MU, EARTH_OMEGA, EARTH_RADIUS, type FlightEvent, type FlightResult, type Track } from '@/lib/sim/types';
import { sampleIndex } from '@/lib/telemetry';
import type { V3 } from './geo';

export const BOOSTER_COLOR = 0xff6f5e;
export const SHIP_COLOR = 0x67a6ff;

/** A thick polyline through a track's positions, drawn relative to a fixed origin for float precision. */
class PathLine {
  readonly line: Line2;
  readonly material: LineMaterial;
  private times = new Float64Array(0);
  private segments = 0;

  constructor(color: number, width: number, opacity: number, dashed = false) {
    this.material = new LineMaterial({
      color,
      linewidth: width,
      transparent: true,
      opacity,
      depthWrite: false,
      dashed,
      dashSize: 3,
      gapSize: 3,
      worldUnits: false,
    });
    this.line = new Line2(new LineGeometry(), this.material);
    this.line.frustumCulled = false;
  }

  /** Fill from a track, keeping at most `maxPoints` (more where the path bends). */
  setTrack(track: Track, origin: V3, maxPoints = 3000): void {
    const n = track.n;
    const step = Math.max(1, Math.floor(n / maxPoints));
    const idx: number[] = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    this.setPoints(
      idx.map((i) => [track.pos[i * 3] - origin[0], track.pos[i * 3 + 1] - origin[1], track.pos[i * 3 + 2] - origin[2]]),
      idx.map((i) => track.t[i]),
    );
  }

  setPoints(points: number[][], times: number[]): void {
    const flat = new Float32Array(Math.max(2, points.length) * 3);
    points.forEach((p, k) => flat.set(p, k * 3));
    if (points.length === 1) flat.set(points[0], 3);
    const geom = new LineGeometry();
    geom.setPositions(flat);
    this.line.geometry.dispose();
    this.line.geometry = geom;
    if (this.material.dashed) this.line.computeLineDistances();
    this.times = Float64Array.from(times.length ? times : [0]);
    this.segments = Math.max(0, points.length - 1);
    (this.line.geometry as LineGeometry).instanceCount = this.segments;
  }

  /** Draw only the part up to time t. */
  showUntil(t: number): void {
    const n = this.times.length;
    if (n < 2) return;
    const i = t >= this.times[n - 1] ? n - 1 : sampleIndex(this.times, n, t) + 1;
    (this.line.geometry as LineGeometry).instanceCount = Math.min(this.segments, Math.max(0, i));
  }

  showAll(): void {
    (this.line.geometry as LineGeometry).instanceCount = this.segments;
  }

  dispose(): void {
    this.line.geometry.dispose();
    this.material.dispose();
  }
}

// --------------------------------------------------------------- coast

function gravity(x: number, y: number, z: number, out: Float64Array): void {
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2);
  const mu_r3 = EARTH_MU / (r2 * r);
  const k = 1.5 * EARTH_J2 * (EARTH_J2_RADIUS * EARTH_J2_RADIUS) / r2;
  const zr2 = (z * z) / r2;
  out[0] = -mu_r3 * x * (1 + k * (1 - 5 * zr2));
  out[1] = -mu_r3 * y * (1 + k * (1 - 5 * zr2));
  out[2] = -mu_r3 * z * (1 + k * (3 - 5 * zr2));
}

/**
 * Engines-off coast from an ECEF state, ignoring drag: RK4 in the inertial frame aligned with ECEF at the
 * start, points rotated back into ECEF. Returns ECEF points and the impact point (or null if it stays up).
 */
export function predictCoast(pos: V3, vel: V3, maxSeconds: number, steps = 360): { points: V3[]; impact: V3 | null } {
  const w = EARTH_OMEGA;
  // State [x, y, z, vx, vy, vz] in the inertial frame that coincides with ECEF now.
  const s = new Float64Array([pos[0], pos[1], pos[2], vel[0] - w * pos[1], vel[1] + w * pos[0], vel[2]]);
  const k1 = new Float64Array(6);
  const k2 = new Float64Array(6);
  const k3 = new Float64Array(6);
  const k4 = new Float64Array(6);
  const tmp = new Float64Array(6);
  const acc = new Float64Array(3);
  const deriv = (st: Float64Array, out: Float64Array) => {
    gravity(st[0], st[1], st[2], acc);
    out[0] = st[3];
    out[1] = st[4];
    out[2] = st[5];
    out[3] = acc[0];
    out[4] = acc[1];
    out[5] = acc[2];
  };
  const stage = (k: Float64Array, h: number) => {
    for (let i = 0; i < 6; i++) tmp[i] = s[i] + k[i] * h;
    return tmp;
  };

  const dt = maxSeconds / steps;
  const pts: V3[] = [[pos[0], pos[1], pos[2]]];
  let impact: V3 | null = null;
  for (let n = 1; n <= steps; n++) {
    const px = s[0];
    const py = s[1];
    const pz = s[2];
    deriv(s, k1);
    deriv(stage(k1, dt / 2), k2);
    deriv(stage(k2, dt / 2), k3);
    deriv(stage(k3, dt), k4);
    for (let i = 0; i < 6; i++) s[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);

    // Back to ECEF: rotate by −ωt about Z.
    const c = Math.cos(-w * n * dt);
    const sn = Math.sin(-w * n * dt);
    const r = Math.hypot(s[0], s[1], s[2]);
    if (r <= EARTH_RADIUS) {
      const pr = Math.hypot(px, py, pz);
      const f = (pr - EARTH_RADIUS) / Math.max(1e-6, pr - r);
      const ix = px + (s[0] - px) * f;
      const iy = py + (s[1] - py) * f;
      const iz = pz + (s[2] - pz) * f;
      impact = [ix * c - iy * sn, ix * sn + iy * c, iz];
      pts.push(impact);
      break;
    }
    pts.push([s[0] * c - s[1] * sn, s[0] * sn + s[1] * c, s[2]]);
  }
  return { points: pts, impact };
}

// --------------------------------------------------------------- gates

export interface Gate {
  event: FlightEvent;
  mesh: THREE.Mesh;
  pos: V3;
}

const ringGeometry = new THREE.RingGeometry(0.92, 1, 64);

export function createGates(result: FlightResult): Gate[] {
  const gates: Gate[] = [];
  for (const e of result.events) {
    if (!e.major || e.key === 'liftoff' || e.key === 'intervention') continue;
    const color = e.vehicle === 'booster' ? BOOSTER_COLOR : e.vehicle === 'ship' ? SHIP_COLOR : 0xffffff;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(ringGeometry, mat);
    mesh.frustumCulled = false;
    // Face the ring along the direction of travel at the event.
    const track = e.vehicle === 'booster' ? result.booster : result.ship;
    const i = sampleIndex(track.t, track.n, e.t);
    const v = new THREE.Vector3(track.vel[i * 3], track.vel[i * 3 + 1], track.vel[i * 3 + 2]);
    if (v.lengthSq() < 1) v.set(e.pos[0], e.pos[1], e.pos[2]);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v.normalize());
    gates.push({ event: e, mesh, pos: [e.pos[0], e.pos[1], e.pos[2]] });
  }
  return gates;
}

export function disposeGates(gates: Gate[]): void {
  for (const g of gates) (g.mesh.material as THREE.Material).dispose();
}

// --------------------------------------------------------------- set

/** All trajectory lines for one result. */
export class TrajectoryLines {
  readonly group = new THREE.Group();
  readonly origin: V3;
  readonly flown: { booster: PathLine; ship: PathLine };
  readonly planned: { booster: PathLine; ship: PathLine };
  readonly real: { booster: PathLine; ship: PathLine };
  readonly coast: { booster: PathLine; ship: PathLine };
  readonly impact: { booster: THREE.Mesh; ship: THREE.Mesh };
  private realShown = false;

  constructor(origin: V3) {
    this.origin = [origin[0], origin[1], origin[2]];
    this.flown = { booster: new PathLine(BOOSTER_COLOR, 2.4, 0.95), ship: new PathLine(SHIP_COLOR, 2.4, 0.95) };
    this.planned = { booster: new PathLine(0xffffff, 1.4, 0.38), ship: new PathLine(0xffffff, 1.4, 0.38) };
    this.real = { booster: new PathLine(0xd8d8d8, 1.2, 0.5, true), ship: new PathLine(0xd8d8d8, 1.2, 0.5, true) };
    this.coast = { booster: new PathLine(0xffd9a0, 1.4, 0.7, true), ship: new PathLine(0xbfe0ff, 1.4, 0.7, true) };
    const impactGeom = new THREE.RingGeometry(0.55, 1, 40);
    const mk = (color: number) => {
      const m = new THREE.Mesh(impactGeom, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
      m.frustumCulled = false;
      return m;
    };
    this.impact = { booster: mk(0xffb08a), ship: mk(0x9cc8ff) };
    for (const l of [this.planned, this.real, this.flown, this.coast]) {
      this.group.add(l.booster.line, l.ship.line);
    }
    this.flown.booster.line.renderOrder = 3;
    this.flown.ship.line.renderOrder = 3;
    this.flown.booster.material.depthFunc = THREE.LessEqualDepth;
    this.flown.ship.material.depthFunc = THREE.LessEqualDepth;
    this.group.add(this.impact.booster, this.impact.ship);
  }

  setResult(result: FlightResult, baseline: FlightResult | null): void {
    this.flown.booster.setTrack(result.booster, this.origin);
    this.flown.ship.setTrack(result.ship, this.origin);
    this.planned.booster.setTrack(result.booster, this.origin);
    this.planned.ship.setTrack(result.ship, this.origin);
    this.realShown = baseline !== null && baseline !== result && baseline.scenarioKey !== result.scenarioKey;
    if (this.realShown && baseline) {
      this.real.booster.setTrack(baseline.booster, this.origin);
      this.real.ship.setTrack(baseline.ship, this.origin);
    }
  }

  setCoast(which: 'booster' | 'ship', points: V3[] | null, impact: V3 | null): void {
    const line = this.coast[which];
    if (!points || points.length < 2) {
      line.line.visible = false;
      this.impact[which].visible = false;
      return;
    }
    line.setPoints(
      points.map((p) => [p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]]),
      points.map((_, i) => i),
    );
    line.line.visible = true;
    const m = this.impact[which];
    m.visible = impact !== null;
    if (impact) {
      m.userData.ecef = impact;
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(impact[0], impact[1], impact[2]).normalize());
    }
  }

  /** Per frame: move with the camera, clip flown lines to t, set visibility and pixel resolution. */
  update(t: number, cameraEcef: V3, show: { flown: boolean; planned: boolean; coast: boolean }, width: number, height: number): void {
    this.group.position.set(this.origin[0] - cameraEcef[0], this.origin[1] - cameraEcef[1], this.origin[2] - cameraEcef[2]);
    for (const v of ['booster', 'ship'] as const) {
      this.flown[v].line.visible = show.flown;
      this.flown[v].showUntil(t);
      this.planned[v].line.visible = show.planned;
      this.real[v].line.visible = show.planned && this.realShown;
      if (!show.coast) {
        this.coast[v].line.visible = false;
        this.impact[v].visible = false;
      }
      const m = this.impact[v];
      if (m.visible && m.userData.ecef) {
        const p = m.userData.ecef as V3;
        m.position.set(p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]);
        const d = Math.hypot(p[0] - cameraEcef[0], p[1] - cameraEcef[1], p[2] - cameraEcef[2]);
        m.scale.setScalar(Math.max(30, d * 0.012));
      }
    }
    for (const l of [this.flown, this.planned, this.real, this.coast]) {
      l.booster.material.resolution.set(width, height);
      l.ship.material.resolution.set(width, height);
    }
  }

  dispose(): void {
    for (const l of [this.flown, this.planned, this.real, this.coast]) {
      l.booster.dispose();
      l.ship.dispose();
    }
    this.impact.booster.geometry.dispose();
    (this.impact.booster.material as THREE.Material).dispose();
    (this.impact.ship.material as THREE.Material).dispose();
  }
}
