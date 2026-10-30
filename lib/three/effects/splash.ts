import * as THREE from 'three';
import type { Splash } from '@/lib/three/contracts';
import { NOISE_KEY, SharedScope, makeNoiseTexture, seededRandom } from '@/lib/three/vehicles/procedural';
import { Billboards, MODE_PUFF, MODE_STREAK, PUFF_ATLAS_KEY, makePuffAtlas, newRecord, smooth } from './particles';

/**
 * Water impact, as seen at booster and ship splashdowns: a white spray column of jets of water thrown up round the
 * vehicle (each a ragged sheet that rises, stalls and falls back as a curtain), droplets raining fast out of it,
 * mist that drifts away low over the water and thins, and foam on the surface: an expanding ring of churned water
 * plus a patch round the touchdown point that stays while the vehicle floats in it. Origin = impact point on the
 * water surface, +Y up. Before touchdown (setApproach) the landing burn lights the water under the descending
 * vehicle, whose base is then the origin.
 * Pure function of (age, scale); `scale` is the size of the impacting body in metres (9 ≈ a vehicle diameter).
 * Heights grow sub-linearly with scale (k^0.45), widths with k^0.5, k = scale / 9, so a 70 m booster throws spray
 * 30-100 m up and a mist that settles within about 120 m: a chase camera a couple of vehicle lengths away stays
 * outside it (and the whole cloud thins out if one gets inside). While the vehicle still stands in the spray, no
 * sprite cuts through its hull (see uKeepOut in particles.ts).
 */

const JETS = 40;
/** Each jet is drawn as two straight segments (launched first → mid-launch → last launched). */
const JET_SEGS = 2;
const DROPS = 100;
const MIST = 44;
const SURGE = 26;
const G = 9.81;
/** Radius of the hull standing at the origin (both vehicles are 9 m across), and how long it stands. */
const HULL_RADIUS = 4.8;
const STANDING: [number, number] = [2.5, 5];

interface JetDef {
  cos: number;
  sin: number;
  /** Launch speed (per unit of sqrt(hRef)), its elevation, and how it decays over the feeding time. */
  v0: number;
  elev: number;
  /** Seconds over which the jet is fed, and the drag time constant of its spray. */
  feed: number;
  drag: number;
  width: number;
  op: number;
  seed: number;
}

interface DropDef {
  jet: number;
  /** Release time as a fraction of the jet's rise, and the scatter of its velocity (m/s per unit). */
  rel: number;
  sx: number;
  sy: number;
  sz: number;
  size: number;
  seed: number;
}

interface MistDef {
  jet: number;
  rel: number;
  s0: number;
  grow: number;
  rise: number;
  fade: number;
  rot: number;
  cell: number;
}

interface SurgeDef {
  cos: number;
  sin: number;
  reach: number;
  td: number;
  s0: number;
  grow: number;
  delay: number;
  rot: number;
  cell: number;
  fade: number;
}

