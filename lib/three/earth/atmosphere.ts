import { EARTH_RADIUS } from '@/lib/sim/types';

/**
 * Physical model of the atmosphere, shared by the CPU (light colours, fog, fallback tables) and the shaders.
 *
 * Scattering by molecules (Rayleigh, scale height 8 km) and aerosols (Mie, Cornette–Shanks phase), ozone
 * absorption (tent profile around 25 km). Coefficients are per metre at sea level for the wavelengths
 * (680, 550, 440) nm, used directly as linear R, G, B. Single scattering is integrated exactly per view ray;
 * higher orders use a precomputed isotropic multiple-scattering term (second order around each point, with the
 * higher orders summed as a geometric series of the scattered fraction — after Hillaire 2020).
 *
 * Units: the solar irradiance at the top of the atmosphere is `sunIlluminance` scene units (white). Every
 * radiance here is consistent with a three.js DirectionalLight of that intensity: a white Lambertian surface
 * facing the unattenuated Sun has radiance sunIlluminance / π.
 */
export interface AtmosphereParams {
  rayleighScattering: [number, number, number];
  rayleighScaleHeight: number;
  mieScattering: number;
  mieExtinction: number;
  mieScaleHeight: number;
  /** Mie asymmetry parameter g. */
  mieG: number;
  ozoneAbsorption: [number, number, number];
  ozoneCenter: number;
  ozoneHalfWidth: number;
  /** Solar irradiance at the top of the atmosphere, scene units (= sunLight.intensity outside the atmosphere). */
  sunIlluminance: number;
  /** Mean ground albedo used for light reflected back into the atmosphere (multiple scattering). */
  groundAlbedo: number;
}

/** Gulf-coast air: Mie ≈ 1.8 × the clear-sky reference (sea-level visibility ≈ 180 km at 550 nm). */
export const DEFAULT_ATMOSPHERE: AtmosphereParams = {
  rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
  rayleighScaleHeight: 8000,
  mieScattering: 3.996e-6 * 1.8,
  mieExtinction: 4.44e-6 * 1.8,
  mieScaleHeight: 1200,
  mieG: 0.8,
  ozoneAbsorption: [0.65e-6, 1.881e-6, 0.085e-6],
  ozoneCenter: 25_000,
  ozoneHalfWidth: 15_000,
  sunIlluminance: 10,
  groundAlbedo: 0.1,
};

export const ATMOSPHERE_HEIGHT = 100_000;
export const R_GROUND = EARTH_RADIUS;
export const R_TOP = EARTH_RADIUS + ATMOSPHERE_HEIGHT;
/** sqrt(R_top² − R²): length of a ray tangent to the ground from the ground to the top of the atmosphere. */
export const H_TOP = Math.sqrt(R_TOP * R_TOP - R_GROUND * R_GROUND);
/** Angular radius of the Sun, rad. */
export const SUN_ANGULAR_RADIUS = 0.004675;
/** The Earth's shadow edge on the atmosphere is widened beyond the Sun's disc to mimic refraction. */
export const SHADOW_SOFTNESS = 2.0;

export const TRANSMITTANCE_SIZE: [number, number] = [256, 64];
/** Multiple-scattering table: sun cos-zenith (μs + 1) / 2 across, altitude / ATMOSPHERE_HEIGHT down. */
export const MS_SIZE: [number, number] = [32, 32];
export const IRRADIANCE_SIZE = 64;
/** Sun cos-zenith range covered by the ground irradiance table. */
export const IRRADIANCE_MU_RANGE: [number, number] = [-0.3, 1];

const PI = Math.PI;
type RGB = [number, number, number];

export function rayleighPhase(nu: number): number {
  return (3 / (16 * PI)) * (1 + nu * nu);
}

/** Cornette–Shanks phase function. */
export function miePhase(nu: number, g: number): number {
  const g2 = g * g;
  return ((3 / (8 * PI)) * (1 - g2) * (1 + nu * nu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * nu, 1.5));
}

