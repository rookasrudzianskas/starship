/**
 * GLSL shared by every Earth shader. Written for GLSL ES 3.00 (`texture()`), so the chunks work both in
 * ShaderMaterial (three adds its WebGL2 prefix) and in GLSL3 RawShaderMaterial passes.
 *
 * Geometry conventions: world axes are ECEF axes, positions are camera-relative metres. `uCam` describes the
 * camera on the spherical Earth with float64-accurate scalars computed on the CPU:
 *   uCam.x = r (distance from the Earth's centre), uCam.y = h (altitude), uCam.z = ρ² = h(2R + h) = r² − R²,
 *   uCam.w = μ_h = −ρ / r (cos-zenith of the horizon).
 * Ray/sphere intersections use these exact terms instead of r² − R² in float32 (which would lose metres).
 */

export const ATMOSPHERE_GLSL = /* glsl */ `
#define ATMO_PI 3.141592653589793

uniform vec4 uAtmoRadii;      // x: R ground, y: R top, z: H = sqrt(Rtop² − R²), w: H²
uniform vec4 uAtmoScale;      // x: Rayleigh scale height, y: Mie scale height, z: ozone centre, w: ozone half width
uniform vec3 uRayleigh;       // Rayleigh scattering at sea level, 1/m
uniform vec4 uMie;            // x: scattering, y: extinction (1/m), z: g, w: ground albedo
uniform vec3 uOzone;          // ozone absorption at peak density, 1/m
uniform vec4 uSun;            // xyz: unit direction to the Sun (world), w: solar irradiance (scene units)
uniform vec2 uSunShape;       // x: angular radius (rad), y: Earth-shadow edge softness
uniform sampler2D uTransmittanceLut;
uniform vec2 uTransmittanceSize;
uniform sampler2D uMsLut;     // isotropic multiple-scattering source Ψ(h, μs)
uniform vec2 uMsSize;

vec3 atmoDensity(float h) {
  return vec3(
    exp(-h / uAtmoScale.x),
    exp(-h / uAtmoScale.y),
    max(0.0, 1.0 - abs(h - uAtmoScale.z) / uAtmoScale.w)
  );
}

vec3 atmoExtinction(vec3 dens) {
  return uRayleigh * dens.x + vec3(uMie.y * dens.y) + uOzone * dens.z;
}

float atmoRayleighPhase(float nu) {
  return 0.05968310365946075 * (1.0 + nu * nu); // 3 / (16π)
}

// Cornette–Shanks phase function.
float atmoMiePhase(float nu, float g) {
  float g2 = g * g;
  float k = max(1.0 + g2 - 2.0 * g * nu, 1e-5);
  return 0.1193662073189215 * (1.0 - g2) * (1.0 + nu * nu) / ((2.0 + g2) * k * sqrt(k)); // 3 / (8π)
}

// Transmittance from a point at radius r (ρ = sqrt(r² − R²)) along cos-zenith μ to the top of the atmosphere.
// Table axes: x_μ = (d − d_min) / (d_max − d_min) with d the distance to the top, x_r = ρ / H.
vec3 atmoTransmittanceToTop(float rho, float r, float mu) {
  float H = uAtmoRadii.z;
  float rmu = r * mu;
  float d = max(-rmu + sqrt(max(uAtmoRadii.w - rho * rho + rmu * rmu, 0.0)), 0.0);
  float dMin = uAtmoRadii.y - r;
  float dMax = rho + H;
  vec2 x = clamp(vec2((d - dMin) / max(dMax - dMin, 1.0), rho / H), 0.0, 1.0);
  return textureLod(uTransmittanceLut, (x * (uTransmittanceSize - 1.0) + 0.5) / uTransmittanceSize, 0.0).rgb;
}

// Fraction of the solar disc above the geometric horizon of a point (softened for refraction).
float atmoSunVisibility(float rho, float r, float mus) {
  float e = (uAtmoRadii.x / r) * uSunShape.x * uSunShape.y;
  return smoothstep(-e, e, mus + rho / r);
}

vec3 atmoSunTransmittance(float rho, float r, float mus) {
  return atmoTransmittanceToTop(rho, r, mus) * atmoSunVisibility(rho, r, mus);
}

// Multiple-scattering radiance per unit scattering coefficient at altitude h (see atmosphere.ts).
vec3 atmoMultipleScattering(float h, float mus) {
  vec2 x = clamp(vec2(mus * 0.5 + 0.5, h / (uAtmoRadii.y - uAtmoRadii.x)), 0.0, 1.0);
  return textureLod(uMsLut, (x * (uMsSize - 1.0) + 0.5) / uMsSize, 0.0).rgb;
}
`;

