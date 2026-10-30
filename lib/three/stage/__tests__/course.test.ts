import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Track } from '../../../sim/types';
import { computeCourse, courseAt } from '../course';
import { enuAt, latLonToEcef, offsetEnu, type V3 } from '../geo';

const pad = latLonToEcef(26, -97, 3);
const east = new THREE.Vector3();
const north = new THREE.Vector3();
const up = new THREE.Vector3();
enuAt(pad, east, north, up);

/**
 * A booster-like flight sampled every 0.1 s: 20 s straight up, a turn eastwards (with a little northward drift)
 * to 1.5 km/s, then a boostback that takes the horizontal speed down through zero to 300 m/s westwards.
 */
function flight(): Track {
  const dt = 0.1;
  const n = 3001;
  const t = new Float64Array(n);
  const pos = new Float64Array(n * 3);
  const vel = new Float64Array(n * 3);
  let e = 0;
  let nn = 0;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const time = i * dt;
    // Eastward speed: none, then up to 1500 m/s by t = 150, then down to -300 m/s by t = 250 (boostback).
    const ve = time < 20 ? 0 : time < 150 ? 1500 * ((time - 20) / 130) : 1500 - 1800 * Math.min(1, (time - 150) / 100);
    const vn = time < 20 ? 0 : 15;
    const vu = 300;
    e += ve * dt;
    nn += vn * dt;
    u += vu * dt;
    t[i] = time;
    const p = offsetEnu(pad, e, nn, u, [0, 0, 0]);
    const loc = new THREE.Vector3();
    const le = new THREE.Vector3();
    const ln = new THREE.Vector3();
    enuAt(p, le, ln, loc);
    pos.set(p, i * 3);
    vel.set([le.x * ve + ln.x * vn + loc.x * vu, le.y * ve + ln.y * vn + loc.y * vu, le.z * ve + ln.z * vn + loc.z * vu], i * 3);
  }
  return { n, t, pos, vel, start: 0, end: t[n - 1] } as unknown as Track;
}

function at(track: Track, course: Float32Array, time: number): { dir: THREE.Vector3; local: THREE.Vector3 } {
  const i = Math.round(time / 0.1);
  const p: V3 = [track.pos[i * 3], track.pos[i * 3 + 1], track.pos[i * 3 + 2]];
  const out: V3 = [0, 0, 0];
  courseAt(track, course, time, p, out);
  const le = new THREE.Vector3();
  const ln = new THREE.Vector3();
  const lu = new THREE.Vector3();
  enuAt(p, le, ln, lu);
  const dir = new THREE.Vector3(...out);
  return { dir, local: new THREE.Vector3(dir.dot(le), dir.dot(ln), dir.dot(lu)) };
}

describe('course', () => {
  const track = flight();
  const course = computeCourse(track);

  it('points where the vehicle will go before it gets going', () => {
    const { local } = at(track, course, 5);
    expect(local.x).toBeGreaterThan(0.99);
  });

  it('follows the horizontal velocity in flight', () => {
    const { local } = at(track, course, 120);
    const expected = new THREE.Vector3(1500 * (100 / 130), 15, 0).normalize();
    expect(local.angleTo(expected)).toBeLessThan(0.01);
  });

  it('keeps pointing the same way when the vehicle turns back', () => {
    for (const time of [230, 240, 260, 299]) expect(at(track, course, time).local.x).toBeGreaterThan(0.98);
  });

  it('is a horizontal unit vector that never jumps', () => {
    let prev: THREE.Vector3 | null = null;
    for (let time = 0; time <= 300; time += 0.5) {
      const { dir, local } = at(track, course, time);
      expect(dir.length()).toBeCloseTo(1, 5);
      expect(Math.abs(local.z)).toBeLessThan(1e-5);
      if (prev) expect(dir.angleTo(prev)).toBeLessThan(0.05);
      prev = dir;
    }
  });
});