/**
 * Transmittance table parametrisation (shared with GLSL): for a point at radius r (ρ = √(r² − R²)) and a ray
 * with cos-zenith μ above the horizon, x_r = ρ / H and x_μ = (d − d_min) / (d_max − d_min), where d is the
 * distance to the top of the atmosphere, d_min = R_top − r (straight up) and d_max = ρ + H (along the horizon).
 * This spends texels where the transmittance changes fastest: near the ground and near the horizon.
 */
export function transmittanceCoords(rho: number, r: number, mu: number): [number, number] {
  const rmu = r * mu;
  const d = Math.max(-rmu + Math.sqrt(Math.max(H_TOP * H_TOP - rho * rho + rmu * rmu, 0)), 0);
  const dMin = R_TOP - r;
  const dMax = rho + H_TOP;
  const xMu = (d - dMin) / Math.max(dMax - dMin, 1);
  return [Math.min(Math.max(xMu, 0), 1), Math.min(Math.max(rho / H_TOP, 0), 1)];
}

/** Inverse of transmittanceCoords for texel (i, j): returns [ρ, r, μ]. */
export function transmittanceTexel(i: number, j: number): [number, number, number] {
  const [W, H] = TRANSMITTANCE_SIZE;
  const rho = H_TOP * (j / (H - 1));
  const r = Math.sqrt(rho * rho + R_GROUND * R_GROUND);
  const dMin = R_TOP - r;
  const dMax = rho + H_TOP;
  const d = dMin + (i / (W - 1)) * (dMax - dMin);
  const mu = d === 0 ? 1 : Math.min(Math.max((H_TOP * H_TOP - rho * rho - d * d) / (2 * r * d), -1), 1);
  return [rho, r, mu];
}

/** Precomputed tables, RGB, row-major. Produced on the GPU (precompute.ts) or by `computeTablesCpu`. */
export interface AtmosphereTables {
  /** Transmittance to the top of the atmosphere (TRANSMITTANCE_SIZE). */
  transmittance: Float32Array;
  /** Isotropic multiple-scattering radiance Ψ per unit solar irradiance and unit scattering coefficient (MS_SIZE). */
  multipleScattering: Float32Array;
  /** Sky irradiance on a horizontal surface at sea level per unit solar irradiance (IRRADIANCE_SIZE × 1). */
  groundIrradiance: Float32Array;
}

/** Ray segment inside the atmosphere from a point at altitude h along cos-zenith μ; [t0, t1, hitGround]. */
function raySegment(h: number, mu: number): [number, number, boolean] {
  const r = R_GROUND + h;
  const rho2 = h * (2 * R_GROUND + h);
  const rmu = r * mu;
  const discTop = rmu * rmu + H_TOP * H_TOP - rho2;
  if (discTop < 0) return [0, 0, false];
  const sq = Math.sqrt(discTop);
  const t0 = r <= R_TOP ? 0 : Math.max(-rmu - sq, 0);
  let t1 = -rmu + sq;
  let ground = false;
  const discG = rmu * rmu - rho2;
  if (mu < 0 && discG >= 0) {
    const tg = rho2 / (-rmu + Math.sqrt(discG));
    if (tg < t1) {
      t1 = tg;
      ground = true;
    }
  }
  return [t0, t1, ground];
}

/**
 * Visit `steps` sub-intervals of [t0, t1] for a ray from radius r with cos-zenith μ, split at the ray's lowest
 * point with quadratic spacing towards it (where the air is densest). The callback gets the midpoint t and dt.
 */
function marchRay(r: number, mu: number, t0: number, t1: number, steps: number, visit: (t: number, dt: number) => void) {
  const tLow = Math.min(Math.max(-r * mu, t0), t1);
  const span = t1 - t0;
  if (span <= 0) return;
  const nA = tLow > t0 + 0.5 ? Math.max(1, Math.round((steps * (tLow - t0)) / span)) : 0;
  const nB = Math.max(t1 > tLow + 0.5 ? 1 : 0, steps - nA);
  const seg = (a: number, L: number, n: number, towardsEnd: boolean) => {
    for (let k = 0; k < n; k++) {
      const s0 = k / n;
      const s1 = (k + 1) / n;
      const f0 = towardsEnd ? 1 - (1 - s0) * (1 - s0) : s0 * s0;
      const f1 = towardsEnd ? 1 - (1 - s1) * (1 - s1) : s1 * s1;
      visit(a + L * 0.5 * (f0 + f1), L * (f1 - f0));
    }
  };
  seg(t0, tLow - t0, nA, true);
  seg(tLow, t1 - tLow, nB, false);
}