/**
 * Per-frame "view" table: in-scattering and transmittance along every view ray from the camera, indexed by the
 * ray's cos-zenith μ and azimuth φ relative to the Sun (the sky is symmetric about the Sun's vertical plane).
 * Rows: lower half = rays that hit the ground, upper half = rays that do not. Within a half, x ∈ [0, 1]:
 *  - ground: x = 1 − sqrt(μ_g), μ_g = cos-zenith at the ground hit point (x → 1 at the horizon);
 *  - sky, camera inside the atmosphere: x = sqrt((μ − μ_h) / (1 − μ_h)) (dense near the horizon);
 *  - sky, camera above the atmosphere: x = tangent altitude of the ray / atmosphere height (the limb).
 * Columns: φ / π. Phase functions are applied per pixel, so the table stays smooth around the Sun.
 */
export const VIEW_LUT_PARAM_GLSL = /* glsl */ `
uniform vec4 uCam;            // r, h, ρ², μ_h
uniform float uCamInside;     // 1 while the camera is inside the atmosphere
uniform vec2 uViewLutSize;

float viewLutX(float mu, bool ground) {
  float rmu = uCam.x * mu;
  if (ground) {
    float mug = sqrt(max(rmu * rmu - uCam.z, 0.0)) / uAtmoRadii.x;
    return 1.0 - sqrt(clamp(mug, 0.0, 1.0));
  }
  if (uCamInside > 0.5) return sqrt(clamp((mu - uCam.w) / (1.0 - uCam.w), 0.0, 1.0));
  float p2mR2 = uCam.z - rmu * rmu; // p² − R² for the ray's closest approach p
  float pmR = p2mR2 / (sqrt(max(p2mR2 + uAtmoRadii.x * uAtmoRadii.x, 0.0)) + uAtmoRadii.x);
  return clamp(pmR / (uAtmoRadii.y - uAtmoRadii.x), 0.0, 1.0);
}

float viewLutMu(float x, bool ground) {
  float r = uCam.x;
  float R = uAtmoRadii.x;
  if (ground) {
    float mug = (1.0 - x) * (1.0 - x);
    return -sqrt(R * R * mug * mug + uCam.z) / r;
  }
  if (uCamInside > 0.5) return uCam.w + x * x * (1.0 - uCam.w);
  float pmR = x * (uAtmoRadii.y - R);
  float p = R + pmR;
  return -sqrt(max((uCam.y - pmR) * (r + p), 0.0)) / r; // r² − p² = (r − p)(r + p)
}

vec2 viewLutTexcoord(float x, float u, bool ground) {
  float n = uViewLutSize.y * 0.5;
  float row = 0.5 + clamp(x, 0.0, 1.0) * (n - 1.0) + (ground ? 0.0 : n);
  float col = 0.5 + clamp(u, 0.0, 1.0) * (uViewLutSize.x - 1.0);
  return vec2(col / uViewLutSize.x, row / uViewLutSize.y);
}
`;

/** Look-ups into the view table for world-space rays from the camera. */
export const VIEW_LOOKUP_GLSL = /* glsl */ `
uniform vec3 uCamUp;          // unit "up" at the camera (world)
uniform sampler2D uViewLutR;  // rgb: Rayleigh in-scattering integral, a: multiple scattering (r)
uniform sampler2D uViewLutM;  // rgb: Mie in-scattering integral,      a: multiple scattering (g)
uniform sampler2D uViewLutT;  // rgb: transmittance,                    a: multiple scattering (b)

// In-scattered radiance (scene units) and transmittance along a camera ray; ground = the ray ends on the ground.
void atmosphereAlongRay(vec3 dir, bool ground, out vec3 inscatter, out vec3 transmittance) {
  float mu = dot(dir, uCamUp);
  if (uCamInside < 0.5 && !ground) {
    float rmu = uCam.x * mu;
    if (mu >= 0.0 || uCam.z - rmu * rmu >= uAtmoRadii.w) { // leaving, or passing above the atmosphere
      inscatter = vec3(0.0);
      transmittance = vec3(1.0);
      return;
    }
  }
  vec3 sunDir = uSun.xyz;
  float mus = dot(sunDir, uCamUp);
  vec3 dh = dir - mu * uCamUp;
  vec3 sh = sunDir - mus * uCamUp;
  float l = length(dh) * length(sh);
  float cphi = l > 1e-7 ? clamp(dot(dh, sh) / l, -1.0, 1.0) : 1.0;
  vec2 uv = viewLutTexcoord(viewLutX(mu, ground), acos(cphi) / ATMO_PI, ground);
  vec4 tr = textureLod(uViewLutR, uv, 0.0);
  vec4 tm = textureLod(uViewLutM, uv, 0.0);
  vec4 tt = textureLod(uViewLutT, uv, 0.0);
  float nu = dot(dir, sunDir);
  inscatter = uSun.w * (tr.rgb * atmoRayleighPhase(nu) + tm.rgb * atmoMiePhase(nu, uMie.z) + vec3(tr.a, tm.a, tt.a));
  transmittance = tt.rgb;
}
`;

