import { LOX_FRACTION, MIN_THROTTLE } from './engines';
import { ENGINE_FAILED, ENGINE_LIT, ENGINE_OFF, type EngineChange, type EngineState, type VehicleId } from './types';
import { centreOfMass, type AeroConfig, type VehicleSpec } from './vehicles';
import { q4, v3 } from './vec';

/** Raptor thrust build-up and tail-off times, s. */
export const SPOOL_UP = 1.5;
export const SPOOL_DOWN = 0.6;
const SPOOL_FAIL = 0.25;
const LIT = ENGINE_LIT;
const OFF = ENGINE_OFF;
const FAILED = ENGINE_FAILED;
const LOXF = LOX_FRACTION;
const MINT = MIN_THROTTLE;

/** Mutable state of one vehicle (masses, engines). Position/attitude live in the Body that carries it. */
export class VehicleRt {
  readonly id: VehicleId;
  readonly spec: VehicleSpec;
  dry: number;
  lox: number;
  ch4: number;
  payload: number;
  readonly loxCap: number;
  readonly ch4Cap: number;
  readonly n: number;
  readonly state: Uint8Array;
  readonly spool: Float64Array;
  /** Throttle commanded for lit engines (before the ceiling). */
  throttle = 1;
  /** Vehicle-level ceiling from user interventions. */
  ceiling = 1;
  readonly changes: EngineChange[] = [];
  // Cached spool-weighted sums, refreshed while any engine ramps.
  private sumF = 0;
  private sumA = 0;
  private sumMdot = 0;
  private litCount = 0;
  private litSpool = 0;
  private dirty = true;
  /** No engine is ramping: spoolStep has nothing to do until the next state change. */
  private settled = true;
  private nextEngineChange = -Infinity;

  constructor(spec: VehicleSpec, dry: number, prop: number, payload: number) {
    this.id = spec.id;
    this.spec = spec;
    this.dry = dry;
    this.lox = prop * LOXF;
    this.ch4 = prop - this.lox;
    this.payload = payload;
    this.loxCap = spec.propMass * LOXF;
    this.ch4Cap = spec.propMass - this.loxCap;
    this.n = spec.slots.length;
    this.state = new Uint8Array(this.n);
    this.spool = new Float64Array(this.n);
  }

  get mass(): number {
    return this.dry + this.lox + this.ch4 + this.payload;
  }

  get prop(): number {
    return this.lox + this.ch4;
  }

  com(): number {
    return centreOfMass(this.spec, this.dry, this.lox, this.ch4, this.payload, this.loxCap, this.ch4Cap);
  }

  private record(t: number, engine: number, state: EngineState): void {
    this.changes.push({ t, engine, state });
    this.dirty = true;
    this.settled = false;
  }

  ignite(i: number, t: number): boolean {
    if (this.state[i] !== OFF || this.prop <= 0) return false;
    this.state[i] = LIT;
    this.record(t, i, LIT);
    return true;
  }

  shutdown(i: number, t: number): void {
    if (this.state[i] !== LIT) return;
    this.state[i] = OFF;
    this.record(t, i, OFF);
  }

  fail(i: number, t: number): boolean {
    if (this.state[i] === FAILED) return false;
    this.state[i] = FAILED;
    this.record(t, i, FAILED);
    return true;
  }

  shutdownAll(t: number): void {
    for (let i = 0; i < this.n; i++) this.shutdown(i, t);
  }

  isLit(i: number): boolean {
    return this.state[i] === LIT;
  }

  usable(i: number): boolean {
    return this.state[i] !== FAILED;
  }

  anyLit(): boolean {
    for (let i = 0; i < this.n; i++) if (this.state[i] === LIT) return true;
    return false;
  }

  /** True while any engine is still producing thrust (lit or tailing off). */
  producingThrust(): boolean {
    this.refresh();
    return this.sumF > 0;
  }

  /** Lights exactly the engines in `set` and shuts down every other one. */
  setEngines(set: readonly number[], t: number): void {
    const want = new Uint8Array(this.n);
    for (const i of set) want[i] = 1;
    for (let i = 0; i < this.n; i++) {
      if (want[i]) this.ignite(i, t);
      else this.shutdown(i, t);
    }
  }

