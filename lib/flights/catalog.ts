import type { BoosterRecovery, EndKind, Generation, PadId, ShipMission } from '@/lib/sim/types';

/**
 * Every Starship integrated flight test, as public facts.
 *
 * `targets` are the milestones observed on each flight (seconds from liftoff, km, km/h). The simulator is
 * calibrated against them (scripts/calibrate.ts) so a nominal run reproduces the real flight closely.
 * `plan` is what the flight set out to do; `anomalies` is what actually went wrong. A run with
 * `Scenario.asFlown === false` flies the plan without the anomalies.
 */

export interface FlightTargets {
  maxQ?: number;
  meco?: number;
  staging?: number;
  boostbackStart?: number;
  boostbackEnd?: number;
  boosterApogee?: number;
  boosterLandingBurn?: number;
  /** Last moment the booster flew (loss, catch or splashdown). */
  boosterEnd: number;
  seco?: number;
  shipApogee?: number;
  payloadStart?: number;
  payloadEnd?: number;
  relight?: number;
  orbitInsertion?: number;
  deorbit?: number;
  entry?: number;
  shipLandingBurn?: number;
  /** Last moment the ship flew (loss or splashdown). */
  shipEnd: number;
  boosterTopSpeedKmh: number;
  boosterApogeeKm: number;
  shipTopSpeedKmh: number;
  shipApogeeKm: number;
}

export type AnomalyKind =
  | 'engine-out' // `engines` (or `count` engines picked by the sim) shut down at t
  | 'no-ignition' // engines that never light at liftoff
  | 'no-separation' // the stack never separates
  | 'tumble' // loss of attitude control: the vehicle starts to tumble
  | 'roll' // slow uncontrolled roll in coast (no relight, uncontrolled entry)
  | 'boostback-cut' // boostback shuts down early at t
  | 'landing-burn-fail' // engines fail at landing-burn ignition: vehicle lost
  | 'breakup' // vehicle breaks up at t
  | 'fts' // flight termination system at t
  | 'catch-abort' // catch called off at t: divert to a Gulf splashdown
  | 'payload-door-fail' // payload door does not open: no deploy
  | 'relight-skip'; // planned in-space relight not attempted

export interface Anomaly {
  t: number;
  vehicle: 'booster' | 'ship' | 'stack';
  kind: AnomalyKind;
  /** Engine indices (see lib/sim/engines.ts layouts). */
  engines?: number[];
  /** Or a number of engines for the sim to pick (outer ring first for the booster, RVac first for the ship). */
  count?: number;
  note: string;
}

export interface BoosterPlan {
  recovery: BoosterRecovery;
  /** Engines lit for the boostback burn (13 = centre + inner ring). */
  boostbackEngines: number;
  /** Landing burn engine counts in order, e.g. [13, 3] or [11, 5, 3]. */
  landingEngines: number[];
}

export interface ShipPlan {
  mission: ShipMission;
  payloadKind: 'none' | 'starlink-sim' | 'starlink-v3';
  payloadCount: number;
  /** In-space relight test: start time and duration (s). */
  relight?: { t: number; duration: number };
  /** Orbit insertion burn (orbital flights). */
  insertion?: { t: number };
  /** Deorbit burn (orbital flights). */
  deorbit?: { t: number };
  /** Splashdown zone, used for the entry target. */
  landing: { name: string; lat: number; lon: number };
  /** Sea-level engines for the landing burn. */
  landingEngines: number;
}

export interface Flight {
  n: number;
  name: string;
  /** ISO date of launch (UTC). */
  date: string;
  /** Liftoff, ISO UTC. Times marked approximate are within the published launch window. */
  liftoffUtc: string;
  liftoffApprox?: boolean;
  generation: Generation;
  generationLabel: string;
  pad: PadId;
  padLabel: string;
  boosterId: string;
  shipId: string;
  headline: string;
  boosterSummary: string;
  shipSummary: string;
  boosterEnd: EndKind;
  shipEnd: EndKind;
  targets: FlightTargets;
  plan: { booster: BoosterPlan; ship: ShipPlan };
  anomalies: Anomaly[];
}

const INDIAN_OCEAN = { name: 'Indian Ocean', lat: -20.5, lon: 110.5 };

