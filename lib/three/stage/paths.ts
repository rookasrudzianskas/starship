import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { FlightEvent, FlightResult, Track } from '@/lib/sim/types';
// Relative so the lines can be unit tested (vitest has no @/ alias).
import { sampleIndex } from '../../telemetry';
import type { CoastPrediction } from './coast';
import type { V3 } from './geo';

export const BOOSTER_COLOR = 0xff6f5e;
export const SHIP_COLOR = 0x67a6ff;

const AXIS_Z = new THREE.Vector3(0, 0, 1);
const vTmp = new THREE.Vector3();
const NO_TIMES = new Float64Array(0);

/**
 * A thick polyline drawn relative to a fixed origin for float precision. Segment buffers are kept and rewritten
 * in place when a new path fits, so a path that changes several times a second doesn't create GPU buffers.
 */
class PathLine {
  readonly line: Line2;
  readonly material: LineMaterial;
  private readonly dashed: boolean;
  private readonly dynamic: boolean;
  private geometry!: LineGeometry;
  /** Six floats per segment: start xyz, end xyz. */
  private segments!: Float32Array;
  private buffer!: THREE.InstancedInterleavedBuffer;
  /** Dashed lines: distance along the line at each segment's start and end. */
  private distances: Float32Array | null = null;
  private distanceBuffer: THREE.InstancedInterleavedBuffer | null = null;
  private capacity = 0;
  private count = 0;
  private times = new Float64Array(0);
  /** The segment whose end currently stands at the vehicle (see showUntil), and its original end. */
  private tipSegment = -1;
  private readonly tipSaved = new Float32Array(3);

  constructor(color: number, width: number, opacity: number, options: { dashed?: boolean; dynamic?: boolean } = {}) {
    this.dashed = options.dashed ?? false;
    this.dynamic = options.dynamic ?? false;
    this.material = new LineMaterial({
      color,
      linewidth: width,
      transparent: true,
      opacity,
      depthWrite: false,
      dashed: this.dashed,
      dashSize: 3,
      gapSize: 3,
      worldUnits: false,
    });
    this.allocate(1);
    this.line = new Line2(this.geometry, this.material);
    this.line.frustumCulled = false;
  }

