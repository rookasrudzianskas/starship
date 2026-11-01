import type { Generation } from './types';
import { DEG } from './vec';

/** Independent reconstructed dimensions shared by the rendered mesh and flap aerodynamics. */
export interface ShipFlapSpec {
  az: number;
  h0: number;
  h1: number;
  plan: { span: number; tipY0: number; tipY1: number; tRoot: number; tTip: number; curve: number };
}
export interface ShipGeometry { length: number; noseBase: number; fwd: ShipFlapSpec; aft: ShipFlapSpec }
const aft: ShipFlapSpec = {
  az: 90 * DEG, h0: 1.25, h1: 11.9,
  plan: { span: 4.15, tipY0: 0.35, tipY1: 7.4, tRoot: 0.46, tTip: 0.14, curve: 0.12 },
};
export const SHIP_GEOMETRY: Record<Generation, ShipGeometry> = {
  b1: { length: 50.3, noseBase: 33,
    fwd: { az: 90 * DEG, h0: 1.5, h1: 8.6, plan: { span: 3.35, tipY0: 1.1, tipY1: 4.1, tRoot: 0.38, tTip: 0.11, curve: 0.55 } }, aft },
  b2: { length: 52.1, noseBase: 34.8,
    fwd: { az: 116 * DEG, h0: 4.2, h1: 9.5, plan: { span: 2.7, tipY0: 0.8, tipY1: 3, tRoot: 0.33, tTip: 0.1, curve: 0.6 } }, aft: { ...aft, h1: 12.3 } },
  v3: { length: 52.1, noseBase: 34.8,
    fwd: { az: 120 * DEG, h0: 4.6, h1: 9.6, plan: { span: 2.55, tipY0: 0.8, tipY1: 3, tRoot: 0.33, tTip: 0.1, curve: 0.6 } }, aft: { ...aft, h1: 12.3 } },
};
export function shipNoseRadius(h: number, len: number): number {
  const t = Math.min(1, Math.max(0, h / len));
  return 4.5 * Math.pow(Math.max(0, 1 - Math.pow(t, 1.38)), 1 / 1.62);
}

/** Curved flap outline in hinge coordinates, matching the mesh's leading edge. */
export function flapLeadingEdge(root: number, plan: ShipFlapSpec['plan'], fraction: number): number {
  return root + (plan.tipY1 - root) * fraction - Math.sin(fraction * Math.PI) * (plan.tipY1 - root) * 0.35 * plan.curve;
}
