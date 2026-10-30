import * as THREE from 'three';
import type { Explosion } from '@/lib/three/contracts';
import { SharedScope, seededRandom } from '@/lib/three/vehicles/procedural';
import { Billboards, MODE_PUFF, MODE_STREAK, PUFF_ATLAS_KEY, makePuffAtlas, mix, newRecord, smooth, sphereDir } from './particles';

/**
 * Vehicle explosion / breakup. Everything is a pure function of (age, scale, airDensityRatio):
 *  - air: an incandescent fireball of lumpy puffs that cools from white through orange into dark soot
 *    and white vapour, rises buoyantly and spreads; hot debris streaks arc out on drag + gravity
 *    trajectories, some leaving persistent smoke trails.
 *  - vacuum: a short, very bright flash; thin shells of propellant vapour expanding freely at about
 *    100 m/s (like propellant vented in orbit), sunlit and brightest at their rims, that dilute away within
 *    about two seconds, with faint clumps of vapour in them; glowing fragments fly in straight lines. No
 *    fireball, no buoyant smoke.
 *  - in between: both models evaluated and blended by w = ratio^0.3, except the fire: it needs air, so the gas
 *    cools as in vacuum below about a tenth of sea-level density.
 * Buoyancy and gravity act along the local vertical: the scene's HemisphereLight direction if there is
 * one, converted into the object's frame; otherwise the object's +Y (orient the object with +Y = up).
 */

const FIREBALL = 90;
const SHELLS = 5;
const DEBRIS = 40;
const TRAILS = 14;
const TRAIL_SEGS = 14;
const CAPACITY = 2 + SHELLS + FIREBALL + DEBRIS + TRAILS * TRAIL_SEGS;
/** Atlas cell of the billboard shader's limb-brightened shell profile (see particles.ts). */
const SHELL_CELL = 5;
const G = 9.81;

interface PuffDef {
  dir: THREE.Vector3;
  spd: number;
  s0: number;
  cool: number;
  delay: number;
  soot: boolean;
  shade: number;
  rot: number;
  spin: number;
  cell: number;
  rise: number;
}

interface ShellDef {
  /** Offset of the centre from the burst point, in shell radii. */
  off: THREE.Vector3;
  spd: number;
  op: number;
  delay: number;
  rot: number;
  spin: number;
  shade: number;
}

interface DebrisDef {
  dir: THREE.Vector3;
  spd: number;
  life: number;
  drag: number;
  width: number;
  hot: number;
}

function buildDefs(): { puffs: PuffDef[]; shells: ShellDef[]; debris: DebrisDef[] } {
  const rnd = seededRandom(424242);
  const puffs: PuffDef[] = [];
  for (let i = 0; i < FIREBALL; i++) {
    const dir = sphereDir(rnd(), rnd(), new THREE.Vector3());
    const late = rnd() < 0.18;
    puffs.push({
      dir,
      spd: 0.22 + 0.78 * Math.pow(rnd(), 0.7),
      s0: 0.16 + 0.16 * rnd(),
      cool: 0.55 + 0.9 * rnd(),
      delay: late ? 0.12 + 0.55 * rnd() : 0.03 * rnd(),
      soot: rnd() < 0.68,
      shade: 0.75 + 0.5 * rnd(),
      rot: rnd() * Math.PI * 2,
      spin: (rnd() - 0.5) * 0.5,
      cell: Math.floor(rnd() * 4),
      rise: 0.65 + 0.7 * rnd(),
    });
  }
  const debris: DebrisDef[] = [];
  for (let i = 0; i < DEBRIS; i++) {
    const dir = sphereDir(rnd(), rnd(), new THREE.Vector3());
    debris.push({
      dir,
      spd: 1.1 + 2.9 * rnd(),
      life: 1.0 + 3.5 * rnd(),
      drag: 1.0 + 1.8 * rnd(),
      width: 0.01 + 0.012 * rnd(),
      hot: 0.5 + 0.5 * rnd(),
    });
  }
  const shells: ShellDef[] = [];
  for (let i = 0; i < SHELLS; i++) {
    shells.push({
      off: sphereDir(rnd(), rnd(), new THREE.Vector3()).multiplyScalar(0.06 + 0.1 * rnd()),
      spd: 0.75 + 0.3 * rnd(),
      op: 0.1 + 0.06 * rnd(),
      delay: 0.04 * rnd(),
      rot: rnd() * Math.PI * 2,
      spin: (rnd() - 0.5) * 0.3,
      shade: 0.9 + 0.15 * rnd(),
    });
  }
  return { puffs, shells, debris };
}

