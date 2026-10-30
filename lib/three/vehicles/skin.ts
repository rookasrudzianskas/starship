import * as THREE from 'three';
import { NORMAL_GAIN, RING_HEIGHT, type SteelMaps } from './textures';
import { TILE_WIDTH } from './geometry';

/**
 * Hull material: MeshStandardMaterial (so it reacts to scene.environment, lights, shadows and fog)
 * with shader injections for
 * - per-ring tint/roughness variation of the steel (hash of the 1.8 m ring index, never repeats),
 * - procedural hexagonal heat-shield tiles (aTile attribute, see geometry.ts): per-tile tone and gloss,
 *   grout lines, a slight pillow bevel via a screen-space bump, an irregular hex-stepped boundary,
 *   all antialiased with the pixel footprint,
 * - frost bands over the propellant tanks, soot near the base and scorch at the top,
 * - a faint red glow of the windward tiles during entry heating.
 */

export interface SkinUniforms {
  uNoise: { value: THREE.Texture | null };
  /** 0..1 frost amount. */
  uFrost: { value: number };
  /** LOX tank bottom/top and CH4 tank bottom/top heights (object space, m). */
  uFrostBands: { value: THREE.Vector4 };
  /** Base soot: strength, height fully sooted below, height clean above. */
  uSoot: { value: THREE.Vector4 };
  /** Top scorch: strength, height clean below, height fully scorched above. */
  uScorch: { value: THREE.Vector4 };
  uRingSeed: { value: number };
  /** Tile boundary: half-angle (rad) from the belly line, arc length where it starts to wrap, arc length where fully wrapped. */
  uTileEdge: { value: THREE.Vector4 };
  uHeat: { value: number };
  /** Airflow direction in object space (air moving relative to the body). */
  uAirflow: { value: THREE.Vector3 };
}

export interface SkinMaterial {
  material: THREE.MeshStandardMaterial;
  uniforms: SkinUniforms;
}

export function createSkinUniforms(noise: THREE.Texture | null): SkinUniforms {
  return {
    uNoise: { value: noise },
    uFrost: { value: 0 },
    uFrostBands: { value: new THREE.Vector4(-1, -1, -1, -1) },
    uSoot: { value: new THREE.Vector4(0, 0, 1, 0) },
    uScorch: { value: new THREE.Vector4(0, 1e5, 1e5 + 1, 0) },
    uRingSeed: { value: 1 },
    uTileEdge: { value: new THREE.Vector4(1.6, 1e5, 1e5 + 1, 0) },
    uHeat: { value: 0 },
    uAirflow: { value: new THREE.Vector3(0, -1, 0) },
  };
}

const VERT_DECL = /* glsl */ `
attribute vec4 aTile;
varying vec4 vTile;
varying vec3 vObjPos;
varying vec3 vObjN;
`;

const VERT_MAIN = /* glsl */ `
vTile = aTile;
vObjPos = position;
vObjN = objectNormal;
`;

const FRAG_DECL = /* glsl */ `
uniform sampler2D uNoise;
uniform float uFrost;
uniform vec4 uFrostBands;
uniform vec4 uSoot;
uniform vec4 uScorch;
uniform float uRingSeed;
uniform vec4 uTileEdge;
uniform float uHeat;
uniform vec3 uAirflow;
varying vec4 vTile;
varying vec3 vObjPos;
varying vec3 vObjN;

// Integer hash of a 2D lattice key -> [0, 1).
float skHash(vec2 c) {
  uvec2 q = uvec2(ivec2(floor(c)) + 65536);
  uint h = (q.x * 0x27d4eb2du) ^ (q.y * 0x165667b1u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h ^= h >> 13u;
  h *= 0xc2b2ae35u;
  h ^= h >> 16u;
  return float(h & 0x00ffffffu) / 16777216.0;
}

// Nearest hexagon of a pointy-top tiling with unit flat-to-flat width (rows sqrt(3)/2 apart).
// Two offset rectangular lattices; the closer centre wins. Returns (offset from centre, centre).
vec4 skHex(vec2 p) {
  const vec2 period = vec2(1.0, 1.7320508);
  const vec2 halfp = vec2(0.5, 0.8660254);
  vec2 a = mod(p, period) - halfp;
  vec2 b = mod(p - halfp, period) - halfp;
  return dot(a, a) < dot(b, b) ? vec4(a, p - a) : vec4(b, p - b);
}

// Hexagonal distance: 0 at the centre, 0.5 on the edges.
float skHexDist(vec2 q) {
  q = abs(q);
  return max(q.x, dot(q, vec2(0.5, 0.8660254)));
}

// Normal from a height field given in metres (surface gradient from screen-space derivatives).
vec3 skBump(vec3 surfPos, vec3 n, float h, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - grad);
}
`;

