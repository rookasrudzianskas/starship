import type { FlightResult, VehicleId } from '@/lib/sim/types';
import type { FollowMode } from '@/lib/store/replay';
// Relative so the director can be unit tested (vitest has no @/ alias).
import { Phase } from '../../sim/types';
import { firstPhaseTime } from './sample';

export type ShotId = 'pad' | 'tracking' | 'booster-top' | 'booster-aft' | 'ship-aft' | 'ship-nose' | 'buoy' | 'tower';

export interface Shot {
  readonly id: ShotId;
  readonly vehicle: VehicleId;
}

const SHOT_IDS: readonly ShotId[] = ['pad', 'tracking', 'booster-top', 'booster-aft', 'ship-aft', 'ship-nose', 'buoy', 'tower'];

function shotTable(vehicle: VehicleId): Record<ShotId, Shot> {
  const table = {} as Record<ShotId, Shot>;
  for (const id of SHOT_IDS) table[id] = Object.freeze({ id, vehicle });
  return table;
}

/** One shared Shot per camera and vehicle: the director runs every frame and allocates nothing. */
const SHOTS: Record<VehicleId, Record<ShotId, Shot>> = { booster: shotTable('booster'), ship: shotTable('ship') };

function shot(id: ShotId, vehicle: VehicleId): Shot {
  return SHOTS[vehicle][id];
}

/**
 * The long-range tracker hands over from the ground telescope near the pad (which by then sees the climbing stack
 * end on, through its exhaust) to a chase aircraft alongside. The director's first cut to the booster's engine
 * camera (T+57 to T+68) hides the change.
 */
export const AERIAL_TRACKING_FROM = 62;

/** Times the director plans around, derived once per result. */
export interface DirectorPlan {
  sep: number | null;
  boostbackEnd: number;
  boosterLanding: number;
  boosterEnd: number;
  boosterCatch: boolean;
  shipSeco: number;
  /** Infinity for a ship that never comes back into the atmosphere. */
  shipEntry: number;
  shipLanding: number;
  shipEnd: number;
  shipLands: boolean;
  boosterLands: boolean;
}

export function planDirector(r: FlightResult): DirectorPlan {
  const ev = (key: string) => r.events.find((e) => e.key === key)?.t;
  const sep = r.separationT;
  const boosterLanding = firstPhaseTime(r.booster, Phase.LandingBurn, sep ?? 0) ?? r.booster.end - 20;
  const shipLanding = firstPhaseTime(r.ship, Phase.ShipFlip, sep ?? 0) ?? firstPhaseTime(r.ship, Phase.LandingBurn, (sep ?? 0) + 60) ?? r.ship.end - 25;
  return {
    sep,
    boostbackEnd: ev('boostback-end') ?? (sep !== null ? sep + 50 : 0),
    boosterLanding,
    boosterEnd: r.booster.end,
    boosterCatch: r.booster.endKind === 'catch',
    shipSeco: ev('seco') ?? (sep !== null ? sep + 360 : r.ship.end),
    shipEntry: ev('entry') ?? firstPhaseTime(r.ship, Phase.Entry, sep ?? 0) ?? Infinity,
    shipLanding,
    shipEnd: r.ship.end,
    shipLands: r.ship.endKind === 'splashdown',
    boosterLands: r.booster.endKind === 'splashdown' || r.booster.endKind === 'catch',
  };
}

/** The booster's landing (or its last moments, if it doesn't land) is shown from this long before its landing burn. */
const LANDING_LEAD = 12;

/** The booster's landing window: from just before its landing burn until shortly after it is down. */
function boosterLanding(t: number, p: DirectorPlan): boolean {
  return t >= p.boosterLanding - LANDING_LEAD && t <= p.boosterEnd + 12;
}

function boosterShot(t: number, p: DirectorPlan): Shot {
  if (p.boosterLands && t >= p.boosterLanding - LANDING_LEAD) return shot(p.boosterCatch ? 'tower' : 'buoy', 'booster');
  if (p.sep !== null && t < p.sep + 9) return shot('booster-top', 'booster');
  return shot('booster-aft', 'booster');
}

function shipShot(t: number, p: DirectorPlan): Shot {
  if (p.shipLands && t >= p.shipLanding - 25) return shot('buoy', 'ship');
  if (t >= p.shipEntry - 30) return shot('ship-nose', 'ship');
  return shot('ship-aft', 'ship');
}

/**
 * The broadcast director: which camera is live at time t. Pure function of t, so scrubbing is stable.
 * Ascent alternates between the long-range tracker and the booster's engine camera; staging is seen from
 * the booster looking up; afterwards it follows whichever vehicle has something happening.
 */
export function autoShot(t: number, p: DirectorPlan, follow: FollowMode): Shot {
  if (t < 11) return shot('pad', 'booster');
  if (p.sep === null || t < p.sep - 7) {
    const cycle = (t - 11) % 64;
    if (t > 40 && cycle > 46 && cycle < 57 && (p.sep === null || t < p.sep - 20)) return shot('booster-aft', 'booster');
    return shot('tracking', 'booster');
  }
  if (t < p.sep + 9) return shot('booster-top', 'booster');

  const boosterAlive = t <= p.boosterEnd + 20;
  const shipAlive = t <= p.shipEnd + 20;
  if (follow === 'booster') return boosterAlive || !shipAlive ? boosterShot(t, p) : shipShot(t, p);
  if (follow === 'ship') return shipAlive || !boosterAlive ? shipShot(t, p) : boosterShot(t, p);

  // Both: the booster during its flip and boostback, and through its landing (the ship carries on in the small
  // frame, as on the broadcast); the ship otherwise.
  if (boosterAlive && (t < p.boostbackEnd + 6 || boosterLanding(t, p))) return boosterShot(t, p);
  if (shipAlive) return shipShot(t, p);
  return boosterShot(t, p);
}

/** A shot the viewer picked; mapped onto the vehicle it belongs to, falling back when it no longer applies. */
export function pickedShot(id: ShotId, t: number, p: DirectorPlan, follow: FollowMode): Shot {
  switch (id) {
    case 'pad':
    case 'tracking':
      return shot(id, follow === 'ship' ? 'ship' : 'booster');
    case 'booster-top':
    case 'booster-aft':
      return t <= p.boosterEnd + 20 ? shot(id, 'booster') : autoShot(t, p, follow);
    case 'ship-aft':
    case 'ship-nose':
      return t <= p.shipEnd + 20 ? shot(id, 'ship') : autoShot(t, p, follow);
    case 'tower':
      // The tower watches the booster come home.
      return shot(id, 'booster');
    case 'buoy':
      // Following both, it watches whichever comes down next: the ship's buoy, half a world away, would show an
      // empty sea for hours while the booster climbs and lands.
      return shot(id, follow === 'booster' || (follow === 'both' && p.boosterLands && t <= p.boosterEnd + 20) ? 'booster' : 'ship');
  }
}