export function createExplosion(): Explosion {
  const scope = new SharedScope();
  const atlas = scope.get(PUFF_ATLAS_KEY, makePuffAtlas);
  const object = new THREE.Group();
  object.name = 'explosion';
  // Fireball, smoke, flash, debris sparks and smoke trails share one depth-sorted batch (one draw call).
  const batch = new Billboards(CAPACITY, atlas);
  batch.mesh.name = 'explosion-particles';
  batch.insideFade = 0.25;
  object.add(batch.mesh);

  const defs = buildDefs();
  const rec = newRecord();
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  const q = new THREE.Vector3();
  const qv = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pv = new THREE.Vector3();
  const shadow = new THREE.Vector4();
  const U = new THREE.Vector3(0, 1, 0); // local vertical in object space
  const bd = new THREE.Vector3();
  const qInv = new THREE.Quaternion();
  let scale = 50;
  let air = 1;
  let armed = false;

  /** Debris position/velocity at time t (object space, relative to the burst centre). */
  const debrisAt = (d: DebrisDef, t: number, w: number, outP: THREE.Vector3, outV: THREE.Vector3) => {
    const ts = Math.min(Math.max(Math.sqrt(scale / 50), 0.5), 2.5);
    const spd = (d.spd * scale) / Math.sqrt(ts);
    // Air: linear drag with time constant td, plus gravity (exact solution of v' = -v/td - g).
    const td = d.drag * ts;
    const e = Math.exp(-t / td);
    pa.copy(d.dir).multiplyScalar(spd * td * (1 - e)).addScaledVector(U, -G * td * (t - td * (1 - e)));
    const fall = G * td * (1 - e);
    const vax = d.dir.x * spd * e - U.x * fall;
    const vay = d.dir.y * spd * e - U.y * fall;
    const vaz = d.dir.z * spd * e - U.z * fall;
    // Vacuum: ballistic straight lines relative to the breakup point (gravity acts on everything alike).
    pv.copy(d.dir).multiplyScalar(spd * 1.4 * t);
    outP.copy(pv).lerp(pa, w);
    outV.set(mix(d.dir.x * spd * 1.4, vax, w), mix(d.dir.y * spd * 1.4, vay, w), mix(d.dir.z * spd * 1.4, vaz, w));
  };

  const hide = () => {
    batch.begin();
    batch.finish();
  };

  const setAge = (age: number) => {
    if (!armed || !(age >= 0) || age > 240) {
      hide();
      return;
    }
    const w = Math.pow(Math.min(Math.max(air, 0), 1), 0.3); // 1 = sea level, 0 = vacuum
    // Local vertical from the scene's sky light (as of the last render), in object space; without a
    // sky light, the object's own +Y (the stage should orient the explosion with +Y = local up).
    if (batch.lights.hasSky) {
      object.updateWorldMatrix(true, false);
      object.getWorldQuaternion(qInv).invert();
      U.copy(batch.lights.up).applyQuaternion(qInv).normalize();
    } else {
      U.set(0, 1, 0);
    }
    const ts = Math.min(Math.max(Math.sqrt(scale / 50), 0.5), 2.5); // bigger fireballs evolve slower
    const S = scale;
    batch.begin();

    // --- Flash: a brief white-hot glow, brighter and shorter in vacuum.
    {
      const tau = age;
      const life = mix(0.035, 0.07, w) * Math.sqrt(ts);
      const k = Math.exp(-tau / life) * smooth(0, 0.012, tau);
      if (k > 0.01) {
        rec.x = 0;
        rec.y = 0;
        rec.z = 0;
        rec.size = S * (0.5 + 0.9 * (1 - Math.exp(-tau / 0.04))) * mix(1.6, 1.0, w);
        rec.r = rec.g = rec.b = 0;
        rec.opacity = 0;
        const e = k * mix(0.55, 0.32, w);
        rec.er = e;
        rec.eg = e;
        rec.eb = e;
        rec.temp = 1.15;
        rec.m0 = 0;
        rec.m1 = 4;
        rec.m2 = 0;
        rec.m3 = 0;
        rec.mode = MODE_PUFF;
        batch.add(rec);
      }
    }

    // --- Vacuum halo: a large, faint, freely expanding sphere of vapour that dilutes quickly.
    if (w < 0.98) {
      const tau = age;
      const op = (1 - w) * 0.12 * Math.exp(-tau / 0.9) * smooth(0, 0.08, tau);
      if (op > 0.003) {
        rec.x = 0;
        rec.y = 0;
        rec.z = 0;
        rec.size = S * (0.8 + 5.5 * tau);
        rec.r = rec.g = rec.b = 0.8;
        rec.opacity = op;
        rec.er = rec.eg = rec.eb = 0;
        rec.temp = 0;
        rec.m0 = 0;
        rec.m1 = 4;
        rec.m2 = 0;
        rec.m3 = 0;
        rec.mode = MODE_PUFF;
        batch.add(rec);
      }

      // --- Vacuum shells: the vapour expands freely into thin, overlapping, slightly off-centre shells that
      // glow for an instant, then show only in sunlight, brightest along their rims, thinning as 1/R².
      for (const d of defs.shells) {
        const tau = age - d.delay;
        if (tau < 0) continue;
        const op = (1 - w) * d.op * smooth(0, 0.05, tau) * (1 / (1 + (tau / 0.8) * (tau / 0.8))) * (1 - smooth(1.6, 3.2, tau));
        if (op < 0.003) continue;
        const radius = S * (0.1 + 2.0 * d.spd * tau);
        rec.x = d.off.x * radius;
        rec.y = d.off.y * radius;
        rec.z = d.off.z * radius;
        // The profile's outer edge sits at 0.9 of the sprite's half-size.
        rec.size = (2 * radius) / 0.9;
        rec.r = rec.g = rec.b = 0.75 * d.shade;
        rec.opacity = op;
        rec.er = rec.eg = rec.eb = 1;
        rec.temp = 1.1 * Math.exp(-tau / 0.08);
        rec.m0 = d.rot + d.spin * tau;
        rec.m1 = SHELL_CELL;
        // Breaks up into wisps as it thins.
        rec.m2 = 0.1 + 0.4 * smooth(0.2, 2.5, tau);
        rec.m3 = 0;
        rec.mode = MODE_PUFF;
        batch.add(rec);
      }
    }

    // --- Fireball / smoke / vapour puffs.
    for (let i = 0; i < defs.puffs.length; i++) {
      const d = defs.puffs[i];
      // Late puffs are secondary burning, which needs air: in vacuum everything leaves at once.
      const tau = age - d.delay * mix(0.15, 1, w);
      if (tau < 0) continue;
      // Air model.
      const kA = 1 - Math.exp(-tau / (0.45 * ts));
      const riseT = Math.max(tau - 0.35 * ts, 0);
      const rise = S * 0.22 * d.rise * (Math.sqrt(1 + (riseT * riseT) / (4 * ts * ts)) - 1) * 2 * ts;
      // In air the burst is biased upwards a little (hot gas), then rises buoyantly.
      bd.copy(d.dir).addScaledVector(U, 0.14).normalize();
      const ax = bd.x * 0.9 * S * d.spd * kA + U.x * rise;
      const ay = bd.y * 0.9 * S * d.spd * kA + U.y * rise;
      const az = bd.z * 0.9 * S * d.spd * kA + U.z * rise;
      const sizeA = S * 1.3 * (d.s0 + 0.6 * (1 - Math.exp(-tau / (0.6 * ts))) + (0.05 * tau) / ts);
      const tempA = 1.12 * Math.exp(-tau / (d.cool * (d.soot ? 1.25 : 0.55) * ts));
      const opA = smooth(0, 0.05, tau) * (1 - smooth(28 * ts, 75 * ts, tau)) * 0.62;
      const erA = 0.06 + 0.55 * smooth(3 * ts, 60 * ts, tau);
      // Vacuum model: clumps of vapour and fine debris riding the shells outwards (no drag, no buoyancy):
      // small, faint and soft (nothing condenses into billowing puffs in vacuum); they dilute away within
      // about two seconds and glow only at first.
      const td = 6;
      const kV = td * (1 - Math.exp(-tau / td));
      const shell = 0.55 + 0.45 * Math.sqrt(d.spd);
      const reach = S * (0.12 + shell * 2.0 * kV);
      const vx = d.dir.x * reach;
      const vy = d.dir.y * reach;
      const vz = d.dir.z * reach;
      // In thin air (between the models) the clumps grow with the cloud, enough to overlap, so it stays one
      // continuous cloud rather than a cluster of separate balls.
      const sizeV = S * (0.6 * d.s0 + 0.02 * tau) + reach * (0.16 + 0.6 * smooth(0, 0.5, w));
      const tempV = 1.15 * Math.exp(-tau / (0.12 * d.cool));
      const opV = smooth(0, 0.04, tau) * (0.1 / (1 + (tau / 0.7) * (tau / 0.7))) * (1 - smooth(1.2, 2.6, tau));
      const erV = 0.25 + 0.5 * smooth(0.1, 2, tau);

      const op = mix(opV, opA, w);
      // Burning needs air: below about a tenth of sea-level density the burst cools as fast as in vacuum (a slow,
      // dull-red fireball there would only tint its sunlit vapour pink).
      const temp = mix(tempV, tempA, smooth(0.35, 0.9, w));
      if (op < 0.004 && temp < 0.08) continue;
      rec.x = mix(vx, ax, w);
      rec.y = mix(vy, ay, w);
      rec.z = mix(vz, az, w);
      rec.size = mix(sizeV, sizeA, w);
      // Soot is brown-black, propellant vapour and ice are white; vacuum clouds are all vapour. Burning gas scatters
      // little sunlight (its own glow is what shows): the white of steam and the brown of smoke come as it cools.
      const sootK = d.soot ? w : 0;
      const base = d.shade * (1 - 0.85 * smooth(0.4, 0.9, temp));
      rec.r = mix(0.78 * base, 0.1 * base, sootK);
      rec.g = mix(0.78 * base, 0.083 * base, sootK);
      rec.b = mix(0.8 * base, 0.068 * base, sootK);
      // A fireball this size is optically thick: only its outer layer shows. Each puff's glow is tone mapped on its
      // own and the glow of the ones behind adds up through it, so a young fireball of see-through, full-strength
      // puffs saturated into a flat white blob. Opaque while hot, and with the white-hot glow held back (as a camera
      // stopped down for it would), it shows a hot core with yellow and orange round it; it thins to the smoke's
      // opacity as it cools.
      rec.opacity = Math.min(1, op * (1 + 0.4 * smooth(0.3, 0.8, temp)));
      rec.er = rec.eg = rec.eb = 0.55 * (1 - 0.55 * smooth(0.55, 1.0, temp));
      rec.temp = temp;
      rec.m0 = d.rot + d.spin * tau;
      rec.m1 = d.cell;
      rec.m2 = mix(erV, erA, w);
      rec.m3 = 0;
      rec.mode = MODE_PUFF;
      batch.add(rec);
    }

    // --- Debris streaks and their smoke trails.
    const trailW = smooth(0.02, 0.35, air);
    for (let i = 0; i < defs.debris.length; i++) {
      const d = defs.debris[i];
      const life = d.life * mix(0.7, 1, w) * Math.sqrt(ts);
      const glow = Math.exp(-age / life) * smooth(0, 0.03, age);
      if (glow > 0.01) {
        debrisAt(d, age, w, p, v);
        const speed = v.length();
        rec.x = p.x;
        rec.y = p.y;
        rec.z = p.z;
        rec.size = S * d.width * 1.8;
        rec.r = rec.g = rec.b = 0;
        rec.opacity = 0;
        const e = 6 * d.hot * glow;
        rec.er = e;
        rec.eg = e * 0.4;
        rec.eb = e * 0.12;
        rec.temp = 1;
        if (speed > 1e-4) {
          rec.m0 = v.x / speed;
          rec.m1 = v.y / speed;
          rec.m2 = v.z / speed;
        } else {
          rec.m0 = 0;
          rec.m1 = 1;
          rec.m2 = 0;
        }
        rec.m3 = Math.min(Math.max(speed * 0.08, S * 0.02), S * 0.6);
        rec.mode = MODE_STREAK;
        rec.taper = 1;
        rec.seed = i;
        batch.add(rec);
      }
      if (i < TRAILS && trailW > 0.001) {
        // Smoke trail: a polyline through the debris path, sampled densely early on when it is fast.
        // Each segment widens and thins with its own age, so the trail is persistent and deterministic.
        let prevT = 0;
        debrisAt(d, 0, w, q, qv);
        for (let k = 1; k <= TRAIL_SEGS; k++) {
          let tk = 3.6 * ts * Math.pow(k / TRAIL_SEGS, 1.7);
          const head = tk >= age;
          if (head) tk = age;
          if (tk - prevT < 1e-3) break;
          debrisAt(d, tk, w, p, v);
          const segAge = age - prevT;
          const burn = Math.exp(-prevT / (life * 1.6));
          // Trails only show once the debris is clear of the fireball (they would be buried in it).
          const clear = smooth(0.45 * S, 0.95 * S, q.length());
          const op = trailW * 0.62 * burn * clear * smooth(0, 0.7, segAge) * (1 - smooth(5 * ts, 30 * ts, segAge));
          if (op > 0.004) {
            const dx = p.x - q.x;
            const dy = p.y - q.y;
            const dz = p.z - q.z;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len > 1e-3) {
              const rise = S * 0.012 * segAge;
              rec.x = p.x + U.x * rise;
              rec.y = p.y + U.y * rise;
              rec.z = p.z + U.z * rise;
              rec.size = S * (0.008 + 0.08 * Math.sqrt(segAge / ts) + 0.004 * segAge);
              const shade = 0.15 + 0.1 * (i % 3);
              rec.r = shade;
              rec.g = shade * 0.94;
              rec.b = shade * 0.88;
              rec.opacity = op;
              rec.er = rec.eg = rec.eb = 0;
              rec.temp = 0;
              rec.m0 = dx / len;
              rec.m1 = dy / len;
              rec.m2 = dz / len;
              rec.m3 = len;
              rec.mode = MODE_STREAK;
              rec.taper = 0;
              rec.seed = i * 7.3;
              batch.add(rec);
            }
          }
          q.copy(p);
          prevT = tk;
          if (head) break;
        }
      }
    }

    // Self-shadowing of the cloud as a whole.
    batch.uniforms.uShadow.value.copy(batch.bulk(shadow, 0.1));
    batch.finish();
  };

  return {
    object,
    trigger(s: number, airDensityRatio: number) {
      scale = Math.max(s, 0.5);
      air = Math.min(Math.max(airDensityRatio, 0), 1);
      armed = true;
    },
    setAge,
    dispose() {
      object.remove(batch.mesh);
      batch.dispose();
      scope.releaseAll();
    },
  };
}