const FRAG_SURFACE = /* glsl */ `
float skTileMask = 0.0;
float skTileH = 0.0;
float skTileRough = 0.5;
float skFrost = 0.0;
float skSoot = 0.0;
{
  // --- Steel: per-ring tint and gloss (rings are 1.8 m tall) ---
  float ring = floor(vObjPos.y / ${RING_HEIGHT.toFixed(3)});
  float rh = skHash(vec2(ring, uRingSeed));
  float rh2 = skHash(vec2(ring + 113.0, uRingSeed + 7.0));
  diffuseColor.rgb *= mix(vec3(0.94, 0.945, 0.95), vec3(1.03, 1.025, 1.02), rh);
  roughnessFactor = clamp(roughnessFactor + (rh2 - 0.5) * 0.09, 0.08, 1.0);

  float ang = atan(vObjPos.x, vObjPos.z);

#ifdef SKIN_TILES
  // --- Heat-shield tiles ---
  vec2 tp = vTile.xy / ${TILE_WIDTH.toFixed(4)};
  vec4 hx = skHex(tp);
  vec2 key = vec2(floor(hx.z * 2.0 + 0.5), floor(hx.w / 0.8660254 + 0.5));
  float h1 = skHash(key);
  float h2 = skHash(key + vec2(17.0, 3.0));
  float h3 = skHash(key + vec2(5.0, 29.0));
  float px = fwidth(tp.x) + fwidth(tp.y);
  float far = smoothstep(0.1, 0.32, px);
  // Windward boundary: whole tiles inside |θ| < edge (+ jitter), widening to the full circle near the tip.
  float rRef = max(vTile.z, 0.05);
  float sC = hx.w * ${TILE_WIDTH.toFixed(4)};
  float edge = mix(uTileEdge.x, 3.3, smoothstep(uTileEdge.y, uTileEdge.z, sC));
  float thetaC = hx.z * ${TILE_WIDTH.toFixed(4)} / rRef;
  float inCell = step(abs(thetaC), edge + (h3 - 0.5) * 0.45 * ${TILE_WIDTH.toFixed(4)} / rRef);
  float thetaF = vTile.x / rRef;
  float fw = fwidth(thetaF) * 1.5 + 1e-4;
  float inSmooth = 1.0 - smoothstep(edge - fw, edge + fw, abs(thetaF));
  float inside = mix(inCell, inSmooth, far);
  skTileMask = vTile.w > 1.5 ? 1.0 : (vTile.w > 0.5 ? inside : 0.0);

  float d = skHexDist(hx.xy);
  float gw = 0.03;
  float grout = smoothstep(0.5 - gw - px, 0.5 - gw + px, d);
  grout = mix(grout, 0.11, far);
  // Per-tile tone and gloss fade to their means once a tile is smaller than a pixel or two: sampled per pixel,
  // they would turn the heat shield into salt-and-pepper speckle (a cork-like look) at a distance.
  float hTone = mix(h1, 0.5, far);
  float hGloss = mix(h2, 0.5, far);
  vec3 tileBase = vec3(0.021, 0.021, 0.023) * (0.7 + 0.6 * hTone);
  // The odd replacement tile from a different batch reads slightly lighter.
  tileBase *= h2 > 0.993 ? mix(1.7, 1.0, far) : 1.0;
  vec3 tileCol = mix(tileBase, vec3(0.006), grout);
  // Matte ceramic: low gloss, so the tiles stay black under a low, warm sun instead of taking on its colour.
  skTileRough = mix(0.64 + 0.2 * hGloss, 0.92, grout);
  skTileH = smoothstep(0.5 - gw, 0.31, d) * (1.0 - far) * 0.004;
  diffuseColor.rgb = mix(diffuseColor.rgb, tileCol, skTileMask);
#endif

#ifdef SKIN_FROST
  // --- Frost over the tanks: streaky, patchy, with an uneven propellant line ---
  {
    float y = vObjPos.y;
    float nA = texture2D(uNoise, vec2(ang * 0.4775, y * 0.017)).r;
    float nB = texture2D(uNoise, vec2(ang * 1.91 + 0.31, y * 0.09)).g;
    float nC = texture2D(uNoise, vec2(ang * 7.0, y * 0.006)).b;
    float lineL = uFrostBands.y + (nA - 0.5) * 1.4;
    float lineC = uFrostBands.w + (nA - 0.5) * 1.4;
    float lox = smoothstep(uFrostBands.x, uFrostBands.x + 0.7, y) * (1.0 - smoothstep(lineL - 0.2, lineL + 0.2, y));
    float ch4 = smoothstep(uFrostBands.z, uFrostBands.z + 0.7, y) * (1.0 - smoothstep(lineC - 0.2, lineC + 0.2, y));
    float m = max(lox, ch4 * 0.92);
    // Coverage grows in patches and streaks as uFrost rises (full at 1).
    float cover = smoothstep(0.0, 0.22, uFrost * 1.6 - 0.6 + (nB - 0.5) * 0.8 + (nC - 0.5) * 0.45);
    skFrost = m * cover * smoothstep(0.0, 0.12, uFrost) * (1.0 - skTileMask);
    vec3 frostCol = vec3(0.66, 0.69, 0.72) * (0.8 + 0.35 * nB) * (0.9 + 0.2 * nC);
    diffuseColor.rgb = mix(diffuseColor.rgb, frostCol, skFrost);
  }
#endif

  // --- Soot near the base and scorch at the top ---
  {
    float y = vObjPos.y;
    // Streaks run along the hull (fast round the circumference, slow along y).
    float st = texture2D(uNoise, vec2(ang * 2.2 + 0.2, y * 0.012)).b;
    float st2 = texture2D(uNoise, vec2(ang * 7.3 + 0.5, y * 0.03)).a;
    float streak = st * 0.65 + st2 * 0.35;
    float low = (1.0 - smoothstep(uSoot.y, uSoot.z, y + (streak - 0.5) * 3.5)) * uSoot.x;
    float top = smoothstep(uScorch.y, uScorch.z, y + (streak - 0.5) * 1.6) * uScorch.x;
    skSoot = clamp(max(low, top) * (0.45 + 0.8 * streak), 0.0, 0.95) * (1.0 - skTileMask) * (1.0 - skFrost);
    diffuseColor.rgb *= 1.0 - 0.82 * skSoot;
  }

  roughnessFactor = mix(roughnessFactor, 0.72, skSoot);
  metalnessFactor = mix(metalnessFactor, 0.3, skSoot);
  roughnessFactor = mix(roughnessFactor, 0.88, skFrost);
  metalnessFactor = mix(metalnessFactor, 0.0, skFrost);
  roughnessFactor = mix(roughnessFactor, skTileRough, skTileMask);
  metalnessFactor = mix(metalnessFactor, 0.0, skTileMask);
}
`;

