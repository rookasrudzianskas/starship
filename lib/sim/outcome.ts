import type { SimContext } from './context';
import type { EndKind, VehicleId } from './types';

/**
 * End kind for an in-flight loss. As flown, the catalog's wording wins (Flight 1's breakup followed a
 * commanded termination; Flight 2's ship was "lost" when its FTS fired).
 */
export function lossKind(ctx: SimContext, vehicle: VehicleId, cause: 'breakup' | 'fts'): EndKind {
  const catalog = vehicle === 'booster' ? ctx.flight.boosterEnd : ctx.flight.shipEnd;
  if (cause === 'breakup') return ctx.asFlown && catalog === 'termination' ? 'termination' : 'lost';
  return ctx.asFlown && catalog === 'lost' ? 'lost' : 'termination';
}
