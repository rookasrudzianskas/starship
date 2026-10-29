import type { EndKind, PhaseCode, Track, VehicleId } from './types';

/** One sample as the simulator produces it, before it is packed into a Track. */
export interface RawSample {
  t: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  qx: number; qy: number; qz: number; qw: number;
  com: number;
  alt: number;
  speed: number;
  vspeed: number;
  accel: number;
  mach: number;
  q: number;
  pitch: number;
  aoa: number;
  throttle: number;
  lox: number;
  ch4: number;
  heating: number;
  a0: number; a1: number; a2: number; a3: number;
  phase: PhaseCode;
}

export function emptySample(): RawSample {
  return {
    t: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
    com: 0, alt: 0, speed: 0, vspeed: 0, accel: 0, mach: 0, q: 0, pitch: 90, aoa: 0,
    throttle: 0, lox: 0, ch4: 0, heating: 0, a0: 0, a1: 0, a2: 0, a3: 0, phase: 0,
  };
}

/** Growable column store for one vehicle's samples. Samples have strictly increasing t. */
export class TrackBuilder {
  n = 0;
  private cap: number;
  private t: Float64Array;
  private pos: Float64Array;
  private vel: Float64Array;
  private quat: Float32Array;
  private com: Float32Array;
  private alt: Float32Array;
  private speed: Float32Array;
  private vspeed: Float32Array;
  private accel: Float32Array;
  private mach: Float32Array;
  private q: Float32Array;
  private pitch: Float32Array;
  private aoa: Float32Array;
  private throttle: Float32Array;
  private lox: Float32Array;
  private ch4: Float32Array;
  private heating: Float32Array;
  private aero: Float32Array;
  private phase: Uint8Array;

  constructor(capacity = 4096) {
    this.cap = capacity;
    this.t = new Float64Array(capacity);
    this.pos = new Float64Array(capacity * 3);
    this.vel = new Float64Array(capacity * 3);
    this.quat = new Float32Array(capacity * 4);
    this.com = new Float32Array(capacity);
    this.alt = new Float32Array(capacity);
    this.speed = new Float32Array(capacity);
    this.vspeed = new Float32Array(capacity);
    this.accel = new Float32Array(capacity);
    this.mach = new Float32Array(capacity);
    this.q = new Float32Array(capacity);
    this.pitch = new Float32Array(capacity);
    this.aoa = new Float32Array(capacity);
    this.throttle = new Float32Array(capacity);
    this.lox = new Float32Array(capacity);
    this.ch4 = new Float32Array(capacity);
    this.heating = new Float32Array(capacity);
    this.aero = new Float32Array(capacity * 4);
    this.phase = new Uint8Array(capacity);
  }

  get lastT(): number {
    return this.n > 0 ? this.t[this.n - 1] : -Infinity;
  }

  lastPhase(): number {
    return this.n > 0 ? this.phase[this.n - 1] : -1;
  }

  private grow(): void {
    const c = this.cap * 2;
    const g64 = (a: Float64Array, k: number) => {
      const b = new Float64Array(c * k);
      b.set(a);
      return b;
    };
    const g32 = (a: Float32Array, k: number) => {
      const b = new Float32Array(c * k);
      b.set(a);
      return b;
    };
    this.t = g64(this.t, 1);
    this.pos = g64(this.pos, 3);
    this.vel = g64(this.vel, 3);
    this.quat = g32(this.quat, 4);
    this.com = g32(this.com, 1);
    this.alt = g32(this.alt, 1);
    this.speed = g32(this.speed, 1);
    this.vspeed = g32(this.vspeed, 1);
    this.accel = g32(this.accel, 1);
    this.mach = g32(this.mach, 1);
    this.q = g32(this.q, 1);
    this.pitch = g32(this.pitch, 1);
    this.aoa = g32(this.aoa, 1);
    this.throttle = g32(this.throttle, 1);
    this.lox = g32(this.lox, 1);
    this.ch4 = g32(this.ch4, 1);
    this.heating = g32(this.heating, 1);
    this.aero = g32(this.aero, 4);
    const p = new Uint8Array(c);
    p.set(this.phase);
    this.phase = p;
    this.cap = c;
  }

  /** Appends a sample; a sample at (almost) the same time as the last one replaces it. */
  push(s: RawSample): void {
    let i = this.n;
    if (i > 0 && s.t <= this.t[i - 1] + 1e-6) i--;
    else if (i >= this.cap) this.grow();
    this.t[i] = s.t;
    this.pos[3 * i] = s.px;
    this.pos[3 * i + 1] = s.py;
    this.pos[3 * i + 2] = s.pz;
    this.vel[3 * i] = s.vx;
    this.vel[3 * i + 1] = s.vy;
    this.vel[3 * i + 2] = s.vz;
    this.quat[4 * i] = s.qx;
    this.quat[4 * i + 1] = s.qy;
    this.quat[4 * i + 2] = s.qz;
    this.quat[4 * i + 3] = s.qw;
    this.com[i] = s.com;
    this.alt[i] = s.alt;
    this.speed[i] = s.speed;
    this.vspeed[i] = s.vspeed;
    this.accel[i] = s.accel;
    this.mach[i] = s.mach;
    this.q[i] = s.q;
    this.pitch[i] = s.pitch;
    this.aoa[i] = s.aoa;
    this.throttle[i] = s.throttle;
    this.lox[i] = s.lox;
    this.ch4[i] = s.ch4;
    this.heating[i] = s.heating;
    this.aero[4 * i] = s.a0;
    this.aero[4 * i + 1] = s.a1;
    this.aero[4 * i + 2] = s.a2;
    this.aero[4 * i + 3] = s.a3;
    this.phase[i] = s.phase;
    if (i === this.n) this.n++;
  }

  /** Packs the samples into a Track with exactly-sized, independently owned arrays. */
  finish(vehicle: VehicleId, endKind: EndKind): Track {
    const n = this.n;
    return {
      vehicle,
      n,
      t: this.t.slice(0, n),
      pos: this.pos.slice(0, 3 * n),
      vel: this.vel.slice(0, 3 * n),
      quat: this.quat.slice(0, 4 * n),
      com: this.com.slice(0, n),
      alt: this.alt.slice(0, n),
      speed: this.speed.slice(0, n),
      vspeed: this.vspeed.slice(0, n),
      accel: this.accel.slice(0, n),
      mach: this.mach.slice(0, n),
      q: this.q.slice(0, n),
      pitch: this.pitch.slice(0, n),
      aoa: this.aoa.slice(0, n),
      throttle: this.throttle.slice(0, n),
      lox: this.lox.slice(0, n),
      ch4: this.ch4.slice(0, n),
      heating: this.heating.slice(0, n),
      aero: this.aero.slice(0, 4 * n),
      phase: this.phase.slice(0, n),
      start: n > 0 ? this.t[0] : 0,
      end: n > 0 ? this.t[n - 1] : 0,
      endKind,
    };
  }
}
