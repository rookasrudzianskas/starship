import { atmosphereInto as atmosphereIntoFn, type AtmosphereState } from './atmosphere';
import {
  aeroForce as aeroForceFn,
  airVelocity as airVelocityFn,
  gravityAccel as gravityAccelFn,
  heatingIndex as heatingIndexFn,
  rk4 as rk4Fn,
} from './physics';
import type { Body } from './runtime';
import { EARTH_OMEGA, EARTH_RADIUS } from './types';
import { qAxis as qAxisFn, v3 } from './vec';

// Module-local aliases: some loaders (tsx, vitest) turn imported bindings into getter calls.
const RE = EARTH_RADIUS;
const OMEGA = EARTH_OMEGA;
const atmosphereInto = atmosphereIntoFn;
const aeroForce = aeroForceFn;
const airVelocity = airVelocityFn;
const gravityAccel = gravityAccelFn;
const heatingIndex = heatingIndexFn;
const rk4 = rk4Fn;
const qAxis = qAxisFn;

/** Air data and forces from the last step, for guidance and sampling. */
export interface AirData {
  alt: number;
  pressure: number;
  density: number;
  sound: number;
  q: number;
  mach: number;
  aoa: number; // rad
  airspeed: number;
  heating: number;
  /** Earth-relative velocity (v − ω×r) in the inertial frame, m/s: the air's motion without the wind. */
  vGround: Float64Array;
  vAir: Float64Array; // inertial air-relative velocity, m/s
  aero: Float64Array; // aerodynamic force, N (inertial)
  thrust: number; // N along +Y
  depleted: boolean;
}

export function newAirData(): AirData {
  return {
    alt: 0, pressure: 101_325, density: 1.225, sound: 340, q: 0, mach: 0, aoa: 0, airspeed: 0, heating: 0,
    vGround: v3(), vAir: v3(), aero: v3(), thrust: 0, depleted: false,
  };
}

const atm: AtmosphereState = { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 };
const yAx = v3();
const aNg = v3();

export interface StepOptions {
  /** Per-part multiplier on thrust (hot staging: the attached ship's plume is half deflected). */
  thrustScale?: ArrayLike<number>;
  /** Extra non-gravitational acceleration, m/s² (inertial). */
  extra?: Float64Array | null;
}

/**
 * Advances a body's translation by dt with gravity (J2), thrust along +Y and body aerodynamics,
 * burns propellant and spools engines. Attitude is advanced separately by guidance.
 */
export function stepBody(body: Body, dt: number, windPeak: number, air: AirData, opts?: StepOptions): void {
  const r = body.r;
  const alt = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]) - RE;
  atmosphereInto(alt, atm);
  air.alt = alt;
  air.pressure = atm.pressure;
  air.density = atm.density;
  air.sound = atm.speedOfSound;
  const vg = air.vGround;
  vg[0] = body.v[0] + OMEGA * r[1];
  vg[1] = body.v[1] - OMEGA * r[0];
  vg[2] = body.v[2];
  if (windPeak === 0) {
    // With no wind, the air co-rotates with Earth: both relative velocities are identical.
    air.vAir[0] = vg[0];
    air.vAir[1] = vg[1];
    air.vAir[2] = vg[2];
  } else airVelocity(air.vAir, r, body.v, alt, windPeak);
  qAxis(yAx, body.q, 1);
  // AirData already contains the AeroResult fields; write them in place instead of copying scratch.
  if (alt < 180_000) aeroForce(air.aero, air, yAx, air.vAir, atm.density, atm.speedOfSound, body.aero);
  else {
    air.aero[0] = air.aero[1] = air.aero[2] = 0;
    air.q = 0;
    air.mach = 0;
    air.aoa = 0;
    const va = air.vAir;
    air.airspeed = Math.sqrt(va[0] * va[0] + va[1] * va[1] + va[2] * va[2]);
  }
  air.heating = heatingIndex(atm.density, air.airspeed);
  let thrust = 0;
  const parts = body.parts;
  for (let i = 0; i < parts.length; i++) {
    const f = parts[i].thrust(atm.pressure);
    thrust += opts?.thrustScale ? f * opts.thrustScale[i] : f;
  }
  air.thrust = thrust;
  const m = body.mass;
  aNg[0] = (air.aero[0] + thrust * yAx[0]) / m;
  aNg[1] = (air.aero[1] + thrust * yAx[1]) / m;
  aNg[2] = (air.aero[2] + thrust * yAx[2]) / m;
  const ex = opts?.extra;
  if (ex) {
    aNg[0] += ex[0];
    aNg[1] += ex[1];
    aNg[2] += ex[2];
  }
  rk4(r, body.v, aNg, dt, true);
  let depleted = false;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].burn(dt)) depleted = true;
    parts[i].spoolStep(dt);
  }
  air.depleted = depleted;
  gravityAccel(r[0], r[1], r[2], body.acc, true);
  body.acc[0] += aNg[0];
  body.acc[1] += aNg[1];
  body.acc[2] += aNg[2];
}

/** Drag-free, thrust-free coast step (vacuum). */
export function coastBody(body: Body, dt: number, air: AirData): void {
  rk4(body.r, body.v, null, dt, true);
  const r = body.r;
  gravityAccel(r[0], r[1], r[2], body.acc, true);
  air.alt = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]) - RE;
  air.q = 0;
  air.mach = 0;
  air.heating = 0;
  air.thrust = 0;
  air.aero[0] = air.aero[1] = air.aero[2] = 0;
  for (const p of body.parts) p.spoolStep(dt);
}
