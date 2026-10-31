/**
 * US Standard Atmosphere 1976 below 86 km (geopotential layers), and above that a log-linear fit
 * through the US76 tabulated thermosphere up to 1000 km (extrapolated beyond).
 */

export interface AtmosphereState {
  pressure: number; // Pa
  density: number; // kg/m^3
  temperature: number; // K
  speedOfSound: number; // m/s
}

const R0 = 6_356_766; // US76 effective Earth radius for geopotential altitude, m
const G0M_R = 0.034163195; // g0 * M / R*, K/m
const R_AIR = 287.053; // J/(kg K)
const GAMMA = 1.4;

// Base geopotential altitude (m), base temperature (K), lapse rate (K/m), base pressure (Pa).
const LAYER_H = [0, 11_000, 20_000, 32_000, 47_000, 51_000, 71_000];
const LAYER_T = [288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65];
const LAYER_L = [-0.0065, 0, 0.001, 0.0028, 0, -0.0028, -0.002];
const LAYER_P = [101_325, 22_632.06, 5_474.889, 868.0187, 110.9063, 66.93887, 3.95642];

const Z_TOP = 86_000; // geometric altitude where the fit takes over

// US76 thermosphere: geometric altitude (km), kinetic temperature (K), pressure (Pa), density (kg/m^3).
const UP_Z = [86, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200, 250, 300, 400, 500, 600, 700, 800, 900, 1000];
const UP_T = [186.87, 186.87, 195.08, 240, 360, 469.27, 559.63, 634.39, 696.29, 790.07, 854.56, 941.33, 976.01, 995.83, 999.24, 999.85, 999.97, 999.99, 1000, 1000];
const UP_P = [
  0.3734, 0.18359, 0.032011, 0.0071042, 0.0025382, 0.0012505, 7.2028e-4, 4.5422e-4, 3.0395e-4, 1.5271e-4, 8.4736e-5,
  2.4767e-5, 8.7704e-6, 1.4518e-6, 3.0236e-7, 8.213e-8, 3.1908e-8, 1.7036e-8, 1.0873e-8, 7.5138e-9,
];
const UP_RHO = [
  6.958e-6, 3.416e-6, 5.604e-7, 9.708e-8, 2.222e-8, 8.152e-9, 3.831e-9, 2.076e-9, 1.233e-9, 5.194e-10, 2.541e-10,
  6.073e-11, 1.916e-11, 2.803e-12, 5.215e-13, 1.137e-13, 3.07e-14, 1.136e-14, 5.759e-15, 3.561e-15,
];
const UP_LNP = UP_P.map(Math.log);
const UP_LNRHO = UP_RHO.map(Math.log);

/** Exact model (US76 layers / thermosphere fit). */
function atmosphereExact(alt: number, out: AtmosphereState): AtmosphereState {
  if (alt < Z_TOP) {
    const z = alt < -2000 ? -2000 : alt;
    const h = (R0 * z) / (R0 + z);
    let i = LAYER_H.length - 1;
    while (i > 0 && h < LAYER_H[i]) i--;
    const tb = LAYER_T[i], lb = LAYER_L[i], pb = LAYER_P[i];
    const dh = h - LAYER_H[i];
    let T: number, p: number;
    if (lb === 0) {
      T = tb;
      p = pb * Math.exp((-G0M_R * dh) / tb);
    } else {
      T = tb + lb * dh;
      p = pb * Math.pow(tb / T, G0M_R / lb);
    }
    out.temperature = T;
    out.pressure = p;
    out.density = p / (R_AIR * T);
    out.speedOfSound = Math.sqrt(GAMMA * R_AIR * T);
    return out;
  }
  const zk = alt / 1000;
  const n = UP_Z.length;
  let i = 0;
  if (zk >= UP_Z[n - 1]) i = n - 2;
  else while (i < n - 2 && zk > UP_Z[i + 1]) i++;
  const f = (zk - UP_Z[i]) / (UP_Z[i + 1] - UP_Z[i]);
  const T = zk >= UP_Z[n - 1] ? UP_T[n - 1] : UP_T[i] + f * (UP_T[i + 1] - UP_T[i]);
  out.temperature = T;
  out.pressure = Math.exp(UP_LNP[i] + f * (UP_LNP[i + 1] - UP_LNP[i]));
  out.density = Math.exp(UP_LNRHO[i] + f * (UP_LNRHO[i + 1] - UP_LNRHO[i]));
  out.speedOfSound = Math.sqrt(GAMMA * R_AIR * T);
  return out;
}

// The simulator queries the atmosphere several times per step, so the model is tabulated every 50 m up
// to 200 km (log-linear between points: exact at the nodes, ~1e-5 relative in between).
const TAB_DZ = 50;
const TAB_N = 200_000 / TAB_DZ + 1;
const TAB_LNP = new Float64Array(TAB_N);
const TAB_LNRHO = new Float64Array(TAB_N);
const TAB_T = new Float64Array(TAB_N);
const TAB_A = new Float64Array(TAB_N);
{
  const s: AtmosphereState = { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 };
  for (let k = 0; k < TAB_N; k++) {
    atmosphereExact(k * TAB_DZ, s);
    TAB_LNP[k] = Math.log(s.pressure);
    TAB_LNRHO[k] = Math.log(s.density);
    TAB_T[k] = s.temperature;
    TAB_A[k] = s.speedOfSound;
  }
}

/** Writes the atmosphere at geometric altitude `alt` (m) into `out` without allocating. */
export function atmosphereInto(alt: number, out: AtmosphereState): AtmosphereState {
  if (!(alt >= 0 && alt < 200_000)) return atmosphereExact(alt, out);
  const x = alt / TAB_DZ;
  const k = x | 0;
  const f = x - k;
  out.pressure = Math.exp(TAB_LNP[k] + f * (TAB_LNP[k + 1] - TAB_LNP[k]));
  out.density = Math.exp(TAB_LNRHO[k] + f * (TAB_LNRHO[k + 1] - TAB_LNRHO[k]));
  out.temperature = TAB_T[k] + f * (TAB_T[k + 1] - TAB_T[k]);
  out.speedOfSound = TAB_A[k] + f * (TAB_A[k + 1] - TAB_A[k]);
  return out;
}

export function atmosphere(altM: number): AtmosphereState {
  return atmosphereInto(altM, { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 });
}

/** Density only (cheaper call for predictors). */
export function airDensity(alt: number): number {
  if (!(alt >= 0 && alt < 200_000)) return atmosphereExact(alt, scratch).density;
  const x = alt / TAB_DZ;
  const k = x | 0;
  const f = x - k;
  // Keep the operation order identical to atmosphereInto for deterministic predictions.
  return Math.exp(TAB_LNRHO[k] + f * (TAB_LNRHO[k + 1] - TAB_LNRHO[k]));
}

const scratch: AtmosphereState = { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 };