export class AtmosphereModel {
  readonly params: AtmosphereParams;
  readonly tables: AtmosphereTables;

  constructor(params: AtmosphereParams = DEFAULT_ATMOSPHERE, tables?: AtmosphereTables) {
    this.params = params;
    this.tables = tables ?? computeTablesCpu(params);
  }

  /** Rayleigh, Mie and ozone densities (relative to sea level) at altitude h. */
  density(h: number, out: RGB): RGB {
    const p = this.params;
    out[0] = Math.exp(-h / p.rayleighScaleHeight);
    out[1] = Math.exp(-h / p.mieScaleHeight);
    out[2] = Math.max(0, 1 - Math.abs(h - p.ozoneCenter) / p.ozoneHalfWidth);
    return out;
  }

  extinction(dens: RGB, out: RGB): RGB {
    const p = this.params;
    for (let c = 0; c < 3; c++)
      out[c] = p.rayleighScattering[c] * dens[0] + p.mieExtinction * dens[1] + p.ozoneAbsorption[c] * dens[2];
    return out;
  }

  /** Transmittance from a point (ρ, r) along cos-zenith μ to the top of the atmosphere (bilinear, as the GPU). */
  transmittanceToTop(rho: number, r: number, mu: number, out: RGB): RGB {
    const [xm, xr] = transmittanceCoords(rho, r, mu);
    return bilinear(this.tables.transmittance, TRANSMITTANCE_SIZE, xm, xr, out);
  }

  /** Fraction of the solar disc above the geometric horizon, softened (see SHADOW_SOFTNESS). */
  sunVisibility(rho: number, r: number, mus: number): number {
    const muH = -rho / r;
    const e = (R_GROUND / r) * SUN_ANGULAR_RADIUS * SHADOW_SOFTNESS;
    const t = Math.min(Math.max((mus - muH + e) / (2 * e), 0), 1);
    return t * t * (3 - 2 * t);
  }

  /** Multiple-scattering source Ψ at altitude h for sun cos-zenith μs (per unit scattering coefficient). */
  multipleScatteringAt(h: number, mus: number, out: RGB): RGB {
    return bilinear(
      this.tables.multipleScattering,
      MS_SIZE,
      Math.min(Math.max(mus * 0.5 + 0.5, 0), 1),
      Math.min(Math.max(h / ATMOSPHERE_HEIGHT, 0), 1),
      out,
    );
  }

  /** Transmittance of sunlight reaching a point at altitude h with sun cos-zenith μs (0 in the Earth's shadow). */
  sunTransmittanceAt(h: number, mus: number, out: RGB): RGB {
    const hh = Math.max(h, 0);
    const r = R_GROUND + hh;
    const rho = Math.sqrt(hh * (2 * R_GROUND + hh));
    if (r <= R_TOP) {
      this.transmittanceToTop(rho, r, mus, out);
      const v = this.sunVisibility(rho, r, mus);
      out[0] *= v;
      out[1] *= v;
      out[2] *= v;
      return out;
    }
    // Above the atmosphere: does the ray towards the Sun graze the atmosphere or hit the Earth?
    const rmu = r * mus;
    const p2 = r * r - rmu * rmu; // squared distance of closest approach to the centre
    if (mus >= 0 || p2 >= R_TOP * R_TOP) {
      out[0] = out[1] = out[2] = 1;
      return out;
    }
    const tIn = -rmu - Math.sqrt(R_TOP * R_TOP - p2);
    const muIn = (rmu + tIn) / R_TOP;
    this.transmittanceToTop(H_TOP, R_TOP, muIn, out);
    const v = this.sunVisibility(H_TOP, R_TOP, muIn);
    out[0] *= v;
    out[1] *= v;
    out[2] *= v;
    return out;
  }

