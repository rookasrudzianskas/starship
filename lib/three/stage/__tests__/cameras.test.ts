import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS } from '../../../sim/types';
import { blendAround, ChaseCamera, createPose, FreeCamera, GlobeCamera, MIN_CAMERA_ALTITUDE, type CameraPose, type Focus } from '../cameras';
import { enuAt, latLonToEcef, offsetEnu, type V3 } from '../geo';

/** Where a world point lands on screen (NDC: +x right, +y up) for a pose. */
function screen(p: V3, pose: CameraPose): { x: number; y: number } {
  const cam = new THREE.PerspectiveCamera(pose.fov, 1, 0.3, 4e8);
  cam.quaternion.copy(pose.quat);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const v = new THREE.Vector3(p[0] - pose.pos[0], p[1] - pose.pos[1], p[2] - pose.pos[2]).project(cam);
  return { x: v.x, y: v.y };
}

const pad = latLonToEcef(25.997, -97.157, 3);
const east = new THREE.Vector3();
const north = new THREE.Vector3();
const up = new THREE.Vector3();
enuAt(pad, east, north, up);

/** A focus `alt` m above the pad heading east. */
function focusAt(alt: number, size = 72): Focus {
  return { pos: offsetEnu(pad, 0, 0, alt, [0, 0, 0]), course: [east.x, east.y, east.z], size };
}

/** A point a third of the way from what the camera looks at towards the camera: it moves the way the scene turns. */
function nearPoint(f: Focus, pose: CameraPose): V3 {
  return [f.pos[0] + (pose.pos[0] - f.pos[0]) / 3, f.pos[1] + (pose.pos[1] - f.pos[1]) / 3, f.pos[2] + (pose.pos[2] - f.pos[2]) / 3];
}

function altitude(p: V3): number {
  return Math.hypot(p[0], p[1], p[2]) - EARTH_RADIUS;
}

describe('pointer input turns every camera with the pointer', () => {
  it('free camera: the near side of the scene follows a drag, both ways', () => {
    const f = focusAt(500);
    for (const az of [215, 0, 90]) {
      const cam = new FreeCamera();
      cam.azimuth = az;
      const p0 = cam.pose(f, createPose());
      const near = nearPoint(f, p0);
      const s0 = screen(near, p0);
      cam.drag({ dx: 30, dy: 0, button: 0 }, 72);
      expect(screen(near, cam.pose(f, createPose())).x).toBeGreaterThan(s0.x);
      const down = new FreeCamera();
      down.azimuth = az;
      down.drag({ dx: 0, dy: 30, button: 0 }, 72);
      expect(screen(near, down.pose(f, createPose())).y).toBeLessThan(s0.y);
    }
  });

  it('free camera: a right-drag pans the scene with the pointer, both ways', () => {
    const f = focusAt(500);
    for (const az of [215, 0, 90]) {
      const cam = new FreeCamera();
      cam.azimuth = az;
      const s0 = screen(f.pos, cam.pose(f, createPose()));
      cam.drag({ dx: 40, dy: 0, button: 2 }, 72);
      const s1 = screen(f.pos, cam.pose(f, createPose()));
      expect(s1.x).toBeGreaterThan(s0.x + 0.02);
      expect(Math.abs(s1.y - s0.y)).toBeLessThan(0.01);
      const down = new FreeCamera();
      down.azimuth = az;
      down.drag({ dx: 0, dy: 40, button: 2 }, 72);
      expect(screen(f.pos, down.pose(f, createPose())).y).toBeLessThan(s0.y - 0.02);
    }
  });

  it('chase camera: the near side of the scene follows a drag, both ways', () => {
    const f = focusAt(20_000);
    const cam = new ChaseCamera();
    const p0 = cam.pose(f, createPose());
    const near = nearPoint(f, p0);
    const s0 = screen(near, p0);
    cam.drag({ dx: 30, dy: 0, button: 0 });
    expect(screen(near, cam.pose(f, createPose())).x).toBeGreaterThan(s0.x);
    const down = new ChaseCamera();
    down.drag({ dx: 0, dy: 30, button: 0 });
    expect(screen(near, down.pose(f, createPose())).y).toBeLessThan(s0.y);
  });

  it('globe: the ground under the middle of the view follows a drag', () => {
    const globe = new GlobeCamera();
    globe.centreOn(pad);
    const p0 = globe.pose(createPose());
    const s0 = screen(pad, p0);
    globe.drag({ dx: 30, dy: 30, button: 0 });
    const s1 = screen(pad, globe.pose(createPose()));
    expect(s1.x).toBeGreaterThan(s0.x);
    expect(s1.y).toBeLessThan(s0.y);
  });
});

