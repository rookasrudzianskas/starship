import { ATMOSPHERE_GLSL } from './common';

/**
 * One-off precomputation passes (GLSL3, float render targets, read back to the CPU). Same algorithms as
 * computeTablesCpu() in atmosphere.ts.
 */

const MARCH_GLSL = /* glsl */ `
// Ray from radius r (ρ² = r² − R²) with cos-zenith μ: segment [t0, t1] in the atmosphere; ground = ends on it.
void atmoRaySegment(float r, float rho2, float mu, out float t0, out float t1, out bool ground) {
  float rmu = r * mu;
  float discTop = rmu * rmu + uAtmoRadii.w - rho2;
  t0 = 0.0;
  t1 = 0.0;
  ground = false;
  if (discTop < 0.0) return;
  float sq = sqrt(discTop);
  t0 = r <= uAtmoRadii.y ? 0.0 : max(-rmu - sq, 0.0);
  t1 = -rmu + sq;
  float discG = rmu * rmu - rho2;
  if (mu < 0.0 && discG >= 0.0) {
    float tg = rho2 / max(-rmu + sqrt(discG), 1e-3);
    if (tg < t1) {
      t1 = tg;
      ground = true;
    }
  }
}

// k-th of n sub-intervals of [t0, t1], split at the lowest point of the ray with quadratic spacing towards it.
void atmoMarchStep(float r, float mu, float t0, float t1, float n, float k, out float t, out float dt) {
  float tLow = clamp(-r * mu, t0, t1);
  float span = max(t1 - t0, 1e-3);
  float nA = tLow > t0 + 0.5 ? max(1.0, floor(n * (tLow - t0) / span + 0.5)) : 0.0;
  float nB = max(t1 > tLow + 0.5 ? 1.0 : 0.0, n - nA);
  bool segA = k < nA;
  float a = segA ? t0 : tLow;
  float L = segA ? tLow - t0 : t1 - tLow;
  float m = max(segA ? nA : nB, 1.0);
  float i = segA ? k : k - nA;
  float s0 = i / m;
  float s1 = (i + 1.0) / m;
  float f0 = segA ? 1.0 - (1.0 - s0) * (1.0 - s0) : s0 * s0;
  float f1 = segA ? 1.0 - (1.0 - s1) * (1.0 - s1) : s1 * s1;
  t = a + L * 0.5 * (f0 + f1);
  dt = (k < nA + nB) ? L * (f1 - f0) : 0.0;
}

vec3 atmoStepIntegral(vec3 ext, float dt, out vec3 segT) {
  segT = exp(-ext * dt);
  return mix((1.0 - segT) / max(ext, vec3(1e-20)), vec3(dt), lessThan(ext * dt, vec3(1e-5)));
}
`;

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
${ATMOSPHERE_GLSL}
${MARCH_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 oValue;
`;

/** Transmittance to the top of the atmosphere (see transmittanceCoords in atmosphere.ts for the axes). */
export const TRANSMITTANCE_FRAGMENT = /* glsl */ `
${HEADER}
void main() {
  vec2 ij = floor(gl_FragCoord.xy);
  float R = uAtmoRadii.x;
  float H = uAtmoRadii.z;
  float rho = H * ij.y / (uTransmittanceSize.y - 1.0);
  float rho2 = rho * rho;
  float r = sqrt(rho2 + R * R);
  float dMin = uAtmoRadii.y - r;
  float dMax = rho + H;
  float d = dMin + ij.x / (uTransmittanceSize.x - 1.0) * (dMax - dMin);
  float mu = d <= 0.0 ? 1.0 : clamp((uAtmoRadii.w - rho2 - d * d) / (2.0 * r * d), -1.0, 1.0);
  vec3 tau = vec3(0.0);
  const float N = 64.0;
  for (int k = 0; k < 64; k++) {
    float t;
    float dt;
    atmoMarchStep(r, mu, 0.0, d, N, float(k), t, dt);
    float rho2t = rho2 + 2.0 * r * mu * t + t * t;
    float ht = rho2t / (sqrt(rho2t + R * R) + R);
    tau += atmoExtinction(atmoDensity(max(ht, 0.0))) * dt;
  }
  oValue = vec4(exp(-tau), 1.0);
}
`;

/**
 * Multiple scattering Ψ(h, μs) = L₂ / (1 − f): second-order light arriving at a point from 64 directions over
 * the sphere (sunlight scattered once with an isotropic phase, plus sunlit ground), and the fraction f of light
 * scattered back per order, summing all higher orders as a geometric series.
 */
export const MS_FRAGMENT = /* glsl */ `
${HEADER}
void main() {
  vec2 ij = floor(gl_FragCoord.xy);
  float R = uAtmoRadii.x;
  float h = ij.y / (uMsSize.y - 1.0) * (uAtmoRadii.y - R);
  float mus = ij.x / (uMsSize.x - 1.0) * 2.0 - 1.0;
  float r = R + h;
  float rho2 = h * (2.0 * R + h);
  float sinS = sqrt(max(1.0 - mus * mus, 0.0));
  vec3 L2 = vec3(0.0);
  vec3 f = vec3(0.0);
  const int NDIR = 64;
  const float NSTEP = 20.0;
  for (int i = 0; i < NDIR; i++) {
    float z = 1.0 - (2.0 * float(i) + 1.0) / float(NDIR);
    float sz = sqrt(max(1.0 - z * z, 0.0));
    float phi = float(i) * 2.399963229728653;
    vec3 w = vec3(sz * cos(phi), sz * sin(phi), z);
    float mu = w.z;
    float nu = w.x * sinS + w.z * mus;
    float t0;
    float t1;
    bool ground;
    atmoRaySegment(r, rho2, mu, t0, t1, ground);
    vec3 T = vec3(1.0);
    if (t1 > t0) {
      for (int k = 0; k < 20; k++) {
        float t;
        float dt;
        atmoMarchStep(r, mu, t0, t1, NSTEP, float(k), t, dt);
        float rho2t = rho2 + 2.0 * r * mu * t + t * t;
        float rt = sqrt(rho2t + R * R);
        float ht = rho2t / (rt + R);
        float must = (r * mus + t * nu) / rt;
        float rhot = sqrt(max(rho2t, 0.0));
        vec3 dens = atmoDensity(max(ht, 0.0));
        vec3 sS = uRayleigh * dens.x + vec3(uMie.x * dens.y);
        vec3 segT;
        vec3 integ = atmoStepIntegral(atmoExtinction(dens), dt, segT);
        L2 += T * sS * atmoSunTransmittance(rhot, rt, must) * integ * 0.07957747154594767; // isotropic phase
        f += T * sS * integ;
        T *= segT;
      }
      if (ground) {
        float rmu = r * mu;
        float tg = rho2 / max(-rmu + sqrt(max(rmu * rmu - rho2, 0.0)), 1e-3);
        float musG = clamp((r * mus + tg * nu) / R, -1.0, 1.0);
        L2 += T * (uMie.w / ATMO_PI) * atmoSunTransmittance(0.0, R, musG) * max(musG, 0.0);
      }
    }
  }
  L2 /= float(NDIR);
  f /= float(NDIR);
  oValue = vec4(L2 / max(1.0 - f, vec3(1e-3)), 1.0);
}
`;

/** Sky irradiance on a horizontal surface at sea level, per unit solar irradiance, for each sun elevation. */
export const IRRADIANCE_FRAGMENT = /* glsl */ `
${HEADER}
uniform vec3 uIrradianceRange; // μs min, μs max, table size
void main() {
  float x = floor(gl_FragCoord.x) / (uIrradianceRange.z - 1.0);
  float mus = mix(uIrradianceRange.x, uIrradianceRange.y, x);
  float sinS = sqrt(max(1.0 - mus * mus, 0.0));
  float R = uAtmoRadii.x;
  float h = 1.0;
  float r = R + h;
  float rho2 = h * (2.0 * R + h);
  vec3 E = vec3(0.0);
  for (int a = 0; a < 8; a++) {
    float theta = (float(a) + 0.5) / 8.0 * ATMO_PI * 0.5;
    float mu = cos(theta);
    float sinV = sin(theta);
    float wgt = mu * sinV * (ATMO_PI * 0.5 / 8.0) * (ATMO_PI / 8.0) * 2.0;
    for (int b = 0; b < 8; b++) {
      float nu = sinV * sinS * cos((float(b) + 0.5) / 8.0 * ATMO_PI) + mu * mus;
      float pr = atmoRayleighPhase(nu);
      float pm = atmoMiePhase(nu, uMie.z);
      float t0;
      float t1;
      bool ground;
      atmoRaySegment(r, rho2, mu, t0, t1, ground);
      vec3 T = vec3(1.0);
      vec3 L = vec3(0.0);
      for (int k = 0; k < 24; k++) {
        float t;
        float dt;
        atmoMarchStep(r, mu, t0, t1, 24.0, float(k), t, dt);
        float rho2t = rho2 + 2.0 * r * mu * t + t * t;
        float rt = sqrt(rho2t + R * R);
        float ht = rho2t / (rt + R);
        float must = (r * mus + t * nu) / rt;
        float rhot = sqrt(max(rho2t, 0.0));
        vec3 dens = atmoDensity(max(ht, 0.0));
        vec3 sR = uRayleigh * dens.x;
        vec3 sM = vec3(uMie.x * dens.y);
        vec3 segT;
        vec3 integ = atmoStepIntegral(atmoExtinction(dens), dt, segT);
        vec3 src = (sR * pr + sM * pm) * atmoSunTransmittance(rhot, rt, must) + (sR + sM) * atmoMultipleScattering(ht, must);
        L += T * src * integ;
        T *= segT;
      }
      E += L * wgt;
    }
  }
  oValue = vec4(E, 1.0);
}
`;