  /**
   * Radiance (per unit solar irradiance) scattered towards a point at altitude h along a ray with cos-zenith μ and
   * scattering-angle cosine ν (sun cos-zenith μs at the start): single scattering with phase functions plus the
   * isotropic multiple-scattering term. Returns whether the ray ends on the ground; `transmittance` is the
   * segment's transmittance.
   */
  integrateRay(h: number, mu: number, mus: number, nu: number, steps: number, inscatter: RGB, transmittance: RGB): boolean {
    const p = this.params;
    const r = R_GROUND + h;
    const rho2 = h * (2 * R_GROUND + h);
    const [t0, t1, ground] = raySegment(h, mu);
    inscatter[0] = inscatter[1] = inscatter[2] = 0;
    transmittance[0] = transmittance[1] = transmittance[2] = 1;
    const pr = rayleighPhase(nu);
    const pm = miePhase(nu, p.mieG);
    const dens: RGB = [0, 0, 0];
    const ext: RGB = [0, 0, 0];
    const sunT: RGB = [0, 0, 0];
    const ms: RGB = [0, 0, 0];
    marchRay(r, mu, t0, t1, steps, (t, dt) => {
      const rho2t = rho2 + 2 * r * mu * t + t * t;
      const rt = Math.sqrt(rho2t + R_GROUND * R_GROUND);
      const ht = rho2t / (rt + R_GROUND);
      const must = (r * mus + t * nu) / rt;
      const rhot = Math.sqrt(Math.max(rho2t, 0));
      this.density(ht, dens);
      this.extinction(dens, ext);
      this.transmittanceToTop(rhot, rt, must, sunT);
      this.multipleScatteringAt(ht, must, ms);
      const vis = this.sunVisibility(rhot, rt, must);
      for (let c = 0; c < 3; c++) {
        const sR = p.rayleighScattering[c] * dens[0];
        const sM = p.mieScattering * dens[1];
        const src = (sR * pr + sM * pm) * sunT[c] * vis + (sR + sM) * ms[c];
        const segT = Math.exp(-ext[c] * dt);
        const integ = ext[c] * dt > 1e-6 ? (1 - segT) / ext[c] : dt;
        inscatter[c] += transmittance[c] * src * integ;
        transmittance[c] *= segT;
      }
    });
    return ground;
  }

  /**
   * Irradiance at the camera (altitude h, sun cos-zenith μs) on an upward- and a downward-facing surface, per unit
   * solar irradiance, from the sky and from the ground below (Lambertian, `albedo`), with aerial perspective.
   * Drives the HemisphereLight and the fog's ambient term. ~1–2k ray-march steps: call a few times per second.
   */
  cameraIrradiance(h: number, mus: number, albedo: RGB, up: RGB, down: RGB): void {
    const nTheta = 6;
    const nPhi = 6;
    const L: RGB = [0, 0, 0];
    const T: RGB = [0, 0, 0];
    const sunT: RGB = [0, 0, 0];
    const skyE: RGB = [0, 0, 0];
    const sinS = Math.sqrt(Math.max(1 - mus * mus, 0));
    const r = R_GROUND + h;
    const rho2 = h * (2 * R_GROUND + h);
    up[0] = up[1] = up[2] = 0;
    down[0] = down[1] = down[2] = 0;
    for (let hemi = 0; hemi < 2; hemi++) {
      const out = hemi === 0 ? up : down;
      for (let a = 0; a < nTheta; a++) {
        const theta = ((a + 0.5) / nTheta) * (PI / 2);
        const mu = hemi === 0 ? Math.cos(theta) : -Math.cos(theta);
        const sinV = Math.sin(theta);
        const w = Math.cos(theta) * sinV * (PI / 2 / nTheta) * (PI / nPhi) * 2;
        for (let b = 0; b < nPhi; b++) {
          const phi = ((b + 0.5) / nPhi) * PI;
          const nu = sinV * sinS * Math.cos(phi) + mu * mus;
          if (this.integrateRay(h, mu, mus, nu, 16, L, T)) {
            const rmu = r * mu;
            const t = rho2 / (-rmu + Math.sqrt(Math.max(rmu * rmu - rho2, 0)));
            const musG = Math.min(Math.max((r * mus + t * nu) / R_GROUND, -1), 1);
            this.sunTransmittanceAt(0, musG, sunT);
            this.groundIrradianceAt(musG, skyE);
            for (let c = 0; c < 3; c++) L[c] += T[c] * (albedo[c] / PI) * (sunT[c] * Math.max(musG, 0) + skyE[c]);
          }
          for (let c = 0; c < 3; c++) out[c] += L[c] * w;
        }
      }
    }
  }

