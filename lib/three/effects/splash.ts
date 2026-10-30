import * as THREE from 'three';
import type { Splash } from '@/lib/three/contracts';
import { NOISE_KEY, SharedScope, makeNoiseTexture, seededRandom } from '@/lib/three/vehicles/procedural';
import { Billboards, MODE_PUFF, MODE_STREAK, PUFF_ATLAS_KEY, makePuffAtlas, newRecord, smooth } from './particles';

/**
 * Water impact: a ballistic spray column that collapses into a widening curtain, a crown of droplet
 * sheets (velocity-aligned streaks), a low base surge of mist rolling out over the water, and foam on the
 * surface: an expanding ring of churned water plus a patch round the touchdown point that stays while the
 * vehicle floats in it. Origin = impact point on the water surface, +Y up.
 * Pure function of (age, scale); `scale` is the size of the impacting body in metres (9 ≈ a vehicle
 * diameter). Heights grow sub-linearly with scale (k^0.45), widths with k^0.5, k = scale / 9, so a 70 m
 * booster raises a spray column of 40-100 m and a mist that settles within about 120 m: a chase camera a
 * couple of vehicle lengths away stays outside it (and the whole cloud thins out if one gets inside).
 */

const COLUMN = 56;
const CROWN = 72;
const MIST = 44;
const G = 9.81;

interface ColumnDef {
  h: number;
  dirX: number;
  dirZ: number;
  lean: number;
  delay: number;
  s0: number;
  grow: number;
  rot: number;
  spin: number;
  cell: number;
}

interface CrownDef {
  cos: number;
  sin: number;
  h: number;
  cot: number;
  r0: number;
  width: number;
  delay: number;
  seed: number;
}