function buildDefs(): { jets: JetDef[]; drops: DropDef[]; mist: MistDef[]; surge: SurgeDef[] } {
  const rnd = seededRandom(31337);
  const jets: JetDef[] = [];
  for (let i = 0; i < JETS; i++) {
    const phi = ((i + 0.7 * rnd()) / JETS) * Math.PI * 2;
    // Peak heights (without drag) of 1.6..5.4 reference heights, steep and slightly outwards; a quarter of them
    // nearly vertical and broad, the dense core of the column round the hull.
    const core = i % 4 === 0;
    const h = 1.6 + 3.8 * Math.pow(rnd(), 1.2);
    const elev = THREE.MathUtils.degToRad(core ? 80 + 8 * rnd() : 62 + 22 * rnd());
    jets.push({
      cos: Math.cos(phi),
      sin: Math.sin(phi),
      v0: Math.sqrt(2 * G * h) / Math.sin(elev),
      elev,
      feed: 0.4 + 0.6 * rnd(),
      drag: 3 + 2 * rnd(),
      width: core ? 0.22 + 0.08 * rnd() : 0.11 + 0.09 * rnd(),
      op: 0.6 + 0.3 * rnd(),
      seed: rnd() * 100,
    });
  }
  const drops: DropDef[] = [];
  for (let i = 0; i < DROPS; i++) {
    drops.push({
      jet: Math.floor(rnd() * JETS),
      rel: 0.3 + 1.3 * rnd(),
      sx: (rnd() - 0.5) * 2,
      sy: (rnd() - 0.5) * 2,
      sz: (rnd() - 0.5) * 2,
      size: 0.6 + 0.8 * rnd(),
      seed: rnd() * 100,
    });
  }
  const mist: MistDef[] = [];
  for (let i = 0; i < MIST; i++) {
    mist.push({
      jet: Math.floor(rnd() * JETS),
      rel: 0.5 + 0.9 * rnd(),
      s0: 0.7 + 0.5 * rnd(),
      grow: 0.08 + 0.08 * rnd(),
      rise: 0.2 + 0.5 * rnd(),
      fade: 14 + 14 * rnd(),
      rot: rnd() * Math.PI * 2,
      // Mostly smooth haze, some with a little texture: a veil, not separate puffs.
      cell: rnd() < 0.7 ? 4 : Math.floor(rnd() * 4),
    });
  }
  const surge: SurgeDef[] = [];
  for (let i = 0; i < SURGE; i++) {
    const phi = ((i + rnd()) / SURGE) * Math.PI * 2;
    surge.push({
      cos: Math.cos(phi),
      sin: Math.sin(phi),
      reach: 1.0 + 1.6 * rnd(),
      td: 2.5 + 3 * rnd(),
      s0: 0.7 + 0.4 * rnd(),
      grow: 0.1 + 0.1 * rnd(),
      delay: 0.6 + 1.2 * rnd(),
      rot: rnd() * Math.PI * 2,
      cell: Math.floor(rnd() * 4),
      fade: 10 + 12 * rnd(),
    });
  }
  return { jets, drops, mist, surge };
}

/**
 * Position (horizontal distance out, height) of spray launched at `speed` and elevation `elev`, `t` seconds later,
 * under gravity and linear drag with time constant `td` (exact solution of v' = −v/td − g).
 */
function sprayAt(speed: number, elev: number, td: number, t: number, out: { r: number; y: number; vr: number; vy: number }): void {
  const e = Math.exp(-t / td);
  const vh = speed * Math.cos(elev);
  const vv = speed * Math.sin(elev);
  out.r = vh * td * (1 - e);
  out.y = (vv + G * td) * td * (1 - e) - G * td * t;
  out.vr = vh * e;
  out.vy = (vv + G * td) * e - G * td;
}

const FOAM_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
uniform float uRadius;
varying vec2 vXZ;
void main() {
  vec3 p = position * uRadius;
  vXZ = p.xz;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;

const FOAM_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uNoise;
uniform float uOuter;
uniform float uInner;
uniform float uOpacity;
uniform float uPatch;
uniform float uPatchOpacity;
uniform float uSeed;
uniform vec3 uLight;
varying vec2 vXZ;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vXZ);
  vec2 q = vXZ / max(uOuter, 1.0);
  // Patchy, streaky foam: two noise octaves, thresholded; denser near the leading edge.
  float n = texture2D(uNoise, q * 1.3 + uSeed).g * 0.6 + texture2D(uNoise, q * 3.9 - uSeed).r * 0.55;
  float band = smoothstep(uInner * 0.6, uInner + (uOuter - uInner) * 0.7, r) * (1.0 - smoothstep(uOuter * 0.86, uOuter, r));
  float lead = smoothstep(uOuter * 0.72, uOuter * 0.92, r) * (1.0 - smoothstep(uOuter * 0.92, uOuter, r));
  float foam = smoothstep(0.38, 0.95, n + lead * 0.3) * band;
  // Churned water round the touchdown point, where the vehicle floats: dense close in, breaking up into
  // streaks towards a ragged edge.
  vec2 qp = vXZ / max(uPatch, 1.0);
  float np = texture2D(uNoise, qp * 1.4 + uSeed * 2.0).r * 0.55 + texture2D(uNoise, qp * 4.3 - uSeed).g * 0.5;
  float pr = length(qp) + (np - 0.52) * 0.45;
  float patchFoam = smoothstep(0.42, 0.9, np + (1.0 - pr) * 0.55) * (1.0 - smoothstep(0.55, 1.0, pr));
  float a = clamp(max(foam * uOpacity, patchFoam * uPatchOpacity), 0.0, 0.8);
  if (a < 0.003) discard;
  vec3 c = uLight * 0.75 * RECIPROCAL_PI;
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  c = linearToOutputTexel(vec4(c, 1.0)).rgb;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    c = mix(c, fogColor, fogF);
  #endif
  gl_FragColor = vec4(c * a, a);
}`;

const POOL_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
uniform float uRadius;
uniform float uY;
varying vec2 vXZ;
void main() {
  vec3 p = position * uRadius;
  p.y += uY;
  vXZ = p.xz;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}`;