const FRAG_SPECULAR = /* glsl */ `
#ifdef SKIN_TILES
// The tiles reflect less than the generic 4% dielectric, and much less at grazing angles.
material.specularColorBlended = mix(material.specularColorBlended, vec3(0.025), skTileMask);
material.specularF90 = mix(material.specularF90, 0.55, skTileMask);
#endif
`;

const FRAG_NORMAL = /* glsl */ `
#ifdef SKIN_TILES
{
  vec3 nTile = skBump(-vViewPosition, nonPerturbedNormal, skTileH, faceDirection);
  normal = normalize(mix(normal, nTile, skTileMask));
}
#endif
`;

const FRAG_EMISSIVE = /* glsl */ `
{
  float ww = max(dot(normalize(vObjN), -uAirflow), 0.0);
  totalEmissiveRadiance += vec3(1.0, 0.28, 0.06) * (uHeat * uHeat * ww * ww * skTileMask * 1.6);
}
`;

export interface SkinOptions {
  maps: SteelMaps;
  noise: THREE.Texture;
  tiles: boolean;
  frost: boolean;
}

export function createSkinMaterial(o: SkinOptions): SkinMaterial {
  const uniforms = createSkinUniforms(o.noise);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: o.maps.albedo,
    roughnessMap: o.maps.orm,
    metalnessMap: o.maps.orm,
    normalMap: o.maps.normal,
    normalScale: new THREE.Vector2(1 / NORMAL_GAIN, 1 / NORMAL_GAIN),
    roughness: 1,
    metalness: 1,
    envMapIntensity: 1,
  });
  material.defines = { ...(material.defines ?? {}) };
  if (o.tiles) material.defines.SKIN_TILES = '';
  if (o.frost) material.defines.SKIN_FROST = '';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FRAG_SURFACE}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${FRAG_SPECULAR}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMISSIVE}`);
  };
  material.customProgramCacheKey = () => `veh-skin-v2|${o.tiles ? 't' : ''}${o.frost ? 'f' : ''}`;
  return { material, uniforms };
}

/** Plain physically based materials used for secondary parts. */
export function createDarkMaterial(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}
