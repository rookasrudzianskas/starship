import { ATMOSPHERE_GLSL, SURFACE_GLSL, VIEW_LOOKUP_GLSL, VIEW_LUT_PARAM_GLSL } from './common';

/** Full-screen triangle for GLSL3 RawShaderMaterial passes. */
export const FULLSCREEN_VERTEX = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Per-frame view table (MRT): single scattering along every view ray, marched with the analytic integral of
 * exp(−σt·s) over each step (stable for long steps), samples concentrated around the ray's lowest point.
 */
export const VIEW_LUT_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
${ATMOSPHERE_GLSL}
${VIEW_LUT_PARAM_GLSL}
uniform float uMusCam;  // sun cos-zenith at the camera
uniform float uSteps;

in vec2 vUv;
layout(location = 0) out vec4 oRayleigh;
layout(location = 1) out vec4 oMie;
layout(location = 2) out vec4 oTransmittance;

void main() {
  vec2 ij = floor(gl_FragCoord.xy);
  float n = uViewLutSize.y * 0.5;
  bool ground = ij.y < n;
  float x = (ground ? ij.y : ij.y - n) / (n - 1.0);
  float phi = ij.x / (uViewLutSize.x - 1.0) * ATMO_PI;
  float mu = clamp(viewLutMu(x, ground), -1.0, 1.0);

  float R = uAtmoRadii.x;
  float r = uLutCam.x;
  float rho2 = uLutCam.z;
  float rmu = r * mu;
  float mus = uMusCam;
  float nu = sqrt(max(1.0 - mu * mu, 0.0)) * sqrt(max(1.0 - mus * mus, 0.0)) * cos(phi) + mu * mus;

  vec3 accR = vec3(0.0);
  vec3 accM = vec3(0.0);
  vec3 accMs = vec3(0.0);
  vec3 T = vec3(1.0);

  float discTop = rmu * rmu + uAtmoRadii.w - rho2;
  if (discTop > 0.0) {
    float sq = sqrt(discTop);
    float t0 = uLutInside > 0.5 ? 0.0 : max(-rmu - sq, 0.0);
    float t1 = -rmu + sq;
    if (ground) t1 = min(t1, rho2 / max(-rmu + sqrt(max(rmu * rmu - rho2, 0.0)), 1e-3));
    if (t1 > t0) {
      float tLow = clamp(-rmu, t0, t1);
      float span = t1 - t0;
      float nA = tLow > t0 + 0.5 ? max(1.0, floor(uSteps * (tLow - t0) / span + 0.5)) : 0.0;
      float nB = max(t1 > tLow + 0.5 ? 1.0 : 0.0, uSteps - nA);
      float total = nA + nB;
      for (int k = 0; k < 256; k++) {
        float fk = float(k);
        if (fk >= total) break;
        bool segA = fk < nA;
        float a = segA ? t0 : tLow;
        float L = segA ? tLow - t0 : t1 - tLow;
        float m = segA ? nA : nB;
        float i = segA ? fk : fk - nA;
        float s0 = i / m;
        float s1 = (i + 1.0) / m;
        // Quadratic spacing, dense towards the lowest (densest) point of the ray.
        float f0 = segA ? 1.0 - (1.0 - s0) * (1.0 - s0) : s0 * s0;
        float f1 = segA ? 1.0 - (1.0 - s1) * (1.0 - s1) : s1 * s1;
        float t = a + L * 0.5 * (f0 + f1);
        float dt = L * (f1 - f0);
        float rho2t = rho2 + 2.0 * rmu * t + t * t; // r(t)² − R²
        float rt = sqrt(rho2t + R * R);
        float ht = rho2t / (rt + R);
        float rhot = sqrt(max(rho2t, 0.0));
        float must = (r * mus + t * nu) / rt;
        vec3 dens = atmoDensity(max(ht, 0.0));
        vec3 ext = atmoExtinction(dens);
        vec3 sunT = atmoSunTransmittance(rhot, rt, must);
        vec3 segT = exp(-ext * dt);
        // ∫ exp(−σt s) ds over the step; falls back to dt when σt·dt is tiny (avoids 1 − exp cancellation).
        vec3 integ = mix((1.0 - segT) / max(ext, vec3(1e-20)), vec3(dt), lessThan(ext * dt, vec3(1e-5)));
        vec3 w = T * integ;
        accR += w * uRayleigh * dens.x * sunT;
        accM += w * uMie.x * dens.y * sunT;
        accMs += w * (uRayleigh * dens.x + uMie.x * dens.y) * atmoMultipleScattering(max(ht, 0.0), must);
        T *= segT;
      }
    }
  }
  oRayleigh = vec4(accR, accMs.r);
  oMie = vec4(accM, accMs.g);
  oTransmittance = vec4(T, accMs.b);
}
`;

/**
 * Sky and ground radiance in every direction, laid out as three.js expects an equirectangular map
 * (u = atan(z, x)/2π + 0.5, v = asin(y)/π + 0.5 in world axes). Fed to PMREMGenerator for scene.environment.
 * The Sun's disc is left out (the DirectionalLight provides it).
 */
export const ENV_FRAGMENT = /* glsl */ `
precision highp float;
precision highp int;
${ATMOSPHERE_GLSL}
${VIEW_LUT_PARAM_GLSL}
${VIEW_LOOKUP_GLSL}
${SURFACE_GLSL}
uniform vec3 uEarthCenter;
uniform float uAlbedoWidthLog2;  // the globe textures are read 2^this texels around (a blurred albedo is enough)

in vec2 vUv;
layout(location = 0) out vec4 oColour;

void main() {
  float phi = (vUv.x - 0.5) * 2.0 * ATMO_PI;
  float th = (vUv.y - 0.5) * ATMO_PI;
  vec3 d = vec3(cos(th) * cos(phi), sin(th), cos(th) * sin(phi));
  float mu = dot(d, uCamUp);
  float rmu = uCam.x * mu;
  float discG = rmu * rmu - uCam.z;
  vec3 ins;
  vec3 T;
  vec3 colour;
  if (mu < 0.0 && discG >= 0.0) {
    float t = uCam.z / (-rmu + sqrt(discG));
    vec3 n = normalize(t * d - uEarthCenter);
    SurfaceSample s = sampleGlobeLod(globeUvNoGrad(n), uAlbedoWidthLog2);
    vec3 ls = shadeSurface(n, d, s, 1.0);
    atmosphereAlongRay(d, true, ins, T);
    colour = ls * T + ins;
  } else {
    atmosphereAlongRay(d, false, ins, T);
    colour = ins;
  }
  oColour = vec4(min(colour, vec3(1e4)), 1.0);
}
`;