  /** Sea-level sky irradiance per unit solar irradiance for sun cos-zenith μs (linear interpolation). */
  groundIrradianceAt(mus: number, out: RGB): RGB {
    const x = (mus - IRRADIANCE_MU_RANGE[0]) / (IRRADIANCE_MU_RANGE[1] - IRRADIANCE_MU_RANGE[0]);
    return bilinear(this.tables.groundIrradiance, [IRRADIANCE_SIZE, 1], Math.min(Math.max(x, 0), 1), 0, out);
  }
}

/** Bilinear look-up in an RGB table at normalised texel-centre coordinates (x, y) ∈ [0, 1]². */
function bilinear(table: Float32Array, size: [number, number], x: number, y: number, out: RGB): RGB {
  const [W, H] = size;
  const fx = x * (W - 1);
  const fy = y * (H - 1);
  const x0 = Math.min(Math.floor(fx), Math.max(W - 2, 0));
  const y0 = Math.min(Math.floor(fy), Math.max(H - 2, 0));
  const x1 = Math.min(x0 + 1, W - 1);
  const y1 = Math.min(y0 + 1, H - 1);
  const wx = fx - x0;
  const wy = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = table[(y0 * W + x0) * 3 + c] * (1 - wx) + table[(y0 * W + x1) * 3 + c] * wx;
    const b = table[(y1 * W + x0) * 3 + c] * (1 - wx) + table[(y1 * W + x1) * 3 + c] * wx;
    out[c] = a * (1 - wy) + b * wy;
  }
  return out;
}

/** Unit vectors spread evenly over the sphere (spherical Fibonacci), z up. Shared with the GLSL precompute. */
export function fibonacciSphere(i: number, n: number): RGB {
  const z = 1 - (2 * i + 1) / n;
  const s = Math.sqrt(Math.max(1 - z * z, 0));
  const phi = i * 2.399963229728653;
  return [s * Math.cos(phi), s * Math.sin(phi), z];
}

/**
 * CPU fallback for the tables (used when the GPU cannot render float targets). Same algorithms as the GLSL
 * precompute passes, with fewer samples for the multiple-scattering table.
 */