  /** A fresh geometry with room for `segments` (the old one, if any, is released). */
  private allocate(segments: number): void {
    const old = this.geometry as LineGeometry | undefined;
    this.capacity = Math.max(1, segments);
    this.segments = new Float32Array(this.capacity * 6);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.segments, 6, 1);
    if (this.dynamic) this.buffer.setUsage(THREE.DynamicDrawUsage);
    const geometry = new LineGeometry();
    geometry.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    geometry.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    if (this.dashed) {
      this.distances = new Float32Array(this.capacity * 2);
      this.distanceBuffer = new THREE.InstancedInterleavedBuffer(this.distances, 2, 1);
      if (this.dynamic) this.distanceBuffer.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('instanceDistanceStart', new THREE.InterleavedBufferAttribute(this.distanceBuffer, 1, 0));
      geometry.setAttribute('instanceDistanceEnd', new THREE.InterleavedBufferAttribute(this.distanceBuffer, 1, 1));
    }
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.tipSegment = -1;
    if (old) {
      this.line.geometry = geometry;
      old.dispose();
    }
  }

  /**
   * Fill from `n` float64 xyz points relative to `origin`, keeping every `step`-th point and the last, with
   * their `times` if the line is to be clipped (showUntil). The buffers are reused when the path fits.
   */
  setPath(points: ArrayLike<number>, n: number, origin: V3, step = 1, times?: ArrayLike<number>): void {
    const kept = n < 1 ? 0 : Math.ceil((n - 1) / step) + 1;
    const segs = Math.max(0, kept - 1);
    if (segs > this.capacity) this.allocate(this.dynamic ? Math.ceil(segs * 1.25) : segs);
    else this.restoreTip();
    if (!times) this.times = NO_TIMES;
    else if (this.times.length !== kept) this.times = new Float64Array(kept);
    const a = this.segments;
    const d = this.distances;
    let px = 0;
    let py = 0;
    let pz = 0;
    let dist = 0;
    for (let k = 0; k < kept; k++) {
      const i = k === kept - 1 ? n - 1 : k * step;
      const x = points[i * 3] - origin[0];
      const y = points[i * 3 + 1] - origin[1];
      const z = points[i * 3 + 2] - origin[2];
      if (times) this.times[k] = times[i];
      if (k > 0) {
        const o = (k - 1) * 6;
        a[o] = px;
        a[o + 1] = py;
        a[o + 2] = pz;
        a[o + 3] = x;
        a[o + 4] = y;
        a[o + 5] = z;
        if (d) {
          d[(k - 1) * 2] = dist;
          dist += Math.hypot(x - px, y - py, z - pz);
          d[(k - 1) * 2 + 1] = dist;
        }
      }
      px = x;
      py = y;
      pz = z;
    }
    this.count = segs;
    // Only used to sort transparent objects; recomputed from the new points when next needed.
    this.geometry.boundingSphere = null;
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(0, this.count * 6);
    this.buffer.needsUpdate = true;
    if (this.distanceBuffer) {
      this.distanceBuffer.clearUpdateRanges();
      this.distanceBuffer.addUpdateRange(0, this.count * 2);
      this.distanceBuffer.needsUpdate = true;
    }
    this.geometry.instanceCount = this.count;
  }

  /** Fill from a track, keeping at most `maxPoints`. */
  setTrack(track: Track, origin: V3, maxPoints = 3000): void {
    this.setPath(track.pos, track.n, origin, Math.max(1, Math.floor(track.n / maxPoints)), track.t);
  }

  /**
   * Draw only the part up to time t. With `tip` (origin-relative), the last segment ends exactly there (the
   * vehicle's position at t) instead of at the next kept point, so the line neither runs ahead nor steps.
   */
  showUntil(t: number, tip: V3 | null): void {
    const n = this.count + 1;
    if (this.count < 1 || this.times.length < n) return;
    let draw = this.count;
    let seg = -1;
    if (t < this.times[0]) draw = 0;
    else if (t < this.times[n - 1]) {
      const i = sampleIndex(this.times, n, t);
      draw = i + 1;
      if (tip) seg = i;
    }
    this.setTip(seg, tip);
    this.geometry.instanceCount = draw;
  }

  showAll(): void {
    this.restoreTip();
    this.geometry.instanceCount = this.count;
  }

  private setTip(seg: number, tip: V3 | null): void {
    if (this.tipSegment !== seg) this.restoreTip();
    if (seg < 0 || !tip) return;
    const a = this.segments;
    const o = seg * 6 + 3;
    if (this.tipSegment !== seg) {
      this.tipSaved[0] = a[o];
      this.tipSaved[1] = a[o + 1];
      this.tipSaved[2] = a[o + 2];
      this.tipSegment = seg;
    }
    const x = Math.fround(tip[0]);
    const y = Math.fround(tip[1]);
    const z = Math.fround(tip[2]);
    if (a[o] === x && a[o + 1] === y && a[o + 2] === z) return;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    this.buffer.addUpdateRange(o, 3);
    this.buffer.needsUpdate = true;
  }

  private restoreTip(): void {
    if (this.tipSegment < 0) return;
    const o = this.tipSegment * 6 + 3;
    this.segments.set(this.tipSaved, o);
    this.buffer.addUpdateRange(o, 3);
    this.buffer.needsUpdate = true;
    this.tipSegment = -1;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --------------------------------------------------------------- gates

/** One ring per major event, drawn as a single instanced mesh. */
export interface GateMark {
  event: FlightEvent;
  pos: V3;
  quat: THREE.Quaternion;
}

const GATE_CAPACITY = 128;
const ringGeometry = new THREE.RingGeometry(0.92, 1, 64);

/** Event gates: rings facing the direction of travel at each major event, in the vehicle's colour. */
export class EventGates {
  readonly mesh: THREE.InstancedMesh;
  readonly items: GateMark[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor() {
    // One flat, depth-write-free ring: a single pass draws it fully, so skip three's back-then-front double pass.
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true });
    this.mesh = new THREE.InstancedMesh(ringGeometry, material, GATE_CAPACITY);
    this.mesh.name = 'event-gates';
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Create the colour attribute now so the first shader compile already includes it.
    this.mesh.setColorAt(0, this.color.set(0xffffff));
    this.mesh.count = 0;
  }

  setResult(result: FlightResult): void {
    this.items.length = 0;
    for (const e of result.events) {
      if (!e.major || e.key === 'liftoff' || e.key === 'intervention') continue;
      if (this.items.length >= GATE_CAPACITY) break;
      // Face the ring along the direction of travel at the event.
      const track = e.vehicle === 'booster' ? result.booster : result.ship;
      const i = sampleIndex(track.t, track.n, e.t);
      vTmp.set(track.vel[i * 3], track.vel[i * 3 + 1], track.vel[i * 3 + 2]);
      if (vTmp.lengthSq() < 1) vTmp.set(e.pos[0], e.pos[1], e.pos[2]);
      const quat = new THREE.Quaternion().setFromUnitVectors(AXIS_Z, vTmp.normalize());
      this.mesh.setColorAt(this.items.length, this.color.set(e.vehicle === 'booster' ? BOOSTER_COLOR : e.vehicle === 'ship' ? SHIP_COLOR : 0xffffff));
      this.items.push({ event: e, pos: [e.pos[0], e.pos[1], e.pos[2]], quat });
    }
    this.mesh.count = this.items.length;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Camera-relative placement for one view; rings keep a minimum size on screen. */
  place(cameraEcef: V3): void {
    if (!this.mesh.visible || this.items.length === 0) return;
    for (let k = 0; k < this.items.length; k++) {
      const g = this.items[k];
      this.pos.set(g.pos[0] - cameraEcef[0], g.pos[1] - cameraEcef[1], g.pos[2] - cameraEcef[2]);
      this.scale.setScalar(Math.max(60, this.pos.length() * 0.022));
      this.mesh.setMatrixAt(k, this.matrix.compose(this.pos, g.quat, this.scale));
    }
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, this.items.length * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// --------------------------------------------------------------- set

type Pair<T> = { booster: T; ship: T };
const VEHICLES = ['booster', 'ship'] as const;

/** All trajectory lines for one result. */
export class TrajectoryLines {
  readonly group = new THREE.Group();
  readonly origin: V3;
  readonly flown: Pair<PathLine>;
  readonly planned: Pair<PathLine>;
  readonly real: Pair<PathLine>;
  readonly coast: Pair<PathLine>;
  readonly impact: Pair<THREE.Mesh>;
  private readonly impactEcef: Pair<V3> = { booster: [0, 0, 0], ship: [0, 0, 0] };
  private readonly tip: Pair<V3> = { booster: [0, 0, 0], ship: [0, 0, 0] };
  private realShown = false;

  constructor(origin: V3) {
    this.origin = [origin[0], origin[1], origin[2]];
    this.flown = { booster: new PathLine(BOOSTER_COLOR, 2.4, 0.95), ship: new PathLine(SHIP_COLOR, 2.4, 0.95) };
    this.planned = { booster: new PathLine(0xffffff, 1.4, 0.38), ship: new PathLine(0xffffff, 1.4, 0.38) };
    this.real = { booster: new PathLine(0xd8d8d8, 1.2, 0.5, { dashed: true }), ship: new PathLine(0xd8d8d8, 1.2, 0.5, { dashed: true }) };
    this.coast = {
      booster: new PathLine(0xffd9a0, 1.4, 0.7, { dashed: true, dynamic: true }),
      ship: new PathLine(0xbfe0ff, 1.4, 0.7, { dashed: true, dynamic: true }),
    };
    const impactGeom = new THREE.RingGeometry(0.55, 1, 40);
    const mk = (color: number) => {
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true });
      const m = new THREE.Mesh(impactGeom, material);
      m.frustumCulled = false;
      m.visible = false;
      return m;
    };
    this.impact = { booster: mk(0xffb08a), ship: mk(0x9cc8ff) };
    for (const l of [this.planned, this.real, this.flown, this.coast]) {
      this.group.add(l.booster.line, l.ship.line);
    }
    this.coast.booster.line.visible = false;
    this.coast.ship.line.visible = false;
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

  /** The engines-off prediction for one vehicle, or null to hide it. */
  setCoast(which: 'booster' | 'ship', prediction: CoastPrediction | null): void {
    const line = this.coast[which];
    const m = this.impact[which];
    if (!prediction || prediction.n < 2) {
      line.line.visible = false;
      m.visible = false;
      return;
    }
    line.setPath(prediction.points, prediction.n, this.origin);
    line.line.visible = true;
    const impact = prediction.impact;
    m.visible = impact !== null;
    if (impact) {
      const p = this.impactEcef[which];
      p[0] = impact[0];
      p[1] = impact[1];
      p[2] = impact[2];
      m.quaternion.setFromUnitVectors(AXIS_Z, vTmp.set(p[0], p[1], p[2]).normalize());
    }
  }

  /**
   * Per view: move with the camera, clip the flown lines at t (ending at the vehicles, ECEF `tips`, while they
   * fly) and set visibility. Line widths follow the viewport by themselves (Line2 reads it before drawing).
   */
  update(t: number, cameraEcef: V3, show: { flown: boolean; planned: boolean; coast: boolean }, tips: Pair<V3 | null>): void {
    this.group.position.set(this.origin[0] - cameraEcef[0], this.origin[1] - cameraEcef[1], this.origin[2] - cameraEcef[2]);
    for (const v of VEHICLES) {
      this.flown[v].line.visible = show.flown;
      const tip = tips[v];
      let rel: V3 | null = null;
      if (tip) {
        rel = this.tip[v];
        rel[0] = tip[0] - this.origin[0];
        rel[1] = tip[1] - this.origin[1];
        rel[2] = tip[2] - this.origin[2];
      }
      this.flown[v].showUntil(t, rel);
      this.planned[v].line.visible = show.planned;
      this.real[v].line.visible = show.planned && this.realShown;
      if (!show.coast) {
        this.coast[v].line.visible = false;
        this.impact[v].visible = false;
      }
      const m = this.impact[v];
      if (m.visible) {
        const p = this.impactEcef[v];
        m.position.set(p[0] - this.origin[0], p[1] - this.origin[1], p[2] - this.origin[2]);
        const d = Math.hypot(p[0] - cameraEcef[0], p[1] - cameraEcef[1], p[2] - cameraEcef[2]);
        m.scale.setScalar(Math.max(30, d * 0.012));
      }
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