const BLOCK1_BOOSTER: BoosterPlan = { recovery: 'splashdown', boostbackEngines: 13, landingEngines: [13, 3] };

export const FLIGHTS: Flight[] = [
  {
    n: 1,
    name: 'Flight 1',
    date: '2023-04-20',
    liftoffUtc: '2023-04-20T13:33:09Z',
    generation: 'b1',
    generationLabel: 'Block 1',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B7',
    shipId: 'S24',
    headline: 'The full stack flew for the first time but never separated.',
    boosterSummary:
      'Lifted off with engines already out and lost more on the way up. Steering failed, the stack tumbled and was destroyed near 39 km.',
    shipSummary: 'Rode Super Heavy the whole way and shared its fate.',
    boosterEnd: 'termination',
    shipEnd: 'termination',
    targets: {
      maxQ: 87,
      boosterEnd: 241,
      shipEnd: 241,
      boosterTopSpeedKmh: 2157,
      boosterApogeeKm: 39,
      shipTopSpeedKmh: 2168,
      shipApogeeKm: 39,
    },
    plan: {
      booster: { recovery: 'expend', boostbackEngines: 0, landingEngines: [] },
      ship: {
        mission: 'suborbital',
        payloadKind: 'none',
        payloadCount: 0,
        landing: { name: 'Pacific, north of Kauai', lat: 22.6, lon: -160.5 },
        landingEngines: 3,
      },
    },
    anomalies: [
      { t: 0, vehicle: 'booster', kind: 'no-ignition', count: 3, note: 'Three Raptors shut down during startup on the mount.' },
      { t: 27, vehicle: 'booster', kind: 'engine-out', count: 1, note: 'An outer-ring Raptor shuts down.' },
      { t: 62, vehicle: 'booster', kind: 'engine-out', count: 1, note: 'Another Raptor out.' },
      { t: 85, vehicle: 'booster', kind: 'engine-out', count: 1, note: 'Another Raptor out.' },
      { t: 118, vehicle: 'booster', kind: 'engine-out', count: 2, note: 'Two more Raptors out.' },
      { t: 160, vehicle: 'stack', kind: 'no-separation', note: 'Staging never happens.' },
      { t: 165, vehicle: 'stack', kind: 'tumble', note: 'Thrust vector control is lost and the stack starts to cartwheel.' },
      { t: 199, vehicle: 'stack', kind: 'fts', note: 'Flight termination commanded; the tanks take time to rupture.' },
      { t: 241, vehicle: 'stack', kind: 'breakup', note: 'The stack breaks up near apogee.' },
    ],
  },
  {
    n: 2,
    name: 'Flight 2',
    date: '2023-11-18',
    liftoffUtc: '2023-11-18T13:02:49Z',
    generation: 'b1',
    generationLabel: 'Block 1',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B9',
    shipId: 'S25',
    headline: 'Hot staging worked on the first try; neither stage survived.',
    boosterSummary: 'Burned all 33 engines to staging, separated hot, then came apart in the first seconds of boostback.',
    shipSummary: 'Climbed to about 148 km and was destroyed moments before its planned engine cutoff.',
    boosterEnd: 'lost',
    shipEnd: 'lost',
    targets: {
      maxQ: 56,
      meco: 160,
      staging: 164.6,
      boostbackStart: 170,
      boosterEnd: 201,
      shipEnd: 453,
      boosterTopSpeedKmh: 5664,
      boosterApogeeKm: 90,
      shipTopSpeedKmh: 20348,
      shipApogeeKm: 149,
    },
    plan: {
      booster: BLOCK1_BOOSTER,
      ship: {
        mission: 'suborbital',
        payloadKind: 'none',
        payloadCount: 0,
        landing: { name: 'Pacific, north of Kauai', lat: 22.6, lon: -160.5 },
        landingEngines: 3,
      },
    },
    anomalies: [
      { t: 180, vehicle: 'booster', kind: 'engine-out', count: 4, note: 'Engines start shutting down during the boostback burn.' },
      { t: 201, vehicle: 'booster', kind: 'breakup', note: 'Super Heavy breaks apart over the Gulf.' },
      { t: 440, vehicle: 'ship', kind: 'engine-out', count: 2, note: 'A propellant vent leads to a fire in the aft section.' },
      { t: 453, vehicle: 'ship', kind: 'fts', note: 'Contact lost; the flight termination system fires.' },
    ],
  },
  {
    n: 3,
    name: 'Flight 3',
    date: '2024-03-14',
    liftoffUtc: '2024-03-14T13:25:00Z',
    generation: 'b1',
    generationLabel: 'Block 1',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B10',
    shipId: 'S28',
    headline: 'Starship reached space and coasted, then was lost on the way back.',
    boosterSummary: 'Finished boostback, but its engines faltered as the landing burn began and it was lost low over the Gulf.',
    shipSummary: 'Reached its planned path and opened the payload door. A slow roll in coast ruled out the relight; lost during reentry.',
    boosterEnd: 'lost',
    shipEnd: 'lost',
    targets: {
      maxQ: 54,
      meco: 164,
      staging: 167.7,
      boostbackStart: 173,
      boostbackEnd: 226,
      boosterApogee: 241,
      boosterLandingBurn: 414,
      boosterEnd: 415,
      seco: 515,
      shipApogee: 1425,
      entry: 2665,
      shipEnd: 2870,
      boosterTopSpeedKmh: 5750,
      boosterApogeeKm: 106,
      shipTopSpeedKmh: 26759,
      shipApogeeKm: 234,
    },
    plan: {
      booster: BLOCK1_BOOSTER,
      ship: {
        mission: 'suborbital',
        payloadKind: 'none',
        payloadCount: 0,
        relight: { t: 2400, duration: 6 },
        landing: INDIAN_OCEAN,
        landingEngines: 3,
      },
    },
    anomalies: [
      { t: 205, vehicle: 'booster', kind: 'engine-out', count: 3, note: 'Several engines shut down early in the boostback burn.' },
      { t: 414, vehicle: 'booster', kind: 'landing-burn-fail', note: 'Engines fail as the landing burn starts; the booster is lost about 460 m above the water.' },
      { t: 1200, vehicle: 'ship', kind: 'roll', note: 'Attitude control is lost and the ship starts to roll.' },
      { t: 2350, vehicle: 'ship', kind: 'relight-skip', note: 'The relight is skipped because of the roll.' },
      { t: 2870, vehicle: 'ship', kind: 'breakup', note: 'Lost during reentry over the Indian Ocean.' },
    ],
  },
  {
    n: 4,
    name: 'Flight 4',
    date: '2024-06-06',
    liftoffUtc: '2024-06-06T12:50:00Z',
    generation: 'b1',
    generationLabel: 'Block 1',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B11',
    shipId: 'S29',
    headline: 'Both vehicles came back for soft splashdowns.',
    boosterSummary: 'Lost an engine on the climb and another in boostback, then flew a landing burn to a soft splashdown in the Gulf.',
    shipSummary: 'A forward flap burned through on reentry but still steered. Flipped and splashed down in the Indian Ocean.',
    boosterEnd: 'splashdown',
    shipEnd: 'splashdown',
    targets: {
      maxQ: 63,
      meco: 168,
      staging: 171.7,
      boostbackStart: 177,
      boostbackEnd: 228,
      boosterApogee: 249,
      boosterLandingBurn: 429,
      boosterEnd: 452,
      seco: 517,
      shipApogee: 1412,
      entry: 2609,
      shipLandingBurn: 3985,
      shipEnd: 3999,
      boosterTopSpeedKmh: 5539,
      boosterApogeeKm: 109,
      shipTopSpeedKmh: 26757,
      shipApogeeKm: 213,
    },
    plan: {
      booster: BLOCK1_BOOSTER,
      ship: { mission: 'suborbital', payloadKind: 'none', payloadCount: 0, landing: INDIAN_OCEAN, landingEngines: 3 },
    },
    anomalies: [
      { t: 4, vehicle: 'booster', kind: 'engine-out', count: 1, note: 'One outer Raptor shuts down soon after liftoff.' },
      { t: 180, vehicle: 'booster', kind: 'engine-out', count: 1, note: 'One engine does not relight for boostback.' },
    ],
  },
  {
    n: 5,
    name: 'Flight 5',
    date: '2024-10-13',
    liftoffUtc: '2024-10-13T12:25:00Z',
    generation: 'b1',
    generationLabel: 'Block 1',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B12',
    shipId: 'S30',
    headline: 'Chopsticks: the tower plucked Super Heavy out of the air.',
    boosterSummary: 'Returned to Starbase and was caught by the launch tower on its first try.',
    shipSummary: 'Steered through reentry and hit its aim point in the Indian Ocean.',
    boosterEnd: 'catch',
    shipEnd: 'splashdown',
    targets: {
      maxQ: 56,
      meco: 156,
      staging: 160,
      boostbackStart: 165,
      boostbackEnd: 211,
      boosterApogee: 226,
      boosterLandingBurn: 390,
      boosterEnd: 412,
      seco: 508,
      shipApogee: 1344,
      entry: 2606,
      shipLandingBurn: 3950,
      shipEnd: 3965,
      boosterTopSpeedKmh: 5275,
      boosterApogeeKm: 96,
      shipTopSpeedKmh: 26756,
      shipApogeeKm: 212,
    },
    plan: {
      booster: { recovery: 'catch', boostbackEngines: 13, landingEngines: [13, 3] },
      ship: { mission: 'suborbital', payloadKind: 'none', payloadCount: 0, landing: INDIAN_OCEAN, landingEngines: 3 },
    },
    anomalies: [],
  },
  {
    n: 6,
    name: 'Flight 6',
    date: '2024-11-19',
    liftoffUtc: '2024-11-19T22:00:00Z',
    generation: 'b1',
    generationLabel: 'Block 1',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B13',
    shipId: 'S31',
    headline: 'A Raptor fired again in space, a first for Starship.',
    boosterSummary: 'Tower checks failed mid-boostback, so it skipped the catch and set down in the Gulf instead.',
    shipSummary: 'Relit one Raptor in space, came back through a steeper reentry and splashed down in daylight in the Indian Ocean.',
    boosterEnd: 'splashdown',
    shipEnd: 'splashdown',
    targets: {
      maxQ: 56,
      meco: 156,
      staging: 159.9,
      boostbackStart: 165,
      boostbackEnd: 208,
      boosterApogee: 233,
      boosterLandingBurn: 394,
      boosterEnd: 415,
      seco: 508,
      shipApogee: 1207,
      relight: 2266,
      entry: 2434,
      shipLandingBurn: 3909,
      shipEnd: 3924,
      boosterTopSpeedKmh: 5295,
      boosterApogeeKm: 97,
      shipTopSpeedKmh: 26816,
      shipApogeeKm: 190,
    },
    plan: {
      booster: { recovery: 'catch', boostbackEngines: 13, landingEngines: [13, 3] },
      ship: {
        mission: 'suborbital',
        payloadKind: 'none',
        payloadCount: 0,
        relight: { t: 2266, duration: 5 },
        landing: INDIAN_OCEAN,
        landingEngines: 3,
      },
    },
    anomalies: [{ t: 170, vehicle: 'booster', kind: 'catch-abort', note: 'Tower checks fail; the catch is called off.' }],
  },
  {
    n: 7,
    name: 'Flight 7',
    date: '2025-01-16',
    liftoffUtc: '2025-01-16T22:37:00Z',
    generation: 'b2',
    generationLabel: 'Block 2 Ship',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B14',
    shipId: 'S33',
    headline: 'Super Heavy was caught again. The first Block 2 ship was lost on ascent.',
    boosterSummary: 'Back on the tower arms for a second catch.',
    shipSummary: 'A leak fed a fire in the aft section; engines shut down one after another and the ship broke up about eight minutes in.',
    boosterEnd: 'catch',
    shipEnd: 'lost',
    targets: {
      maxQ: 60,
      meco: 156,
      staging: 161.7,
      boostbackStart: 165,
      boostbackEnd: 209,
      boosterApogee: 231,
      boosterLandingBurn: 391,
      boosterEnd: 411,
      shipEnd: 476,
      boosterTopSpeedKmh: 4432,
      boosterApogeeKm: 91,
      shipTopSpeedKmh: 19384,
      shipApogeeKm: 143,
    },
    plan: {
      booster: { recovery: 'catch', boostbackEngines: 13, landingEngines: [13, 3] },
      ship: {
        mission: 'suborbital',
        payloadKind: 'starlink-sim',
        payloadCount: 10,
        relight: { t: 2200, duration: 6 },
        landing: INDIAN_OCEAN,
        landingEngines: 3,
      },
    },
    anomalies: [
      { t: 452, vehicle: 'ship', kind: 'engine-out', count: 2, note: 'Fire in the aft attic: engines begin to shut down.' },
      { t: 466, vehicle: 'ship', kind: 'engine-out', count: 2, note: 'More engines shut down.' },
      { t: 476, vehicle: 'ship', kind: 'breakup', note: 'Contact lost; the ship breaks up.' },
    ],
  },
  {
    n: 8,
    name: 'Flight 8',
    date: '2025-03-06',
    liftoffUtc: '2025-03-06T23:30:00Z',
    generation: 'b2',
    generationLabel: 'Block 2 Ship',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B15',
    shipId: 'S34',
    headline: 'A third booster catch. The ship lost engines late in its burn.',
    boosterSummary: 'A third catch on the tower arms.',
    shipSummary: 'A cascade of engine failures late in the climb sent the ship spinning; telemetry stopped about 9½ minutes into the flight.',
    boosterEnd: 'catch',
    shipEnd: 'lost',
    targets: {
      maxQ: 60,
      meco: 155,
      staging: 159.6,
      boostbackStart: 164,
      boostbackEnd: 219,
      boosterApogee: 232,
      boosterLandingBurn: 395,
      boosterEnd: 417,
      shipEnd: 579,
      boosterTopSpeedKmh: 4531,
      boosterApogeeKm: 87,
      shipTopSpeedKmh: 20464,
      shipApogeeKm: 146,
    },
    plan: {
      booster: { recovery: 'catch', boostbackEngines: 13, landingEngines: [13, 3] },
      ship: {
        mission: 'suborbital',
        payloadKind: 'starlink-sim',
        payloadCount: 4,
        relight: { t: 2200, duration: 6 },
        landing: INDIAN_OCEAN,
        landingEngines: 3,
      },
    },
    anomalies: [
      { t: 484, vehicle: 'ship', kind: 'engine-out', engines: [0], note: 'A flash in the aft section destroys a centre sea-level Raptor.' },
      { t: 488, vehicle: 'ship', kind: 'engine-out', engines: [1, 2, 3], note: 'The other two centre engines and a Raptor Vacuum shut down.' },
      { t: 495, vehicle: 'ship', kind: 'tumble', note: 'Attitude control is lost; the ship starts to spin.' },
      { t: 579, vehicle: 'ship', kind: 'breakup', note: 'Contact lost.' },
    ],
  },
  {
    n: 9,
    name: 'Flight 9',
    date: '2025-05-27',
    liftoffUtc: '2025-05-27T23:36:00Z',
    generation: 'b2',
    generationLabel: 'Block 2 Ship',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B14-2',
    shipId: 'S35',
    headline: 'A flight-proven booster flew again; the ship did not survive reentry.',
    boosterSummary: 'The first booster to fly twice. It tried a steeper descent and was lost when its landing burn started over the Gulf.',
    shipSummary: 'Made its planned path, yet the payload door jammed and leaking propellant left it unable to hold attitude; it broke up coming back in.',
    boosterEnd: 'lost',
    shipEnd: 'lost',
    targets: {
      maxQ: 60,
      meco: 156,
      staging: 162.2,
      boosterEnd: 382,
      seco: 538,
      shipApogee: 1216,
      entry: 2397,
      shipEnd: 2802,
      boosterTopSpeedKmh: 4718,
      boosterApogeeKm: 95,
      shipTopSpeedKmh: 26693,
      shipApogeeKm: 189,
    },
    plan: {
      booster: { recovery: 'splashdown', boostbackEngines: 13, landingEngines: [13, 3] },
      ship: {
        mission: 'suborbital',
        payloadKind: 'starlink-sim',
        payloadCount: 8,
        relight: { t: 2200, duration: 6 },
        landing: INDIAN_OCEAN,
        landingEngines: 3,
      },
    },
    anomalies: [
      { t: 382, vehicle: 'booster', kind: 'landing-burn-fail', note: 'Lost as the landing burn lights.' },
      { t: 1050, vehicle: 'ship', kind: 'payload-door-fail', note: 'The payload door does not open.' },
      { t: 1700, vehicle: 'ship', kind: 'roll', note: 'Leaks spin the ship up; attitude control is lost.' },
      { t: 2150, vehicle: 'ship', kind: 'relight-skip', note: 'The relight is called off.' },
      { t: 2802, vehicle: 'ship', kind: 'breakup', note: 'Lost during reentry over the Indian Ocean.' },
    ],
  },
  {
    n: 10,
    name: 'Flight 10',
    date: '2025-08-26',
    liftoffUtc: '2025-08-26T23:30:00Z',
    generation: 'b2',
    generationLabel: 'Block 2 Ship',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B16',
    shipId: 'S37',
    headline: 'The first successful payload deploy, and a Raptor relit in space.',
    boosterSummary: 'Flew a landing-burn test with a planned engine out, hovered and splashed down in the Gulf.',
    shipSummary: 'Pushed eight dummy Starlinks out of the payload bay, fired a Raptor in space and ended with a fiery splashdown off Western Australia.',
    boosterEnd: 'splashdown',
    shipEnd: 'splashdown',
    targets: {
      maxQ: 64,
      staging: 157.2,
      meco: 160,
      boostbackStart: 169,
      boostbackEnd: 204,
      boosterApogee: 227,
      boosterLandingBurn: 377,
      boosterEnd: 387,
      seco: 540,
      payloadStart: 1107,
      shipApogee: 1260,
      payloadEnd: 1532,
      relight: 2269,
      entry: 2518,
      shipLandingBurn: 3990,
      shipEnd: 4005,
      boosterTopSpeedKmh: 4661,
      boosterApogeeKm: 87.5,
      shipTopSpeedKmh: 26806,
      shipApogeeKm: 192,
    },
    plan: {
      booster: { recovery: 'splashdown', boostbackEngines: 13, landingEngines: [13, 3] },
      ship: {
        mission: 'suborbital',
        payloadKind: 'starlink-sim',
        payloadCount: 8,
        relight: { t: 2269, duration: 6 },
        landing: INDIAN_OCEAN,
        landingEngines: 3,
      },
    },
    anomalies: [{ t: 378, vehicle: 'booster', kind: 'engine-out', engines: [1], note: 'A centre engine is disabled on purpose for the landing burn test.' }],
  },
  {
    n: 11,
    name: 'Flight 11',
    date: '2025-10-13',
    liftoffUtc: '2025-10-13T23:23:00Z',
    generation: 'b2',
    generationLabel: 'Block 2 Ship (last)',
    pad: 'pad1',
    padLabel: 'Pad 1',
    boosterId: 'B15-2',
    shipId: 'S38',
    headline: 'Block 2 bowed out with a clean sweep of its test goals.',
    boosterSummary: 'Trialled a new 13-5-3 landing-burn engine sequence before splashing down in the Gulf.',
    shipSummary: 'Deployed eight Starlink simulators, relit a Raptor, banked through its final approach and splashed down in the Indian Ocean.',
    boosterEnd: 'splashdown',
    shipEnd: 'splashdown',
    targets: {
      maxQ: 61,
      staging: 157.6,
      meco: 161,
      boostbackStart: 170,
      boostbackEnd: 205,
      boosterApogee: 228,
      boosterLandingBurn: 377,
      boosterEnd: 386,
      seco: 541,
      payloadStart: 1108,
      shipApogee: 1304,
      payloadEnd: 1533,
      relight: 2270,
      entry: 2502,
      shipLandingBurn: 3954,
      shipEnd: 3970,
      boosterTopSpeedKmh: 4614,
      boosterApogeeKm: 88.3,
      shipTopSpeedKmh: 26805,
      shipApogeeKm: 192,
    },
    plan: {
      booster: { recovery: 'splashdown', boostbackEngines: 13, landingEngines: [13, 5, 3] },
      ship: {
        mission: 'suborbital',
        payloadKind: 'starlink-sim',
        payloadCount: 8,
        relight: { t: 2270, duration: 6 },
        landing: INDIAN_OCEAN,
        landingEngines: 3,
      },
    },
    anomalies: [],
  },
  {
    n: 12,
    name: 'Flight 12',
    date: '2026-05-22',
    liftoffUtc: '2026-05-22T22:33:00Z',
    generation: 'v3',
    generationLabel: 'V3 (first)',
    pad: 'pad2',
    padLabel: 'Pad 2',
    boosterId: '',
    shipId: 'S39',
    headline: 'Debut of Starship V3 and the first launch from Pad 2.',
    boosterSummary: 'Climbed with one Raptor down, cut its boostback short and slammed into the Gulf.',
    shipSummary: 'Made its target path despite a failed Raptor Vacuum, set loose 22 satellites (20 mass simulators and 2 camera-carrying Starlinks) and landed in the water on two engines.',
    boosterEnd: 'impact',
    shipEnd: 'splashdown',
    targets: {
      maxQ: 70,
      staging: 143.2,
      meco: 144,
      boostbackStart: 152,
      boostbackEnd: 169,
      boosterApogee: 220,
      boosterEnd: 376,
      seco: 557,
      payloadStart: 1057,
      shipApogee: 1412,
      payloadEnd: 1635,
      entry: 2542,
      shipLandingBurn: 3968,
      shipEnd: 3984,
      boosterTopSpeedKmh: 5717,
      boosterApogeeKm: 82.7,
      shipTopSpeedKmh: 26749,
      shipApogeeKm: 195,
    },
    plan: {
      booster: { recovery: 'splashdown', boostbackEngines: 13, landingEngines: [13, 5, 3] },
      ship: { mission: 'suborbital', payloadKind: 'starlink-sim', payloadCount: 22, landing: INDIAN_OCEAN, landingEngines: 3 },
    },
    anomalies: [
      { t: 48, vehicle: 'booster', kind: 'engine-out', count: 1, note: 'One outer Raptor shuts down on the climb.' },
      { t: 169, vehicle: 'booster', kind: 'boostback-cut', note: 'The boostback burn ends early.' },
      { t: 300, vehicle: 'ship', kind: 'engine-out', engines: [3], note: 'One Raptor Vacuum shuts down.' },
      { t: 3960, vehicle: 'ship', kind: 'engine-out', engines: [2], note: 'One sea-level Raptor does not relight for landing.' },
    ],
  },
  {
    n: 13,
    name: 'Flight 13',
    date: '2026-07-24',
    liftoffUtc: '2026-07-24T22:45:00Z',
    liftoffApprox: true,
    generation: 'v3',
    generationLabel: 'V3',
    pad: 'pad2',
    padLabel: 'Pad 2',
    boosterId: '',
    shipId: 'S40',
    headline: 'The first real Starlink V3 satellites went up.',
    boosterSummary: 'Lit every engine for boostback but shut down early, so the booster came down hard in the Gulf.',
    shipSummary: 'Put 20 Starlink V3 satellites out of its payload bay, fired a Raptor again in space, then came home in one piece to a gentle Indian Ocean splashdown.',
    boosterEnd: 'splashdown',
    shipEnd: 'splashdown',
    targets: {
      maxQ: 62,
      staging: 138.8,
      meco: 140,
      boostbackStart: 148,
      boostbackEnd: 170,
      boosterApogee: 232,
      boosterLandingBurn: 386,
      boosterEnd: 395,
      seco: 486,
      payloadStart: 1000,
      shipApogee: 1273,
      payloadEnd: 1659,
      relight: 2341,
      entry: 2530,
      shipLandingBurn: 3903,
      shipEnd: 3920,
      boosterTopSpeedKmh: 5893,
      boosterApogeeKm: 95.6,
      shipTopSpeedKmh: 26809,
      shipApogeeKm: 198,
    },
    plan: {
      booster: { recovery: 'splashdown', boostbackEngines: 33, landingEngines: [13, 5, 3] },
      ship: {
        mission: 'suborbital',
        payloadKind: 'starlink-v3',
        payloadCount: 20,
        relight: { t: 2341, duration: 6 },
        landing: INDIAN_OCEAN,
        landingEngines: 3,
      },
    },
    anomalies: [{ t: 170, vehicle: 'booster', kind: 'boostback-cut', note: 'The boostback burn shuts down early.' }],
  },
  {
    n: 14,
    name: 'Flight 14',
    date: '2026-09-28',
    liftoffUtc: '2026-09-28T12:49:00Z',
    generation: 'v3',
    generationLabel: 'V3',
    pad: 'pad2',
    padLabel: 'Pad 2',
    boosterId: 'B21',
    shipId: 'S41',
    headline: 'The first orbital flight, with 26 Starlink V3 satellites aboard.',
    boosterSummary: 'Flew its boostback with 31 Raptors and a three-step landing burn (11, 5, then 3 engines) before splashing down in the Gulf.',
    shipSummary: 'Reached orbit for the first time even with one Raptor Vacuum out. It released 26 Starlink V3 satellites, fired a deorbit burn and splashed down north of Hawaii about three hours after launch.',
    boosterEnd: 'splashdown',
    shipEnd: 'splashdown',
    targets: {
      maxQ: 69,
      staging: 139.3,
      meco: 143,
      boostbackStart: 151,
      boostbackEnd: 176,
      boosterApogee: 240,
      boosterLandingBurn: 397,
      boosterEnd: 407,
      seco: 508,
      orbitInsertion: 1520,
      shipApogee: 1657,
      payloadStart: 2047,
      payloadEnd: 3879,
      deorbit: 7938,
      entry: 9591,
      shipLandingBurn: 11292,
      shipEnd: 11311,
      boosterTopSpeedKmh: 5957,
      boosterApogeeKm: 98.9,
      shipTopSpeedKmh: 26948,
      shipApogeeKm: 277,
    },
    plan: {
      booster: { recovery: 'splashdown', boostbackEngines: 31, landingEngines: [11, 5, 3] },
      ship: {
        mission: 'orbital',
        payloadKind: 'starlink-v3',
        payloadCount: 26,
        insertion: { t: 1520 },
        deorbit: { t: 7938 },
        landing: { name: 'North Pacific, north of Hawaii', lat: 24.5, lon: -157.5 },
        landingEngines: 3,
      },
    },
    anomalies: [{ t: 370, vehicle: 'ship', kind: 'engine-out', engines: [3], note: 'One Raptor Vacuum shuts down during the ascent burn.' }],
  },
];

