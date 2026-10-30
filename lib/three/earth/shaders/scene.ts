import { ATMOSPHERE_GLSL, DEPTH_GLSL, SURFACE_GLSL, VIEW_LOOKUP_GLSL, VIEW_LUT_PARAM_GLSL, WAVES_GLSL } from './common';

/**
 * Globe + sky: one full-screen pass. Each pixel's ray is intersected analytically with the spherical Earth
 * (exact at any altitude, no tessellation error at sea level); ground pixels get surface shading plus aerial
 * perspective from the view table and write their true log depth, sky pixels get in-scattering and the Sun.
 */
export const GLOBE_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  // Works for whichever camera renders the scene: unproject the near plane, rotate view → world.
  vec4 nearPoint = inverse(projectionMatrix) * vec4(position.xy, -1.0, 1.0);
  vDir = transpose(mat3(viewMatrix)) * (nearPoint.xyz / nearPoint.w);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const GLOBE_FRAGMENT = /* glsl */ `
${ATMOSPHERE_GLSL}
${VIEW_LUT_PARAM_GLSL}
${VIEW_LOOKUP_GLSL}
${SURFACE_GLSL}
${WAVES_GLSL}
${DEPTH_GLSL}
uniform vec3 uEarthCenter;          // camera-relative position of the Earth's centre
uniform vec4 uPatchDiscard;         // xyz: pad (camera-relative), w: radius drawn only by the ground patch (≤ 0: none)
uniform float uPatchBiasRadius;     // out to here the globe yields to the patch through a depth bias
uniform vec3 uSunTransmittanceCam;  // transmittance camera → Sun (CPU)
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float mu = dot(d, uCamUp);
  float rmu = uCam.x * mu;
  float discG = rmu * rmu - uCam.z;
  bool ground = mu < 0.0 && discG >= 0.0;

  // Ground hit (stable form t = ρ² / (−rμ + √disc)); evaluated for every pixel so texture derivatives stay
  // defined across the horizon (sky pixels get a harmless stand-in point).
  float t = uCam.z / max(abs(rmu) + sqrt(max(discG, 0.0)), 1e-3);
  vec3 p = cameraPosition + t * d;
  vec3 n = normalize(p - uEarthCenter);
  // Everything that needs screen-space derivatives is evaluated here, in uniform control flow, before any
  // branch or discard; the texture fetches and the waves further down use these gradients explicitly.
  GlobeCoord gc = globeCoord(n);
  vec3 dpdx = dFdx(p);
  vec3 dpdy = dFdy(p);
  float mug = sqrt(max(discG, 0.0)) / uAtmoRadii.x; // cos-zenith of the view ray at the ground
  float mugWidth = fwidth(mug);
  float sunX = length(cross(d, uSun.xyz)) / uSunShape.x; // angle from the Sun's centre in solar radii
  float sunAA = max(fwidth(sunX), 1e-3);

  // The ground patch draws these pixels (its mesh sits on or just above the sphere, so it covers them). Within
  // ~2 px of the horizon the globe still draws (behind the patch, see the depth bias): the mesh's anti-aliased
  // silhouette only partly covers those pixels.
  float dPad = distance(p, uPatchDiscard.xyz);
  if (ground && dPad < uPatchDiscard.w && mug > 3.0 * mugWidth) discard;

  vec3 ins;
  vec3 T;
  atmosphereAlongRay(d, ground, ins, T);
  vec3 colour;
  float depth = 1.0;
  if (ground) {
    SurfaceSample s = sampleGlobeGrad(gc);
    vec4 wave = s.water > 0.0 ? waveNormal(p, n, dpdx, dpdy) : vec4(n, uSurface.y);
    colour = shadeSurfaceWater(n, wave.xyz, d, s, 1.0, wave.w) * T + ins;
    vec4 vp = viewMatrix * vec4(p, 1.0);
    // Behind the patch by 0.5 % of the distance (scaling a view-space point keeps it on the ray).
    if (dPad < uPatchBiasRadius) vp.xyz *= 1.005;
    depth = fragDepthFromView(vp);
  } else {
    colour = ins;
    // Solar disc with linear limb darkening (angle via the cross product: precise near 0).
    float disc = (1.0 - smoothstep(1.0 - sunAA, 1.0 + sunAA, sunX)) * step(0.0, dot(d, uSun.xyz));
    float limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - sunX * sunX, 0.0)));
    vec3 sun = uSun.w / (ATMO_PI * uSunShape.x * uSunShape.x) * uSunTransmittanceCam * (limb * disc);
    colour += min(sun, vec3(3.0e4)); // keep half-float render targets finite
  }
  gl_FragColor = vec4(colour, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragDepth = depth;
}
`;

