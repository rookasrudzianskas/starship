import * as THREE from 'three';
import type { LaunchClouds, Quality } from '@/lib/three/contracts';
import { SharedScope, seededRandom } from '@/lib/three/vehicles/procedural';
import { Billboards, PUFF_ATLAS_KEY, makePuffAtlas, newRecord, smooth } from './particles';

/**
 * Liftoff exhaust and deluge steam in the pad frame (origin on the ground at the mount centre, +Y up).
 *
 * From engine startup (T-3.5 s) the plume hits the deflector under the mount and a dense, ground-hugging
 * torus of steam and dust erupts radially. Each puff owns a fixed fraction of that torus: it follows an
 * expanding front (fast at first, then slowing), billows upwards as the cloud thickens, grows, drifts with
 * a light breeze and dissolves over a couple of minutes. A rising column of steam wraps the mount and the
 * climbing vehicle, and late deluge steam keeps welling up around the mount. A warm point light (the plume
 * impinging on the pad, then climbing with the vehicle) lights the cloud from inside while thrust > 0,
 * and incandescent exhaust spills out under the mount during startup and the first seconds of flight.
 * Pure function of t (seconds since T+0); `thrust` only scales the glow.
 */

const STARTUP = -3.5;
const MOUNT_TOP = 22; // m, between Pad 1 (21) and Pad 2 (24)

type Kind = 0 | 1 | 2; // ground torus, rising column, late deluge steam

interface CloudDef {
  kind: Kind;
  birth: number;
  cos: number;
  sin: number;
  /** Fraction of the front radius (ground torus) or base radius in m (others). */
  f: number;
  lift: number;
  s0: number;
  grow: number;
  w: number;
  dust: number;
  fadeStart: number;
  fadeLen: number;
  rot: number;
  spin: number;
  cell: number;
  shade: number;
}

interface FireDef {
  x: number;
  y: number;
  z: number;
  size: number;
  rot: number;
  cell: number;
  freq: number;
  phase: number;
  out: number;
}

function buildDefs(count: number, fires: number): { clouds: CloudDef[]; fire: FireDef[] } {
  const rnd = seededRandom(777 + count);
  const clouds: CloudDef[] = [];
  for (let i = 0; i < count; i++) {
    const u = rnd();
    const kind: Kind = u < 0.66 ? 0 : u < 0.86 ? 1 : 2;
    const phi = rnd() * Math.PI * 2;
    const base = {
      kind,
      cos: Math.cos(phi),
      sin: Math.sin(phi),
      fadeStart: 50 + 45 * rnd(),
      fadeLen: 40 + 40 * rnd(),
      rot: rnd() * Math.PI * 2,
      spin: (rnd() - 0.5) * 0.1,
      cell: Math.floor(rnd() * 4),
      shade: 0.92 + 0.08 * rnd(),
    };
    if (kind === 0) {
      const birth = -3.4 + 7.5 * Math.pow(rnd(), 1.6);
      const f = Math.sqrt(0.04 + 0.96 * rnd());
      clouds.push({
        ...base,
        birth,
        f,
        lift: rnd(),
        s0: 18 + 22 * f + 10 * rnd(),
        grow: 1.6 + 1.6 * rnd(),
        w: 0,
        dust: (0.25 + 0.45 * rnd()) * (birth < 0.5 ? 1 : 0.6),
      });
    } else if (kind === 1) {
      clouds.push({
        ...base,
        birth: -3 + 15 * rnd(),
        f: 8 + 34 * rnd(),
        lift: 4 + 26 * rnd(),
        s0: 18 + 14 * rnd(),
        grow: 1.6 + 1.8 * rnd(),
        w: 3 + 8 * rnd(),
        dust: 0.05 + 0.2 * rnd(),
      });
    } else {
      clouds.push({
        ...base,
        birth: 2 + 26 * rnd(),
        f: 12 + 50 * rnd(),
        lift: 2 + 6 * rnd(),
        s0: 20 + 14 * rnd(),
        grow: 1.4 + 1.6 * rnd(),
        w: 0.8 + 2.5 * rnd(),
        dust: 0.03 + 0.12 * rnd(),
      });
    }
  }
  const fire: FireDef[] = [];
  for (let k = 0; k < fires; k++) {
    const phi = (k / fires + 0.35 * rnd()) * Math.PI * 2;
    const r = 3 + 15 * rnd();
    fire.push({
      x: Math.cos(phi) * r,
      y: 2 + 7 * rnd(),
      z: Math.sin(phi) * r,
      size: 14 + 16 * rnd(),
      rot: rnd() * Math.PI * 2,
      cell: Math.floor(rnd() * 4),
      freq: 6 + 9 * rnd(),
      phase: rnd() * Math.PI * 2,
      out: 0.6 + 0.8 * rnd(),
    });
  }
  return { clouds, fire };
}

/** Height of the vehicle base above the mount top at time t (rough liftoff profile, ~0.4 g net). */
function climb(t: number): number {
  return t > 0 ? 0.5 * 4.0 * t * t : 0;
}