export function computeTablesCpu(params: AtmosphereParams): AtmosphereTables {
  const base = new AtmosphereModel(params, {
    transmittance: new Float32Array(TRANSMITTANCE_SIZE[0] * TRANSMITTANCE_SIZE[1] * 3).fill(1),
    multipleScattering: new Float32Array(MS_SIZE[0] * MS_SIZE[1] * 3),
    groundIrradiance: new Float32Array(IRRADIANCE_SIZE * 3),
  });
  const dens: RGB = [0, 0, 0];
  const ext: RGB = [0, 0, 0];

  // Transmittance.
  const [TW, TH] = TRANSMITTANCE_SIZE;
  const trans = base.tables.transmittance;
  for (let j = 0; j < TH; j++) {
    for (let i = 0; i < TW; i++) {
      const [rho, r, mu] = transmittanceTexel(i, j);
      const rho2 = rho * rho;
      const rmu = r * mu;
      const d = Math.max(-rmu + Math.sqrt(Math.max(H_TOP * H_TOP - rho2 + rmu * rmu, 0)), 0);
      const tau: RGB = [0, 0, 0];
      marchRay(r, mu, 0, d, 48, (t, dt) => {
        const rho2t = rho2 + 2 * rmu * t + t * t;
        const h = rho2t / (Math.sqrt(rho2t + R_GROUND * R_GROUND) + R_GROUND);
        base.extinction(base.density(h, dens), ext);
        for (let c = 0; c < 3; c++) tau[c] += ext[c] * dt;
      });
      for (let c = 0; c < 3; c++) trans[(j * TW + i) * 3 + c] = Math.exp(-tau[c]);
    }
  }

  // Multiple scattering Ψ = L₂ / (1 − f): second-order light gathered over the sphere with an isotropic phase,
  // and the fraction f of light re-scattered per order (higher orders as a geometric series).
  const [MW, MH] = MS_SIZE;
  const ms = base.tables.multipleScattering;
  const nDir = 32;
  const sunT: RGB = [0, 0, 0];
  for (let j = 0; j < MH; j++) {
    const h = (j / (MH - 1)) * ATMOSPHERE_HEIGHT;
    const r = R_GROUND + h;
    const rho2 = h * (2 * R_GROUND + h);
    for (let i = 0; i < MW; i++) {
      const mus = (i / (MW - 1)) * 2 - 1;
      const sinS = Math.sqrt(Math.max(1 - mus * mus, 0));
      const L2: RGB = [0, 0, 0];
      const f: RGB = [0, 0, 0];
      for (let k = 0; k < nDir; k++) {
        const w = fibonacciSphere(k, nDir);
        const mu = w[2];
        const nu = w[0] * sinS + w[2] * mus;
        const [t0, t1, ground] = raySegment(h, mu);
        const T: RGB = [1, 1, 1];
        marchRay(r, mu, t0, t1, 16, (t, dt) => {
          const rho2t = rho2 + 2 * r * mu * t + t * t;
          const rt = Math.sqrt(rho2t + R_GROUND * R_GROUND);
          const ht = rho2t / (rt + R_GROUND);
          const must = (r * mus + t * nu) / rt;
          const rhot = Math.sqrt(Math.max(rho2t, 0));
          base.density(ht, dens);
          base.extinction(dens, ext);
          base.transmittanceToTop(rhot, rt, must, sunT);
          const vis = base.sunVisibility(rhot, rt, must);
          for (let c = 0; c < 3; c++) {
            const sS = params.rayleighScattering[c] * dens[0] + params.mieScattering * dens[1];
            const segT = Math.exp(-ext[c] * dt);
            const integ = ext[c] * dt > 1e-6 ? (1 - segT) / ext[c] : dt;
            L2[c] += (T[c] * sS * sunT[c] * vis * integ) / (4 * PI) / nDir;
            f[c] += (T[c] * sS * integ) / nDir;
            T[c] *= segT;
          }
        });
        if (ground) {
          const rmu = r * mu;
          const tg = rho2 / (-rmu + Math.sqrt(Math.max(rmu * rmu - rho2, 0)));
          const musG = Math.min(Math.max((r * mus + tg * nu) / R_GROUND, -1), 1);
          base.transmittanceToTop(0, R_GROUND, musG, sunT);
          const vis = base.sunVisibility(0, R_GROUND, musG);
          for (let c = 0; c < 3; c++) L2[c] += (T[c] * (params.groundAlbedo / PI) * sunT[c] * vis * Math.max(musG, 0)) / nDir;
        }
      }
      for (let c = 0; c < 3; c++) ms[(j * MW + i) * 3 + c] = L2[c] / Math.max(1 - f[c], 1e-3);
    }
  }

  // Ground irradiance (sea level), sky only.
  const irr = base.tables.groundIrradiance;
  const L: RGB = [0, 0, 0];
  const T: RGB = [0, 0, 0];
  for (let i = 0; i < IRRADIANCE_SIZE; i++) {
    const mus = IRRADIANCE_MU_RANGE[0] + (i / (IRRADIANCE_SIZE - 1)) * (IRRADIANCE_MU_RANGE[1] - IRRADIANCE_MU_RANGE[0]);
    const sinS = Math.sqrt(Math.max(1 - mus * mus, 0));
    const E: RGB = [0, 0, 0];
    for (let a = 0; a < 8; a++) {
      const theta = ((a + 0.5) / 8) * (PI / 2);
      const mu = Math.cos(theta);
      const sinV = Math.sin(theta);
      const w = mu * sinV * (PI / 2 / 8) * (PI / 8) * 2;
      for (let b = 0; b < 8; b++) {
        const nu = sinV * sinS * Math.cos(((b + 0.5) / 8) * PI) + mu * mus;
        base.integrateRay(1, mu, mus, nu, 24, L, T);
        for (let c = 0; c < 3; c++) E[c] += L[c] * w;
      }
    }
    irr.set(E, i * 3);
  }
  return base.tables;
}
