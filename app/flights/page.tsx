import type { Metadata } from 'next';
import Link from 'next/link';
import { FlightCsvButton } from '@/components/pages/FlightCsvButton';
import styles from '@/components/pages/pages.module.css';
import { SiteHeader } from '@/components/shell/SiteHeader';
import { FLIGHTS, GENERATIONS, type Flight, type FlightTargets } from '@/lib/flights/catalog';
import { formatDate, formatEventTime, formatNumber } from '@/lib/format';
import type { EndKind, Generation } from '@/lib/sim/types';

export const metadata: Metadata = {
  title: 'Every flight',
  description: 'All fourteen Starship flight tests, their outcomes and records, each one rebuilt as a physics simulation you can replay.',
};

const END_TAG: Record<EndKind, string> = {
  catch: 'Caught',
  splashdown: 'Splashdown',
  impact: 'Impact',
  lost: 'Lost',
  termination: 'Terminated',
  orbit: 'In orbit',
};

const EVENT_LABELS: [keyof FlightTargets, string][] = [
  ['maxQ', 'Max Q'],
  ['meco', 'Booster engine cutoff'],
  ['staging', 'Stage separation'],
  ['boostbackStart', 'Boostback burn'],
  ['boostbackEnd', 'Boostback shutdown'],
  ['boosterApogee', 'Booster apogee'],
  ['boosterLandingBurn', 'Booster landing burn'],
  ['boosterEnd', 'Booster flight ends'],
  ['seco', 'Ship engine cutoff'],
  ['orbitInsertion', 'Orbit insertion burn'],
  ['payloadStart', 'Payload deploy begins'],
  ['shipApogee', 'Ship apogee'],
  ['payloadEnd', 'Payload deploy ends'],
  ['relight', 'Raptor relight in space'],
  ['deorbit', 'Deorbit burn'],
  ['entry', 'Entry interface (120 km)'],
  ['shipLandingBurn', 'Ship landing burn'],
  ['shipEnd', 'Ship flight ends'],
];

function events(f: Flight): { t: number; label: string }[] {
  const list: { t: number; label: string }[] = [{ t: 0, label: 'Liftoff' }];
  for (const [key, label] of EVENT_LABELS) {
    const v = f.targets[key];
    if (typeof v === 'number' && key !== 'boosterTopSpeedKmh') list.push({ t: v, label });
  }
  return list.sort((a, b) => a.t - b.t);
}

const ORDER: Generation[] = ['v3', 'b2', 'b1'];

export default function FlightsPage() {
  return (
    <>
      <SiteHeader active="flights" />
      <main className={styles.page}>
        <div className={styles.inner}>
          <h1 className={styles.h1}>Every flight</h1>
          <p className={styles.lead}>
            Fourteen Starship flight tests, from the first integrated launch in April 2023 to the first orbital flight in September
            2026. Each one is rebuilt here as a physics simulation tuned to the milestones seen on the webcast. Replay any of them in
            3D, line them up against the others, take the controls, or download the numbers.
          </p>
          {ORDER.map((gen) => {
            const list = FLIGHTS.filter((f) => f.generation === gen).sort((a, b) => b.n - a.n);
            return (
              <section key={gen} className={styles.gen} aria-labelledby={`gen-${gen}`}>
                <div className={styles.genHead}>
                  <h2 className={styles.genName} id={`gen-${gen}`}>
                    {GENERATIONS[gen].label}
                  </h2>
                  <span className={styles.genBlurb}>
                    {list.length} flights · {GENERATIONS[gen].blurb}
                  </span>
                </div>
                {list.map((f) => (
                  <article key={f.n} className={styles.flight} id={`flight-${f.n}`}>
                    <div>
                      <div className={styles.flightName}>{f.name}</div>
                      <div className={styles.flightMeta}>
                        {formatDate(f.date)}
                        <br />
                        {[f.boosterId, f.shipId].filter(Boolean).join(' / ')} · {f.padLabel}
                      </div>
                    </div>
                    <div>
                      <p className={styles.headline}>{f.headline}</p>
                      <p className={styles.outcomeLine}>
                        <span className={styles.outcomeTag}>Super Heavy · {END_TAG[f.boosterEnd]}</span>
                        {f.boosterSummary}
                      </p>
                      <p className={styles.outcomeLine}>
                        <span className={styles.outcomeTag}>Starship · {END_TAG[f.shipEnd]}</span>
                        {f.shipSummary}
                      </p>
                      <div className={styles.stats}>
                        <div>
                          <div className={styles.statLabel}>Ship top speed</div>
                          <div className={styles.statValue}>
                            {formatNumber(f.targets.shipTopSpeedKmh)}
                            <span className={styles.statUnit}>km/h</span>
                          </div>
                        </div>
                        <div>
                          <div className={styles.statLabel}>Ship apogee</div>
                          <div className={styles.statValue}>
                            {formatNumber(f.targets.shipApogeeKm, f.targets.shipApogeeKm % 1 ? 1 : 0)}
                            <span className={styles.statUnit}>km</span>
                          </div>
                        </div>
                        <div>
                          <div className={styles.statLabel}>Booster apogee</div>
                          <div className={styles.statValue}>
                            {formatNumber(f.targets.boosterApogeeKm, f.targets.boosterApogeeKm % 1 ? 1 : 0)}
                            <span className={styles.statUnit}>km</span>
                          </div>
                        </div>
                      </div>
                      <div className={styles.flightActions}>
                        <Link className={`${styles.btn} ${styles.btnPrimary}`} href={`/?f=${f.n}`}>
                          Replay
                        </Link>
                        <Link className={styles.btn} href={`/compare?f=${f.n}`}>
                          Compare
                        </Link>
                        <FlightCsvButton flight={f.n} name={f.name} />
                      </div>
                    </div>
                    <details className={styles.events}>
                      <summary>Events</summary>
                      <dl className={styles.eventList}>
                        {events(f).map((e) => (
                          <div key={e.label} style={{ display: 'contents' }}>
                            <dt>{formatEventTime(e.t)}</dt>
                            <dd>{e.label}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      </main>
    </>
  );
}