export function createLaunchClouds(quality: Quality): LaunchClouds {
  const count = quality === 'high' ? 300 : 120;
  const fires = quality === 'high' ? 16 : 8;
  // Fewer, bigger puffs on 'low' keep the cloud continuous.
  const sizeK = quality === 'high' ? 1 : 1.35;
  const scope = new SharedScope();
  const atlas = scope.get(PUFF_ATLAS_KEY, makePuffAtlas);
  const object = new THREE.Group();
  object.name = 'launch-clouds';
  const puffs = new Billboards(count + fires, atlas);
  puffs.mesh.name = 'launch-cloud-puffs';
  puffs.uniforms.uGroundFade.value = 6;
  puffs.uniforms.uAoHeight.value = 70;
  object.add(puffs.mesh);

  const defs = buildDefs(count, fires);
  const rec = newRecord();
  const shadow = new THREE.Vector4();
  const glowColor = new THREE.Color(1.0, 0.42, 0.12);
  // Gentle onshore sea breeze from the south-east (m/s), pad frame (+X east, +Z south): drifts north-west.
  const driftX = -1.2;
  const driftZ = -0.6;

  return {
    object,
    update(t: number, thrust: number, camera: THREE.Camera) {
      puffs.setCamera(camera);
      puffs.begin();
      if (!(t >= STARTUP) || t > 260) {
        puffs.finish();
        return;
      }
      const th = Math.min(Math.max(thrust, 0), 1);
      // Warm light: starts at the flame deflector, climbs with the plume's impingement point and fades
      // once the plume no longer reaches the ground.
      const glowY = Math.min(Math.max(MOUNT_TOP + climb(t) - 38, 3), 400);
      const glowK = th * (1 - smooth(6, 20, t)) * smooth(STARTUP, STARTUP + 1.2, t);
      puffs.uniforms.uGlowPos.value.set(0, glowY, 0);
      puffs.uniforms.uGlowColor.value.copy(glowColor).multiplyScalar(30 * glowK);

      for (const d of defs.clouds) {
        const age = t - d.birth;
        if (age < 0) continue;
        let R: number;
        let y: number;
        let size: number;
        if (d.kind === 0) {
          // Expanding torus front; the cloud thickens and billows up as it spreads.
          const front = 22 + 250 * (1 - Math.exp(-age / 5.5)) + 2.2 * age;
          R = 6 + d.f * front;
          size = (d.s0 + d.grow * Math.pow(age, 0.85) * (0.7 + 0.6 * d.f)) * sizeK;
          const thick = 12 + 8 * Math.pow(age, 0.8);
          y = size * 0.42 + d.lift * thick * (0.35 + 0.65 * d.f);
        } else if (d.kind === 1) {
          R = d.f + 1.5 * age;
          size = (d.s0 + d.grow * Math.pow(age, 0.85)) * sizeK;
          y = Math.max(d.lift + d.w * (age - 3 * (1 - Math.exp(-age / 3))), size * 0.45);
        } else {
          R = d.f + 2.5 * age;
          size = (d.s0 + d.grow * Math.pow(age, 0.85)) * sizeK;
          y = Math.max(d.lift + d.w * age, size * 0.42);
        }
        size = Math.min(size, 190);
        const op =
          smooth(0, 0.8, age) *
          (1 - smooth(d.fadeStart, d.fadeStart + d.fadeLen, age)) *
          Math.min(Math.max(1.25 - size / 230, 0.4), 1) *
          0.78;
        if (op < 0.004) continue;
        rec.x = d.cos * R + driftX * age;
        rec.z = d.sin * R + driftZ * age;
        rec.y = y;
        rec.size = size;
        const dust = d.dust;
        rec.r = (0.88 + (0.56 - 0.88) * dust) * d.shade;
        rec.g = (0.88 + (0.5 - 0.88) * dust) * d.shade;
        rec.b = (0.89 + (0.43 - 0.89) * dust) * d.shade;
        rec.opacity = op;
        rec.er = rec.eg = rec.eb = 0;
        rec.temp = 0;
        rec.m0 = d.rot + d.spin * age;
        rec.m1 = d.cell;
        rec.m2 = 0.04 + 0.6 * smooth(d.fadeStart - 30, d.fadeStart + d.fadeLen, age);
        const dx = rec.x;
        const dy = rec.y - glowY;
        const dz = rec.z;
        rec.m3 = 1 / (1 + (dx * dx + dy * dy + dz * dz) / (60 * 60));
        puffs.add(rec);
      }

      // Incandescent exhaust spilling out under the mount (startup and the first seconds of flight).
      const fireK = th * smooth(STARTUP, STARTUP + 0.8, t) * (1 - smooth(2.5, 9, t));
      if (fireK > 0.003) {
        for (let k = 0; k < defs.fire.length; k++) {
          const f = defs.fire[k];
          const flick = 0.8 + 0.2 * Math.sin(t * f.freq + f.phase) * Math.sin(t * f.freq * 0.37 + f.phase * 2);
          const spread = 1 + 0.35 * f.out * smooth(STARTUP, 3, t);
          rec.x = f.x * spread;
          rec.y = f.y;
          rec.z = f.z * spread;
          rec.size = f.size * (0.9 + 0.2 * flick);
          rec.r = 0.12;
          rec.g = 0.09;
          rec.b = 0.07;
          rec.opacity = 0.15 * fireK;
          const e = 0.9 * fireK * flick;
          rec.er = e;
          rec.eg = e;
          rec.eb = e;
          rec.temp = 0.52 + 0.22 * flick;
          rec.m0 = f.rot + t * 0.9 * (k % 2 === 0 ? 1 : -1);
          rec.m1 = f.cell;
          rec.m2 = 0.12;
          rec.m3 = 1;
          puffs.add(rec);
        }
      }
      puffs.uniforms.uShadow.value.copy(puffs.bulk(shadow, 0.15));
      puffs.finish();
    },
    dispose() {
      object.remove(puffs.mesh);
      puffs.dispose();
      scope.releaseAll();
    },
  };
}