/** Globe textures and surface shading, shared by the globe pass, the Starbase patches and the environment map. */
export const SURFACE_GLSL = /* glsl */ `
uniform sampler2D uDayTex;
uniform sampler2D uNightTex;
uniform sampler2D uWaterTex;
uniform float uTexReady;
uniform sampler2D uGroundIrradiance;
uniform vec3 uGroundIrradianceRange; // x: μs min, y: μs max, z: table size
uniform vec4 uSurface;               // x: albedo scale, y: water slope variance, z: city light radiance, w: night ambient
uniform float uGlintStrength;        // artistic scale on the sun glint (1 = physical)
uniform vec3 uWaterAlbedo;           // body colour floor for water (sunlit open ocean ≈ 0.03 albedo)
uniform vec3 uCityColour;

struct SurfaceSample {
  vec3 albedo;
  float water;
  float lights;
};

// Equirectangular texture coordinate of a unit normal (u = lon/2π + 0.5, v = 0.5 − lat/π, first row north),
// with explicit screen-space gradients. Tarini's trick: of two parametrisations with the seam at ±180° and at
// 0°, take the gradient of the one that is continuous at this pixel, so mip selection does not break along the
// antimeridian (sampling at u or u + 1 is the same texel with repeat wrapping).
struct GlobeCoord {
  vec2 uv;
  vec2 ddx;
  vec2 ddy;
};

GlobeCoord globeCoord(vec3 n) {
  float lon = atan(n.y, n.x);
  float lat = asin(clamp(n.z, -1.0, 1.0));
  float uA = lon * 0.15915494309189535 + 0.5;
  float uB = fract(lon * 0.15915494309189535) + 0.5;
  float v = 0.5 - lat * 0.3183098861837907;
  vec2 gA = vec2(dFdx(uA), dFdy(uA));
  vec2 gB = vec2(dFdx(uB), dFdy(uB));
  vec2 gu = dot(gA, gA) <= dot(gB, gB) ? gA : gB;
  vec2 gv = vec2(dFdx(v), dFdy(v));
  return GlobeCoord(vec2(uA, v), vec2(gu.x, gv.x), vec2(gu.y, gv.y));
}

vec2 globeUvNoGrad(vec3 n) {
  return vec2(atan(n.y, n.x) * 0.15915494309189535 + 0.5, 0.5 - asin(clamp(n.z, -1.0, 1.0)) * 0.3183098861837907);
}

SurfaceSample placeholderSurface() {
  // Before the imagery arrives: a plain ocean world.
  return SurfaceSample(vec3(0.012, 0.03, 0.06), 1.0, 0.0);
}

SurfaceSample sampleGlobeGrad(GlobeCoord c) {
  SurfaceSample s = SurfaceSample(
    textureGrad(uDayTex, c.uv, c.ddx, c.ddy).rgb * uSurface.x,
    textureGrad(uWaterTex, c.uv, c.ddx, c.ddy).r,
    textureGrad(uNightTex, c.uv, c.ddx, c.ddy).r
  );
  if (uTexReady < 0.5) s = placeholderSurface();
  return s;
}

SurfaceSample sampleGlobe(vec2 uv) {
  SurfaceSample s = SurfaceSample(
    texture(uDayTex, uv).rgb * uSurface.x,
    texture(uWaterTex, uv).r,
    texture(uNightTex, uv).r
  );
  if (uTexReady < 0.5) s = placeholderSurface();
  return s;
}

// Mip level at which a globe texture is 2^widthLog2 texels around: the same angular resolution whatever its size
// (the preview, 4K and 8K day textures and the 4K masks).
float globeLod(sampler2D t, float widthLog2) {
  return max(log2(float(textureSize(t, 0).x)) - widthLog2, 0.0);
}

SurfaceSample sampleGlobeLod(vec2 uv, float widthLog2) {
  SurfaceSample s = SurfaceSample(
    textureLod(uDayTex, uv, globeLod(uDayTex, widthLog2)).rgb * uSurface.x,
    textureLod(uWaterTex, uv, globeLod(uWaterTex, widthLog2)).r,
    textureLod(uNightTex, uv, globeLod(uNightTex, widthLog2)).r
  );
  if (uTexReady < 0.5) s = placeholderSurface();
  return s;
}

float smithG1Beckmann(float cosT, float s2) {
  float a = cosT / (sqrt(s2) * sqrt(max(1.0 - cosT * cosT, 1e-6)));
  return a >= 1.6 ? 1.0 : (3.535 * a + 2.181 * a * a) / (1.0 + 2.276 * a + 2.577 * a * a);
}

vec3 groundIrradiance(float mus) {
  float x = clamp((mus - uGroundIrradianceRange.x) / (uGroundIrradianceRange.y - uGroundIrradianceRange.x), 0.0, 1.0);
  float n = uGroundIrradianceRange.z;
  return textureLod(uGroundIrradiance, vec2((0.5 + x * (n - 1.0)) / n, 0.5), 0.0).rgb;
}

// Outgoing radiance of the ground at a point with unit normal n, seen along unit direction v (camera → point).
// shadow: visibility of the Sun (1 = lit).
vec3 shadeSurface(vec3 n, vec3 v, SurfaceSample s, float shadow) {
  vec3 L = uSun.xyz;
  float mus = dot(n, L);
  vec3 sunT = atmoSunTransmittance(0.0, uAtmoRadii.x, mus) * shadow;
  vec3 eSun = uSun.w * sunT * max(mus, 0.0);
  vec3 eSky = uSun.w * groundIrradiance(mus);
  float cosV = clamp(-dot(n, v), 0.0, 1.0);
  float fV = 0.02 + 0.98 * pow(1.0 - cosV, 5.0); // Fresnel, water n = 1.33
  vec3 albedo = mix(s.albedo, max(s.albedo, uWaterAlbedo), s.water);
  vec3 lo = albedo * (1.0 / ATMO_PI) * (eSun + eSky) * (1.0 - s.water * fV);

  // Water: sun glint with a Beckmann distribution (Cox–Munk slope variance) and the reflected sky.
  vec3 h = normalize(L - v);
  float nh = max(dot(n, h), 1e-3);
  float nh2 = nh * nh;
  float s2 = uSurface.y;
  float D = exp((nh2 - 1.0) / (s2 * nh2)) / (ATMO_PI * s2 * nh2 * nh2);
  float fH = 0.02 + 0.98 * pow(1.0 - clamp(dot(-v, h), 0.0, 1.0), 5.0);
  // Smith shadowing-masking for a Beckmann surface (rational approximation of G1), view and sun.
  float G = smithG1Beckmann(cosV, s2) * smithG1Beckmann(max(mus, 0.0), s2);
  vec3 glint = uSun.w * sunT * (uGlintStrength * fH * D * G / (4.0 * max(cosV, 0.02)));
  // Reflected sky: near sea level the camera's own sky table is what the water sees; higher up, approximate the
  // sky dome by its mean radiance (Esky / π), brightened towards grazing angles where the horizon sky reflects.
  vec3 skyReflection = fV * (1.0 + fV) * eSky * (1.0 / ATMO_PI);
  float lowCam = 1.0 - smoothstep(300.0, 3000.0, uCam.y);
  if (lowCam > 0.0 && s.water > 0.0) {
    vec3 skyIns;
    vec3 skyT;
    atmosphereAlongRay(reflect(v, n), false, skyIns, skyT);
    skyReflection = mix(skyReflection, fV * skyIns, lowCam);
  }
  lo += s.water * (glint + skyReflection);

  // City lights come on through dusk; at grazing view angles terrain and haze hide them (and the texture
  // footprint degenerates at the limb).
  float night = (1.0 - smoothstep(-0.12, 0.02, mus)) * smoothstep(0.0, 0.1, cosV);
  lo += uCityColour * (uSurface.z * s.lights * s.lights * night);
  lo += albedo * (uSurface.w * uSun.w);
  return lo;
}
`;

/** Log-depth compatible fragment depth for a view-space position (matches three's logdepthbuf chunks). */
export const DEPTH_GLSL = /* glsl */ `
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
uniform float logDepthBufFC;
#else
uniform mat4 projectionMatrix; // not in three's fragment prefix
#endif
float fragDepthFromView(vec4 viewPos) {
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  return log2(1.0 + max(-viewPos.z, 1e-6)) * logDepthBufFC * 0.5;
#else
  vec4 clip = projectionMatrix * viewPos;
  return clamp(0.5 * clip.z / clip.w + 0.5, 0.0, 1.0);
#endif
}
`;
