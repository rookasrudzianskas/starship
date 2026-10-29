import { Phase, type FlightResult, type VehicleId } from '@/lib/sim/types';
import type { FollowMode } from '@/lib/store/replay';
import { firstPhaseTime } from './sample';

export type ShotId = 'pad' | 'tracking' | 'booster-top' | 'booster-aft' | 'ship-aft' | 'ship-nose' | 'buoy' | 'tower';

export interface Shot {
  id: ShotId;
  vehicle: VehicleId;
}

/** Times the director plans around, derived once per result. */
export interface DirectorPlan {
  sep: number | null;
  boostbackEnd: number;
  boosterLanding: number;
  boosterEnd: number;
  boosterCatch: boolean;
  shipSeco: number;
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
    shipEntry: ev('entry') ?? r.ship.end - 1500,
    shipLanding,
    shipEnd: r.ship.end,
    shipLands: r.ship.endKind === 'splashdown',
    boosterLands: r.booster.endKind === 'splashdown' || r.booster.endKind === 'catch',
  };
}

function boosterShot(t: number, p: DirectorPlan): Shot {
  if (p.boosterLands && t >= p.boosterLanding - 12) return { id: p.boosterCatch ? 'tower' : 'buoy', vehicle: 'booster' };
  if (p.sep !== null && t < p.sep + 9) return { id: 'booster-top', vehicle: 'booster' };
  return { id: 'booster-aft', vehicle: 'booster' };
}

function shipShot(t: number, p: DirectorPlan): Shot {
  if (p.shipLands && t >= p.shipLanding - 25) return { id: 'buoy', vehicle: 'ship' };
  if (t >= p.shipEntry - 30) return { id: 'ship-nose', vehicle: 'ship' };
  return { id: 'ship-aft', vehicle: 'ship' };
}

/**
 * The broadcast director: which camera is live at time t. Pure function of t, so scrubbing is stable.
 * Ascent alternates between the long-range tracker and the booster's engine camera; staging is seen from
 * the booster looking up; afterwards it follows whichever vehicle has something happening.
 */
export function autoShot(t: number, p: DirectorPlan, follow: FollowMode): Shot {
  if (t < 11) return { id: 'pad', vehicle: 'booster' };
  if (p.sep === null || t < p.sep - 7) {
    const cycle = (t - 11) % 64;
    if (t > 40 && cycle > 46 && cycle < 57 && (p.sep === null || t < p.sep - 20)) return { id: 'booster-aft', vehicle: 'booster' };
    return { id: 'tracking', vehicle: 'booster' };
  }
  if (t < p.sep + 9) return { id: 'booster-top', vehicle: 'booster' };

  const boosterAlive = t <= p.boosterEnd + 20;
  const shipAlive = t <= p.shipEnd + 20;
  if (follow === 'booster') return boosterAlive || !shipAlive ? boosterShot(t, p) : shipShot(t, p);
  if (follow === 'ship') return shipAlive || !boosterAlive ? shipShot(t, p) : boosterShot(t, p);

  // Both: booster during its flip/boostback and its landing, ship otherwise.
  const boosterBusy = boosterAlive && (t < p.boostbackEnd + 6 || (t >= p.boosterLanding - 14 && t <= p.boosterEnd + 12));
  const shipBusy = shipAlive && t < p.shipSeco + 4;
  if (boosterBusy && !(shipBusy && t > p.boostbackEnd + 6)) return boosterShot(t, p);
  if (shipAlive) return shipShot(t, p);
  return boosterShot(t, p);
}

/** A shot the viewer picked; mapped onto the vehicle it belongs to, falling back when it no longer applies. */
export function pickedShot(id: ShotId, t: number, p: DirectorPlan, follow: FollowMode): Shot {
  switch (id) {
    case 'pad':
    case 'tracking':
      return { id, vehicle: follow === 'ship' ? 'ship' : 'booster' };
    case 'booster-top':
    case 'booster-aft':
      return t <= p.boosterEnd + 20 ? { id, vehicle: 'booster' } : autoShot(t, p, follow);
    case 'ship-aft':
    case 'ship-nose':
      return t <= p.shipEnd + 20 ? { id, vehicle: 'ship' } : autoShot(t, p, follow);
    case 'buoy':
    case 'tower':
      return { id, vehicle: follow === 'booster' ? 'booster' : 'ship' };
  }
}