/**
 * High-resolution ground around Starbase: a radial mesh with its origin at the pad (float32-safe close up),
 * blending the Sentinel-2 patches (pad / mid / wide) into the Blue Marble colour at its edges.
 */
export const PATCH_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 uvGlobe;
attribute vec2 uvPad;
attribute vec2 uvMid;
attribute vec2 uvWide;
attribute float arcDist;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec2 vUvGlobe;
varying vec2 vUvPad;
varying vec2 vUvMid;
varying vec2 vUvWide;
varying float vArcDist;
varying vec2 vGround;
void main() {
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  vNormalW = mat3(modelMatrix) * normal;
  vUvGlobe = uvGlobe;
  vUvPad = uvPad;
  vUvMid = uvMid;
  vUvWide = uvWide;
  vArcDist = arcDist;
  vGround = position.xy; // east / north of the pad (m): anchors the ground detail
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

export const PATCH_FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${VIEW_LUT_PARAM_GLSL}
${VIEW_LOOKUP_GLSL}
${SURFACE_GLSL}
${WAVES_GLSL}
uniform sampler2D uPatchPad;
uniform sampler2D uPatchMid;
uniform sampler2D uPatchWide;
uniform sampler2D uPatchWater;     // r: pad, g: mid, b: wide
uniform vec4 uPatchParams;         // x: overall fade, y/z: radial fade start/end (m), w: patch textures ready
uniform vec3 uPatchTexel;          // ground size of a texel (m): pad, mid, wide
uniform sampler2D uDetailTex;      // tiling fbm noise, four channels (grey until it is made)
uniform vec4 uDetailMean;          // mean of each of its channels
uniform float uGroundDetail;       // strength of the ground detail (0: off)
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying vec2 vUvGlobe;
varying vec2 vUvPad;
varying vec2 vUvMid;
varying vec2 vUvWide;
varying float vArcDist;
varying vec2 vGround;

float edgeWeight(vec2 uv, float feather) {
  vec2 e = min(uv, 1.0 - uv);
  return smoothstep(0.0, feather, min(e.x, e.y));
}

// The imagery is Sentinel-2 (10 m), so seen from near the ground it is one smooth blur. Four scales of tiling noise,
// anchored to the ground (east / north of the pad) and turned against each other so the repeat doesn't show, vary
// its brightness and its green / brown balance from tens of metres down to a few centimetres. The noise texture's mipmaps
// and anisotropic filtering fade each scale out before it could alias, at grazing angles too, which is where a low
// camera sees most of the ground. Only where the imagery is magnified: from altitude it shows the ground's own
// detail. mpp: the pixel's footprint across (its short axis, m); texel: ground size of an imagery texel (m).
vec3 groundDetail(vec3 albedo, vec2 x, float mpp, float texel) {
  // No early out: the fetches below take their mip level from implicit derivatives (uniform control flow only).
  float k = smoothstep(1.0, 3.0, texel / max(mpp, 1e-3)) * uGroundDetail;
  vec4 a = texture(uDetailTex, mat2(0.8, 0.6, -0.6, 0.8) * x * (1.0 / 53.0)) - uDetailMean;
  vec4 b = texture(uDetailTex, mat2(0.28, -0.96, 0.96, 0.28) * x * (1.0 / 11.3)) - uDetailMean;
  vec4 c = texture(uDetailTex, x * (1.0 / 260.0)) - uDetailMean;
  vec4 d = texture(uDetailTex, mat2(-0.6, 0.8, -0.8, -0.6) * x * (1.0 / 4.1)) - uDetailMean;
  float shade = 1.6 * (a.r + 0.8 * b.g + 0.6 * c.r) + 1.2 * d.a;
  // Drier, browner ground where it is positive, greener where negative.
  float dry = 2.0 * (a.b + c.g);
  vec3 tint = vec3(1.0 + 0.1 * dry, 1.0 + 0.03 * dry, 1.0 - 0.12 * dry);
  return albedo * mix(vec3(1.0), max(1.0 + shade, 0.2) * tint, k);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(vWorldPos - cameraPosition);
  // Pixel footprint on the ground, and the derivatives the waves use, before any branch: derivatives need uniform
  // control flow.
  vec2 gx = dFdx(vGround);
  vec2 gy = dFdy(vGround);
  float mpp = min(length(gx), length(gy));
  vec3 dpdx = dFdx(vWorldPos);
  vec3 dpdy = dFdy(vWorldPos);
  SurfaceSample s = sampleGlobe(vUvGlobe);
  vec3 cWide = texture(uPatchWide, vUvWide).rgb * uSurface.x;
  vec3 cMid = texture(uPatchMid, vUvMid).rgb * uSurface.x;
  vec3 cPad = texture(uPatchPad, vUvPad).rgb * uSurface.x;
  float wWide = texture(uPatchWater, vUvWide).b;
  float wMid = texture(uPatchWater, vUvMid).g;
  float wPad = texture(uPatchWater, vUvPad).r;
  float fade = uPatchParams.x * uPatchParams.w;
  float kWide = edgeWeight(vUvWide, 0.03) * (1.0 - smoothstep(uPatchParams.y, uPatchParams.z, vArcDist)) * fade;
  float kMid = edgeWeight(vUvMid, 0.06) * fade;
  float kPad = edgeWeight(vUvPad, 0.08) * fade;
  s.albedo = mix(mix(mix(s.albedo, cWide, kWide), cMid, kMid), cPad, kPad);
  s.water = mix(mix(mix(s.water, wWide, kWide), wMid, kMid), wPad, kPad);
  // Land only: water has its waves, glint and reflections instead.
  float texel = mix(mix(uPatchTexel.z, uPatchTexel.y, kMid), uPatchTexel.x, kPad);
  s.albedo = mix(groundDetail(s.albedo, vGround, mpp, texel), s.albedo, s.water);
  vec4 wave = s.water > 0.0 ? waveNormal(vWorldPos, n, dpdx, dpdy) : vec4(n, uSurface.y);

  vec3 ins;
  vec3 T;
  atmosphereAlongRay(v, true, ins, T);
  gl_FragColor = vec4(shadeSurfaceWater(n, wave.xyz, v, s, 1.0, wave.w) * T + ins, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Stars: points at infinity, faded by the sky brightness behind them and dimmed by the atmosphere. */
export const STARS_VERTEX = /* glsl */ `
${ATMOSPHERE_GLSL}
${VIEW_LUT_PARAM_GLSL}
${VIEW_LOOKUP_GLSL}
attribute vec4 starColour;      // rgb: linear colour × brightness, a: size in CSS px
uniform mat3 uStarRotation;     // celestial → world (ECEF axes)
uniform vec4 uStarParams;       // x: brightness, y: pixel ratio, z/w: sky luminance fade start/end
varying vec3 vColour;
void main() {
  vec3 dir = uStarRotation * position;
  float mu = dot(dir, uCamUp);
  float rmu = uCam.x * mu;
  if (mu < 0.0 && rmu * rmu - uCam.z >= 0.0) { // below the horizon: behind the Earth
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColour = vec3(0.0);
    return;
  }
  vec3 ins;
  vec3 T;
  atmosphereAlongRay(dir, false, ins, T);
  float skyLum = dot(ins, vec3(0.2126, 0.7152, 0.0722));
  float vis = 1.0 - smoothstep(uStarParams.z, uStarParams.w, skyLum);
  vColour = starColour.rgb * T * (vis * uStarParams.x);
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * dir, 0.0);
  clip.z = clip.w * 0.9999995; // just inside the far plane: behind everything, in front of the cleared depth
  gl_Position = clip;
  gl_PointSize = vis > 0.0 ? starColour.a * uStarParams.y : 0.0;
}
`;

export const STARS_FRAGMENT = /* glsl */ `
varying vec3 vColour;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  float a = exp(-3.0 * r2) * (1.0 - smoothstep(0.7, 1.0, r2));
  gl_FragColor = vec4(vColour * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