export const LATEST_FLIGHT = FLIGHTS[FLIGHTS.length - 1].n;

export function getFlight(n: number): Flight {
  return FLIGHTS.find((f) => f.n === n) ?? FLIGHTS[FLIGHTS.length - 1];
}

export interface PadSite {
  label: string;
  /** Launch mount centre. */
  lat: number;
  lon: number;
  /** Ground level above the sea, m. */
  groundAlt: number;
  /** Height of the booster's base above the ground while it sits on the launch mount, m. */
  mountHeight: number;
  /** Height of the booster's base above the ground when it hangs in the chopstick arms, m. The catch happens directly above the mount. */
  catchBaseHeight: number;
  /** Integration tower centre relative to the mount centre (local east/north, m) and its height. */
  tower: { east: number; north: number; height: number };
}

/** Launch pads at Starbase, Texas. */
export const PADS: Record<PadId, PadSite> = {
  pad1: { label: 'Pad 1', lat: 25.99683, lon: -97.1542, groundAlt: 3, mountHeight: 21, catchBaseHeight: 27, tower: { east: 0, north: 24, height: 146 } },
  pad2: { label: 'Pad 2', lat: 25.99545, lon: -97.15565, groundAlt: 3, mountHeight: 24, catchBaseHeight: 30, tower: { east: 0, north: 26, height: 152 } },
};

/** Where Super Heavy aims for a Gulf splashdown, about 10 km off the beach. */
export const GULF_SPLASHDOWN = { lat: 26.0, lon: -97.054 };

export const GENERATIONS: Record<Generation, { label: string; blurb: string }> = {
  b1: { label: 'Block 1', blurb: 'Raptor 2 engines, the original 121 m stack, Pad 1.' },
  b2: { label: 'Block 2 Ship', blurb: 'A stretched ship with more propellant on a Block 1 booster, Pad 1.' },
  v3: { label: 'V3', blurb: 'Raptor 3 engines, a taller stack, Pad 2.' },
};