  litEngines(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.state[i] === LIT) out.push(i);
    return out;
  }

  /** Advances the thrust build-up/tail-off of every engine. */
  spoolStep(dt: number): void {
    if (this.settled) return;
    let moving = false;
    for (let i = 0; i < this.n; i++) {
      const s = this.spool[i];
      const st = this.state[i];
      if (st === LIT) {
        if (s < 1) {
          this.spool[i] = Math.min(1, s + dt / SPOOL_UP);
          this.dirty = true;
          moving = true;
        }
      } else if (s > 0) {
        this.spool[i] = Math.max(0, s - dt / (st === FAILED ? SPOOL_FAIL : SPOOL_DOWN));
        this.dirty = true;
        moving = true;
      }
    }
    this.settled = !moving;
  }

  private refresh(): void {
    if (!this.dirty) return;
    let f = 0, a = 0, m = 0, lc = 0, ls = 0;
    const specs = this.spec.specs;
    for (let i = 0; i < this.n; i++) {
      const s = this.spool[i];
      if (s > 0) {
        f += s * specs[i].fVac;
        a += s * specs[i].exitArea;
        m += s * specs[i].mdot;
      }
      if (this.state[i] === LIT) {
        lc++;
        ls += s;
      }
    }
    this.sumF = f;
    this.sumA = a;
    this.sumMdot = m;
    this.litCount = lc;
    this.litSpool = ls;
    this.dirty = false;
  }

  /** Effective throttle: guidance command limited by the user ceiling and the Raptor range. */
  effThrottle(): number {
    const c = Math.min(this.throttle, this.ceiling);
    return c < MINT ? MINT : c > 1 ? 1 : c;
  }

  /** Thrust (N) at ambient pressure p for the current throttle. */
  thrust(p: number): number {
    this.refresh();
    if (this.sumF <= 0 || this.prop <= 0) return 0;
    return Math.max(0, this.effThrottle() * (this.sumF - p * this.sumA));
  }

  /** Thrust available at full throttle (spooled engines only), N. */
  maxThrust(p: number): number {
    this.refresh();
    return Math.max(0, Math.min(1, this.ceiling) * (this.sumF - p * this.sumA));
  }

  /** Full-thrust sum over lit engines as if fully spooled (for guidance planning). */
  litThrustPotential(p: number): number {
    let f = 0;
    const specs = this.spec.specs;
    for (let i = 0; i < this.n; i++) if (this.state[i] === LIT) f += specs[i].fVac - p * specs[i].exitArea;
    return f;
  }

  /**
   * Final-approach engine management: sets the throttle for `need` newtons and, when even the minimum
   * throttle is too much, shuts down one engine (never the last); lights a spare from `spares` when
   * the lit engines cannot deliver it.
   */
  throttleTo(need: number, p: number, t: number, spares: readonly number[], mayShed = true): void {
    let litCount = 0;
    let lastLit = -1;
    for (let i = 0; i < this.n; i++) {
      if (this.state[i] === LIT) {
        litCount++;
        lastLit = i;
      }
    }
    const ceil = Math.min(1, this.ceiling);
    const potential = this.litThrustPotential(p) * ceil;
    // Hysteresis: shed only well below the minimum, relight a spare only near full throttle.
    if (mayShed && litCount > 1 && need < MINT * potential * 0.8 && t >= this.nextEngineChange) {
      this.shutdown(lastLit, t);
      this.nextEngineChange = t + 1;
    } else if (need > potential * 0.9 && t >= this.nextEngineChange) {
      this.nextEngineChange = t + 1;
      for (const i of spares) {
        if (this.state[i] === OFF) {
          this.ignite(i, t);
          break;
        }
      }
    }
    const pot = this.litThrustPotential(p) * ceil;
    this.throttle = pot > 0 ? need / pot : 1;
  }

  massFlow(): number {
    this.refresh();
    if (this.sumMdot <= 0 || this.prop <= 0) return 0;
    return this.effThrottle() * this.sumMdot;
  }

  /** Mean throttle of lit engines including their spool state, 0 when none lit. */
  meanThrottle(): number {
    this.refresh();
    return this.litCount > 0 ? (this.effThrottle() * this.litSpool) / this.litCount : 0;
  }

  /** Burns propellant for dt seconds at the current flow; returns true if a tank ran dry. */
  burn(dt: number): boolean {
    const md = this.massFlow();
    if (md <= 0) return false;
    this.lox -= md * dt * LOXF;
    this.ch4 -= md * dt * (1 - LOXF);
    if (this.lox <= 0 || this.ch4 <= 0) {
      this.lox = Math.max(0, this.lox);
      this.ch4 = Math.max(0, this.ch4);
      return true;
    }
    return false;
  }
}

/** A rigid body in flight: the stack before separation, then each vehicle on its own. */
export class Body {
  readonly r = v3(); // inertial position of the CoM, m
  readonly v = v3(); // inertial velocity, m/s
  readonly q = q4(); // attitude body -> inertial
  readonly w = v3(); // angular velocity, inertial frame, rad/s
  readonly acc = v3(); // last total inertial acceleration, m/s^2
  readonly parts: VehicleRt[];
  aero: AeroConfig;
  length: number;

  constructor(parts: VehicleRt[], aero: AeroConfig, length: number) {
    this.parts = parts;
    this.aero = aero;
    this.length = length;
  }

  get mass(): number {
    let m = 0;
    for (const p of this.parts) m += p.mass;
    return m;
  }
}