interface MistDef {
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

function buildDefs(): { column: ColumnDef[]; crown: CrownDef[]; mist: MistDef[] } {
  const rnd = seededRandom(31337);
  const column: ColumnDef[] = [];
  for (let i = 0; i < COLUMN; i++) {
    const phi = rnd() * Math.PI * 2;
    column.push({
      // Peak height in units of the reference height (≈ 9 m body → 16..41 m column).
      h: 1.8 + 2.8 * Math.pow(rnd(), 1.4),
      dirX: Math.cos(phi),
      dirZ: Math.sin(phi),
      lean: 0.03 + 0.2 * rnd(),
      delay: 0.3 * rnd(),
      s0: 0.45 + 0.4 * rnd(),
      grow: 0.12 + 0.12 * rnd(),
      rot: rnd() * Math.PI * 2,
      spin: (rnd() - 0.5) * 0.4,
      cell: Math.floor(rnd() * 4),
    });
  }
  const crown: CrownDef[] = [];
  for (let i = 0; i < CROWN; i++) {
    const phi = ((i + 0.7 * rnd()) / CROWN) * Math.PI * 2;
    const el = THREE.MathUtils.degToRad(50 + 28 * rnd());
    crown.push({
      cos: Math.cos(phi),
      sin: Math.sin(phi),
      h: 0.7 + 2.0 * Math.pow(rnd(), 1.3),
      cot: 1 / Math.tan(el),
      r0: 0.45 + 0.25 * rnd(),
      width: 0.09 + 0.08 * rnd(),
      delay: 0.15 * rnd(),
      seed: rnd() * 100,
    });
  }
  const mist: MistDef[] = [];
  for (let i = 0; i < MIST; i++) {
    const phi = ((i + rnd()) / MIST) * Math.PI * 2;
    mist.push({
      cos: Math.cos(phi),
      sin: Math.sin(phi),
      reach: 1.0 + 1.6 * rnd(),
      td: 2.5 + 3 * rnd(),
      s0: 0.7 + 0.4 * rnd(),
      grow: 0.12 + 0.1 * rnd(),
      delay: 0.3 + 0.9 * rnd(),
      rot: rnd() * Math.PI * 2,
      cell: Math.floor(rnd() * 4),
      fade: 10 + 12 * rnd(),
    });
  }
  return { column, crown, mist };
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

export function createSplash(): Splash {
  const scope = new SharedScope();
  const atlas = scope.get(PUFF_ATLAS_KEY, makePuffAtlas);
  const noise = scope.get(NOISE_KEY, makeNoiseTexture);
  const object = new THREE.Group();
  object.name = 'splash';
  // Spray puffs and droplet sheets share one depth-sorted batch.
  // Split around the vertical axis: a landing burn's plume shows through the spray behind it, not in front.
  const batch = new Billboards(COLUMN + MIST + CROWN, atlas, true);
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
  object.add(foam, batch.mesh);

  const defs = buildDefs();
  const rec = newRecord();
  const shadow = new THREE.Vector4();

  return {
    object,
    setAge(age: number, scale: number) {
      batch.begin();
      if (!(age >= 0) || age > 60) {
        foam.visible = false;
        batch.finish();
        return;
      }
      const k = Math.max(scale, 0.5) / 9;
      const hRef = 9 * Math.pow(k, 0.45); // vertical reference, m
      const wRef = 9 * Math.pow(k, 0.5); // horizontal reference, m
      batch.uniforms.uGroundFade.value = 0.15 * wRef;

      // Column: spray launched upwards, collapsing into a widening curtain and drifting mist.
      for (const d of defs.column) {
        const t = age - d.delay;
        if (t < 0) continue;
        const v = Math.sqrt(2 * G * d.h * hRef);
        const flight = (2 * v) / G;
        const yb = v * t - 0.5 * G * t * t;
        const fall = smooth(0.5, 1.0, t / flight);
        // Falling spray slows (drag) and hangs as mist instead of plunging straight back.
        const y = Math.max(yb, d.h * hRef * 0.35 * (1 - smooth(flight * 0.8, flight * 2.2, t)));
        const out = wRef * (0.15 + d.lean * 2.2) * (1 - Math.exp(-t / 0.8)) + wRef * 0.5 * fall * d.lean * 4;
        const op = 0.85 * smooth(0, 0.06, t) * (1 - 0.5 * fall) * (1 - smooth(flight, flight * 1.2 + 6, t));
        if (op < 0.004) continue;
        rec.x = d.dirX * out;
        rec.y = y + wRef * 0.25;
        rec.z = d.dirZ * out;
        rec.size = wRef * (d.s0 + d.grow * Math.min(t, 6) + 0.08 * fall * Math.min(t, 10));
        rec.r = 0.87;
        rec.g = 0.9;
        rec.b = 0.93;
        rec.opacity = op;
        rec.er = rec.eg = rec.eb = 0;
        rec.temp = 0;
        rec.m0 = d.rot + d.spin * t;
        rec.m1 = d.cell;
        rec.m2 = 0.04 + 0.5 * fall;
        rec.m3 = 0;
        rec.mode = MODE_PUFF;
        batch.add(rec);
      }
      // Base surge: low, wide mist rolling out over the water.
      for (const d of defs.mist) {
        const t = age - d.delay;
        if (t < 0) continue;
        const R = wRef * (0.6 + d.reach * (1 - Math.exp(-t / d.td)));
        // The surge stops growing once it has settled on the water.
        const size = wRef * (d.s0 + d.grow * Math.pow(Math.min(t, 14), 0.8));
        const op = 0.32 * smooth(0, 0.6, t) * (1 - smooth(d.fade * 0.35, d.fade, t));
        if (op < 0.004) continue;
        rec.x = d.cos * R;
        rec.y = size * 0.32 + hRef * 0.03 * t;
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
        rec.m2 = 0.12 + 0.45 * smooth(1, d.fade, t);
        rec.m3 = 0;
        rec.mode = MODE_PUFF;
        batch.add(rec);
      }
      // Crown: droplet sheets thrown out on ballistic arcs.
      for (const d of defs.crown) {
        const t = age - d.delay;
        if (t < 0) continue;
        const vy = Math.sqrt(2 * G * d.h * hRef);
        const vh = vy * d.cot * Math.pow(k, 0.2);
        const y = vy * t - 0.5 * G * t * t;
        if (y < -0.5) continue;
        const R = wRef * d.r0 + vh * t;
        const vyy = vy - G * t;
        const speed = Math.sqrt(vh * vh + vyy * vyy);
        const life = (2 * vy) / G;
        const op = 0.34 * smooth(0, 0.05, t) * (1 - smooth(life * 0.55, life * 1.02, t));
        if (op < 0.004) continue;
        rec.x = d.cos * R;
        rec.y = Math.max(y, 0);
        rec.z = d.sin * R;
        // Thin sheets that break up as they fly: they stretch along the flight path, not sideways.
        rec.size = wRef * d.width * 0.4 * (1 + 0.3 * t);
        rec.r = 0.9;
        rec.g = 0.93;
        rec.b = 0.96;
        rec.opacity = op;
        rec.er = rec.eg = rec.eb = 0;
        rec.temp = 0;
        rec.m0 = (d.cos * vh) / speed;
        rec.m1 = vyy / speed;
        rec.m2 = (d.sin * vh) / speed;
        rec.m3 = Math.min(speed * 0.45, wRef * 2.2);
        rec.mode = MODE_STREAK;
        rec.taper = 1;
        rec.seed = d.seed;
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
    dispose() {
      object.remove(foam, batch.mesh);
      batch.dispose();
      foamGeo.dispose();
      foamMat.dispose();
      scope.releaseAll();
    },
  };
}
