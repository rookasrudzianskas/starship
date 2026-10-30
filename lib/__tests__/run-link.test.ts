import { describe, expect, it } from 'vitest';
import { getFlight, LATEST_FLIGHT } from '../flights/catalog';
import type { Intervention, Scenario } from '../sim/types';
import { AS_FLOWN } from '../store/replay';
import { decodeScenario, encodeScenario, readRunLink, runLinkSearch, type RunLink } from '../store/runLink';

/** Scenario content without the per-page command ids (toEqual treats an undefined property as absent). */
function content(s: Scenario) {
  return { ...s, interventions: s.interventions.map((i) => ({ ...i, id: undefined })) };
}

const everything: Scenario = {
  asFlown: false,
  boosterRecovery: 'splashdown',
  shipMission: 'orbital',
  payloadCount: 12,
  wind: 45,
  boosterLoad: 0.92,
  interventions: [
    { id: 'a', t: -5.5, kind: 'engine-out', vehicle: 'booster', engine: 32 },
    { id: 'b', t: 60.418, kind: 'throttle', vehicle: 'ship', value: 0.7 },
    { id: 'c', t: 120, kind: 'stage-now' },
    { id: 'd', t: 141.5, kind: 'pitch', vehicle: 'booster', deg: -4 },
    { id: 'e', t: 150, kind: 'skip-burn', vehicle: 'booster' },
    { id: 'f', t: 400.001, kind: 'terminate', vehicle: 'ship' },
    { id: 'g', t: 401, kind: 'engine-out', vehicle: 'ship', engine: 5 },
  ] as Intervention[],
};

describe('scenario codes', () => {
  it('round-trip every setting and command exactly', () => {
    const code = encodeScenario(everything);
    expect(code).toBe('P_Bs_Mo_N12_W45_L92_-5.5eb32_60.418hs70_120g_141.5pb-4_150kb_400.001xs_401es5');
    expect(content(decodeScenario(code, 14))).toEqual(content(everything));
    // Only characters that URLSearchParams leaves as they are.
    expect(new URLSearchParams({ run: code }).toString()).toBe(`run=${code}`);
  });

  it('is empty for the flight as flown', () => {
    expect(encodeScenario(AS_FLOWN)).toBe('');
    expect(encodeScenario({ asFlown: true, wind: 0, boosterLoad: 1, interventions: [] })).toBe('');
    expect(decodeScenario('', 14)).toBe(AS_FLOWN);
  });

  it('leaves out what the flight director could not have produced', () => {
    const bad = [
      'eb3', // no time
      '60eb33', // the booster has 33 engines (0-32)
      '60es6', // the ship has 6
      '60eb1.5',
      '60hs30', // throttle limit below 40 %
      '60pb120',
      '5g', // staging before T+20 s
      '-1xs', // termination before liftoff
      '-20eb1', // before the countdown
      '60xq',
      '60g2',
      'N61',
      'W0',
      'L100',
      'Bz',
      'P1',
      'Q',
      '',
    ].join('_');
    expect(decodeScenario(bad, 14)).toBe(AS_FLOWN);
    expect(content(decodeScenario(`${bad}_W40_60eb1`, 14))).toEqual({
      asFlown: true,
      wind: 40,
      interventions: [{ t: 60, kind: 'engine-out', vehicle: 'booster', engine: 1 }],
    });
  });

  it('treats the real payload as no change', () => {
    const real = getFlight(14).plan.ship.payloadCount;
    expect(decodeScenario(`N${real}`, 14)).toBe(AS_FLOWN);
    expect(decodeScenario(`N${real + 1}`, 14).payloadCount).toBe(real + 1);
  });

  it('keeps commands in time order', () => {
    const s = decodeScenario('300kb_100kb_200kb', 14);
    expect(s.interventions.map((i) => i.t)).toEqual([100, 200, 300]);
  });
});

describe('replay links', () => {
  const view: RunLink = { flight: 3, scenario: AS_FLOWN, camera: 'webcast', shot: 'auto', follow: 'both', pip: true };

  it('fall back to the latest flight as flown, from the start', () => {
    expect(readRunLink('')).toEqual({ ...view, flight: LATEST_FLIGHT });
    expect(readRunLink('?f=999&t=abc&cam=orbit&follow=moon&shot=Bad!')).toEqual({ ...view, flight: LATEST_FLIGHT });
  });

  it('read every part', () => {
    expect(readRunLink('?f=3&t=140.6&cam=chase&shot=pad&follow=ship&pip=0&run=W40')).toEqual({
      flight: 3,
      scenario: expect.objectContaining({ wind: 40 }),
      t: 141,
      camera: 'chase',
      shot: 'pad',
      follow: 'ship',
      pip: false,
    });
    expect(readRunLink('?t=0').t).toBe(0);
    expect(readRunLink('?t=').t).toBeUndefined();
  });

  it('write only what differs from the default', () => {
    expect(runLinkSearch({ ...view, flight: LATEST_FLIGHT }, false)).toBe('');
    expect(runLinkSearch({ ...view, flight: LATEST_FLIGHT }, true)).toBe(`?f=${LATEST_FLIGHT}`);
    expect(runLinkSearch({ ...view, t: -10, camera: 'globe', shot: 'tower', follow: 'booster', pip: false, scenario: { asFlown: false, interventions: [] } }, false)).toBe(
      '?f=3&run=P&t=-10&cam=globe&shot=tower&follow=booster&pip=0',
    );
  });

  it('read back what they write', () => {
    const link: RunLink = { flight: 9, scenario: decodeScenario('Bc_70eb12', 9), t: 75, camera: 'free', shot: 'buoy', follow: 'ship', pip: false };
    const back = readRunLink(runLinkSearch(link, true));
    expect({ ...back, scenario: content(back.scenario) }).toEqual({ ...link, scenario: content(link.scenario) });
  });
});