describe('ChaseCamera', () => {
  it('looks at the vehicle side on from its right, a little behind, never up its exhaust', () => {
    const f = focusAt(20_000);
    const pose = new ChaseCamera().pose(f, createPose());
    const off = new THREE.Vector3(pose.pos[0] - f.pos[0], pose.pos[1] - f.pos[1], pose.pos[2] - f.pos[2]).normalize();
    const course = new THREE.Vector3(...f.course);
    const right = new THREE.Vector3().crossVectors(course, up);
    // 70 degrees round from straight behind, on the right-hand side.
    expect((off.angleTo(course.clone().negate()) * 180) / Math.PI).toBeCloseTo(70, 0);
    expect(off.dot(right)).toBeGreaterThan(0.9);
  });

  it('stays above the ground, whatever the viewer asks for', () => {
    for (const alt of [60, 20, 0]) {
      const cam = new ChaseCamera();
      cam.elevation = -60;
      const pose = cam.pose(focusAt(alt, 124), createPose());
      expect(altitude(pose.pos)).toBeGreaterThanOrEqual(MIN_CAMERA_ALTITUDE - 0.5);
    }
  });

  it('is a pure function of the focus: the same pose every time, with no settling', () => {
    const cam = new ChaseCamera();
    const f = focusAt(1000);
    const a = cam.pose(f, createPose());
    const b = cam.pose(f, createPose());
    expect(b.pos).toEqual(a.pos);
    expect(b.quat.equals(a.quat)).toBe(true);
  });
});

describe('FreeCamera.takeOver', () => {
  it('continues a view from the same direction, at the same size on screen', () => {
    const f = focusAt(2000, 124);
    // A long lens 9 km away, as the ground tracker has.
    const view = createPose();
    view.pos = offsetEnu(f.pos, 4000, -8000, -1500, [0, 0, 0]);
    view.fov = 3;
    const dirView = new THREE.Vector3(f.pos[0] - view.pos[0], f.pos[1] - view.pos[1], f.pos[2] - view.pos[2]);
    const free = new FreeCamera();
    free.takeOver(view, f);
    const pose = free.pose(f, createPose());
    const dirFree = new THREE.Vector3(f.pos[0] - pose.pos[0], f.pos[1] - pose.pos[1], f.pos[2] - pose.pos[2]);
    expect((dirView.angleTo(dirFree) * 180) / Math.PI).toBeLessThan(0.1);
    const size = (fov: number, d: number) => 124 / (2 * d * Math.tan((fov * Math.PI) / 360));
    expect(size(pose.fov, dirFree.length())).toBeCloseTo(size(view.fov, dirView.length()), 3);
  });
});

describe('blendAround', () => {
  it('swings round the Earth between views on opposite sides of it, never through it', () => {
    const a = createPose();
    a.pos = latLonToEcef(26, -97, 300);
    const b = createPose();
    b.pos = latLonToEcef(-30, 90, EARTH_RADIUS * 1.7);
    const out = createPose();
    for (let f = 0; f <= 1.0001; f += 0.02) {
      blendAround(a, b, Math.min(1, f), out);
      expect(altitude(out.pos)).toBeGreaterThan(250);
    }
    const gap = (p: V3, q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    expect(gap(blendAround(a, b, 0, out).pos, a.pos)).toBeLessThan(0.01);
    expect(gap(blendAround(a, b, 1, out).pos, b.pos)).toBeLessThan(1);
  });
});