const POOL_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform vec3 uLight;
uniform float uH;
uniform float uRadius;
varying vec2 vXZ;
void main() {
  #include <logdepthbuf_fragment>
  // Irradiance on the water from the exhaust, a source uH above it: cos(theta) / d^2 = H / d^3 (softened
  // over a few metres, the size of the glowing plume), faded out towards the rim of the disc.
  float r2 = dot(vXZ, vXZ);
  float d2 = r2 + uH * uH + 25.0;
  float E = uH / (d2 * sqrt(d2));
  vec3 c = uLight * E * (1.0 - smoothstep(0.55, 1.0, sqrt(r2) / uRadius));
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  c = linearToOutputTexel(vec4(c, 1.0)).rgb;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    c *= 1.0 - fogF;
  #endif
  gl_FragColor = vec4(c, 1.0);
}`;

/** Warm colour of the exhaust's light (as the vehicles' own exhaust light). */
const POOL_COLOR = new THREE.Color(1.0, 0.62, 0.32);
/**
 * Radiance scale of the lit water per full-throttle engine: the exhaust's intensity (in the units of the
 * vehicles' exhaust light) times the reflectance of water churned up by the exhaust, 0.15, over pi.
 */
const POOL_GAIN = 900 * (0.15 / Math.PI);

export function createSplash(): Splash {
  const scope = new SharedScope();
  const atlas = scope.get(PUFF_ATLAS_KEY, makePuffAtlas);
  const noise = scope.get(NOISE_KEY, makeNoiseTexture);
  const object = new THREE.Group();
  object.name = 'splash';
  // Spray jets, droplets and mist share one depth-sorted batch.
  // Split around the vertical axis: a landing burn's plume shows through the spray behind it, not in front.
  const batch = new Billboards(JETS * JET_SEGS + DROPS + MIST + SURGE, atlas, true);
  batch.mesh.name = 'splash-spray';
  // Start thinning out well before the camera reaches the spray: the mist spreads wider than its bulk.
  batch.insideFade = 0.2;
  batch.insideReach = 1.6;

  const foamMat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uNoise: { value: noise },
      uRadius: { value: 10 },
      uOuter: { value: 10 },
      uInner: { value: 5 },
      uOpacity: { value: 0 },
      uPatch: { value: 10 },
      uPatchOpacity: { value: 0 },
      uSeed: { value: 0.37 },
      uLight: { value: new THREE.Color(3, 3, 3) },
    },
    vertexShader: FOAM_VERT,
    fragmentShader: FOAM_FRAG,
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // Unit disc in the XZ plane, scaled in the vertex shader. The origin follows the floating vehicle, which
  // can ride a few centimetres low, and the log depth buffer ignores polygon offset: lift the foam clear.
  const foamGeo = new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2);
  const foam = new THREE.Mesh(foamGeo, foamMat);
  foam.name = 'splash-foam';
  foam.position.y = 0.4;
  foam.frustumCulled = false;
  foam.visible = false;
  foam.renderOrder = -1;
  foam.onBeforeRender = () => {
    // Flat surface lit by the sun and sky (the lights the spray found this frame).
    const l = batch.lights;
    const up = Math.max(l.sunDir.dot(l.up), 0);
    (foamMat.uniforms.uLight.value as THREE.Color).copy(l.sunColor).multiplyScalar(up).add(l.skyColor);
  };
  // Light from a landing burn on the water below: additive, on the foam's disc.
  const poolMat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uLight: { value: new THREE.Color(0, 0, 0) },
      uH: { value: 10 },
      uRadius: { value: 40 },
      uY: { value: 0 },
    },
    vertexShader: POOL_VERT,
    fragmentShader: POOL_FRAG,
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pool = new THREE.Mesh(foamGeo, poolMat);
  pool.name = 'splash-light-pool';
  pool.frustumCulled = false;
  pool.visible = false;
  pool.renderOrder = -2;
  object.add(foam, pool, batch.mesh);

  const defs = buildDefs();
  const rec = newRecord();
  const shadow = new THREE.Vector4();
  const pa = { r: 0, y: 0, vr: 0, vy: 0 };
  const pb = { r: 0, y: 0, vr: 0, vy: 0 };
  /** Adds one straight streak of spray from (r0, y0) to (r1, y1) along azimuth (c, s), r out from the base ring. */
  const segment = (c: number, sn: number, base: number, r0: number, y0: number, r1: number, y1: number) => {
    const x0 = c * (base + r0);
    const z0 = sn * (base + r0);
    const x1 = c * (base + r1);
    const z1 = sn * (base + r1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-3) return false;
    rec.x = x1;
    rec.y = y1;
    rec.z = z1;
    rec.m0 = dx / len;
    rec.m1 = dy / len;
    rec.m2 = dz / len;
    rec.m3 = len;
    return true;
  };

  const api: Splash = {
    object,
    setAge(age: number, scale: number) {
      // Lit again by setApproach, if the stage calls it this frame.
      pool.visible = false;
      batch.begin();
      if (!(age >= 0) || age > 60) {
        foam.visible = false;
        batch.finish();
        return;
      }
      const k = Math.max(scale, 0.5) / 9;
      const hRef = 9 * Math.pow(k, 0.45); // vertical reference, m
      const wRef = 9 * Math.pow(k, 0.5); // horizontal reference, m
      const vk = Math.sqrt(hRef); // launch speeds scale with the square root of the heights they reach
      const base = Math.min(HULL_RADIUS * 1.15, wRef * 0.3); // the jets rise round the hull, not out of it
      batch.uniforms.uGroundFade.value = 0.08 * wRef;
      // The vehicle stands in the spray for the first seconds, then topples into it.
      batch.uniforms.uKeepOut.value.set(HULL_RADIUS * (1 - smooth(STANDING[0], STANDING[1], age)), -5, 6 * hRef);

      // Jets: water launched over each jet's feeding time, fastest first, so the jet is a ragged sheet from the
      // water up to its head; once fed it detaches, stalls and falls back as a curtain.
      for (const d of defs.jets) {
        const v0 = d.v0 * vk;
        const fed = Math.min(age, d.feed);
        // Head (launched first), middle and tail (launched last, slower) of the sheet.
        const speedAt = (tau: number) => v0 * (1 - 0.5 * (tau / d.feed));
        sprayAt(v0, d.elev, d.drag, age, pa);
        const apex = (v0 * Math.sin(d.elev)) / G;
        const op = d.op * smooth(0, 0.06, age) * (1 - smooth(apex * 0.8, apex * 1.8 + 1, age));
        if (op < 0.004) continue;
        const w = wRef * d.width * (1 + 0.6 * Math.min(age, 6));
        let prevR = pa.r;
        let prevY = Math.max(pa.y, 0);
        for (let sgi = 1; sgi <= JET_SEGS; sgi++) {
          const tau = (fed * sgi) / JET_SEGS;
          sprayAt(speedAt(tau), d.elev, d.drag, age - tau, pb);
          const r1 = pb.r;
          const y1 = Math.max(pb.y, 0);
          // From the lower end up to the higher one, so the streak's bright head is at the top.
          const up = y1 >= prevY;
          if (!(up ? segment(d.cos, d.sin, base, prevR, prevY, r1, y1) : segment(d.cos, d.sin, base, r1, y1, prevR, prevY))) {
            continue;
          }
          rec.size = w * (1 + 0.25 * sgi);
          rec.r = 0.9;
          rec.g = 0.93;
          rec.b = 0.97;
          rec.opacity = op * (sgi === 1 ? 1 : 0.85);
          rec.er = rec.eg = rec.eb = 0;
          rec.temp = 0;
          rec.mode = MODE_STREAK;
          rec.taper = 0;
          rec.seed = d.seed + sgi * 3.1;
          batch.add(rec);
          prevR = r1;
          prevY = y1;
        }
      }

      // Droplets: big drops shed by the jets, raining back down fast (velocity-aligned streaks, a motion-blur long).
      for (const d of defs.drops) {
        const j = defs.jets[d.jet];
        const v0 = j.v0 * vk;
        const apex = (v0 * Math.sin(j.elev)) / G;
        const t0 = d.rel * apex;
        const a = age - t0;
        if (a <= 0) continue;
        sprayAt(v0, j.elev, j.drag, t0, pa);
        if (pa.y <= 0) continue;
        // Free fall from the release point with the jet's velocity plus some scatter; drops feel less drag.
        const td = 7;
        const e = Math.exp(-a / td);
        const vr = pa.vr + d.sx * 2.5 * vk * 0.25;
        const vt = d.sz * 2.5 * vk * 0.25;
        const vy0 = pa.vy + d.sy * 2.0 * vk * 0.25;
        const y = pa.y + (vy0 + G * td) * td * (1 - e) - G * td * a;
        if (y <= 0) continue;
        const r = base + pa.r + vr * td * (1 - e);
        const tside = vt * td * (1 - e);
        const vy = (vy0 + G * td) * e - G * td;
        const vrr = vr * e;
        const vtt = vt * e;
        const speed = Math.sqrt(vy * vy + vrr * vrr + vtt * vtt);
        if (speed < 1e-3) continue;
        // World direction of the drop's velocity (radial r̂ = (cos, 0, sin), tangent t̂ = (−sin, 0, cos)).
        const dx = (vrr * j.cos - vtt * j.sin) / speed;
        const dz = (vrr * j.sin + vtt * j.cos) / speed;
        rec.x = j.cos * r - j.sin * tside;
        rec.y = y;
        rec.z = j.sin * r + j.cos * tside;
        rec.m0 = dx;
        rec.m1 = vy / speed;
        rec.m2 = dz;
        rec.m3 = Math.min(speed * 0.07, wRef * 0.5);
        rec.size = wRef * 0.02 * d.size;
        rec.r = 0.92;
        rec.g = 0.95;
        rec.b = 0.98;
        rec.opacity = 0.5 * smooth(0, 0.15, a) * (1 - smooth(apex * 2.5, apex * 3.5, age));
        if (rec.opacity < 0.004) continue;
        rec.er = rec.eg = rec.eb = 0;
        rec.temp = 0;
        rec.mode = MODE_STREAK;
        rec.taper = 1;
        rec.seed = d.seed;
        batch.add(rec);
      }

      // Mist: fine spray left hanging where the jets broke up, spreading, drifting up a little and thinning out.
      for (const d of defs.mist) {
        const j = defs.jets[d.jet];
        const v0 = j.v0 * vk;
        const apex = (v0 * Math.sin(j.elev)) / G;
        const t0 = d.rel * apex;
        const a = age - t0;
        if (a <= 0) continue;
        sprayAt(v0, j.elev, j.drag, t0, pa);
        const size = wRef * (d.s0 + d.grow * Math.pow(Math.min(a, 20), 0.85));
        const op = 0.16 * smooth(0, 1.2, a) * (1 - smooth(d.fade * 0.4, d.fade, a));
        if (op < 0.004) continue;
        // Settles from where it was left towards a low layer, drifting outwards.
        const y = Math.max(pa.y * Math.exp(-a / 3) + hRef * 0.04 * d.rise * a, size * 0.3);
        const r = base + pa.r + wRef * 0.08 * a;
        rec.x = j.cos * r;
        rec.y = y;
        rec.z = j.sin * r;
        rec.size = size;
        rec.r = 0.9;
        rec.g = 0.93;
        rec.b = 0.96;
        rec.opacity = op;
        rec.er = rec.eg = rec.eb = 0;
        rec.temp = 0;
        rec.m0 = d.rot + 0.03 * a;
        rec.m1 = d.cell;
        rec.m2 = 0.35 + 0.4 * smooth(0, d.fade, a);
        rec.m3 = 0;
        rec.mode = MODE_PUFF;
        rec.flat = 0.75;
        batch.add(rec);
      }

      // Base surge: a low, wide layer of mist rolling out over the water from the foot of the column.
      for (const d of defs.surge) {
        const t = age - d.delay;
        if (t < 0) continue;
        const R = base + wRef * (0.5 + d.reach * (1 - Math.exp(-t / d.td)));
        // The surge stops growing once it has settled on the water.
        const size = wRef * (d.s0 + d.grow * Math.pow(Math.min(t, 14), 0.8));
        const op = 0.2 * smooth(0, 0.8, t) * (1 - smooth(d.fade * 0.35, d.fade, t));
        if (op < 0.004) continue;
        rec.x = d.cos * R;
        rec.y = size * 0.22 + hRef * 0.02 * t;
        rec.z = d.sin * R;
        rec.size = size;
        rec.r = 0.88;
        rec.g = 0.91;
        rec.b = 0.94;
        rec.opacity = op;
        rec.er = rec.eg = rec.eb = 0;
        rec.temp = 0;
        rec.m0 = d.rot + 0.04 * t;
        rec.m1 = d.cell;
        rec.m2 = 0.3 + 0.45 * smooth(1, d.fade, t);
        rec.m3 = 0;
        rec.mode = MODE_PUFF;
        rec.flat = 0.5;
        batch.add(rec);
      }
      // Foam on the surface: the expanding ring, and the patch the vehicle floats in until it is gone.
      const outer = wRef * (0.8 + 2.0 * (1 - Math.exp(-age / 2.5)) + 0.35 * Math.sqrt(age));
      const patch = Math.max(scale, 0.5) * (0.22 + 0.18 * (1 - Math.exp(-age / 4)) + 0.006 * age);
      foamMat.uniforms.uRadius.value = Math.max(outer, patch) * 1.02;
      foamMat.uniforms.uOuter.value = outer;
      foamMat.uniforms.uInner.value = outer * (0.2 + 0.5 * smooth(0, 25, age));
      foamMat.uniforms.uOpacity.value = smooth(0, 0.4, age) * (1 - smooth(8, 32, age)) * 0.55;
      foamMat.uniforms.uPatch.value = patch;
      foamMat.uniforms.uPatchOpacity.value = smooth(0.2, 1.5, age) * (1 - smooth(48, 60, age)) * 0.8;
      foam.visible = true;
      batch.uniforms.uShadow.value.copy(batch.bulk(shadow, 0.1));
      batch.finish();
    },
    setApproach(height: number, thrust: number) {
      // The source sits a few metres under the nozzles, in the brightest part of the exhaust.
      const h = Math.max(height - 6, 2);
      const k = Math.pow(Math.max(thrust, 0), 0.6);
      pool.visible = k > 0.01 && height < 300;
      if (!pool.visible) return;
      const u = poolMat.uniforms;
      (u.uLight.value as THREE.Color).copy(POOL_COLOR).multiplyScalar(POOL_GAIN * k);
      u.uH.value = h;
      u.uRadius.value = 4 * h + 20;
      // On the water (lifted clear of it, as the foam is), not at the base of the vehicle above it.
      u.uY.value = 0.4 - Math.max(height, 0);
    },
    dispose() {
      object.remove(foam, pool, batch.mesh);
      batch.dispose();
      foamGeo.dispose();
      foamMat.dispose();
      poolMat.dispose();
      scope.releaseAll();
    },
  };
  return api;
}
