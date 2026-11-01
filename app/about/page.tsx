import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '@/components/pages/pages.module.css';
import { REPO_URL, SiteHeader } from '@/components/shell/SiteHeader';

export const metadata: Metadata = {
  title: 'About',
  description: 'How the Starship flight simulations are built, what you can change, and where the imagery and fonts come from.',
};

export default function AboutPage() {
  return (
    <>
      <SiteHeader active="about" />
      <main className={styles.page}>
        <div className={`${styles.inner} ${styles.prose}`}>
          <h1 className={styles.h1}>About</h1>
          <p className={styles.lead}>
            Starship Telemetry replays every Starship flight test as a physics simulation. Watch each launch in 3D with live speed,
            altitude, engines, propellant and attitude for both stages, compare flights on the same axes, and change the flight
            while it plays.
          </p>

          <h2 className={styles.h2}>How the flights are simulated</h2>
          <p>
            Each vehicle is flown as a point mass with a steered attitude over a spherical, rotating Earth. Gravity includes the
            J2 term from Earth&apos;s flattening. The air follows the 1976 US Standard Atmosphere, with drag and lift that change
            with Mach number and angle of attack. Raptor thrust drops with outside air pressure, so the sea-level engines gain
            thrust as they climb. Propellant drains as LOX and methane at the engines&apos; mixture ratio.
          </p>
          <p>Guidance flies each phase the way the real vehicles do:</p>
          <ul>
            <li>A gravity turn with a throttle bucket through max Q.</li>
            <li>Hot staging: Super Heavy drops to its centre engines while the ship lights above it.</li>
            <li>A boostback burn that steers the booster&apos;s predicted impact point back to the tower or the Gulf.</li>
            <li>Closed-loop guidance for the ship&apos;s climb, so it burns longer when it loses an engine.</li>
            <li>A belly-first entry that banks toward the landing zone, then a flip and a landing burn.</li>
          </ul>
          <p>
            Every flight is then tuned against the milestones seen on its webcast: times of max Q, staging, engine cutoffs, burns,
            entry and splashdown, plus apogees and top speeds. The real anomalies are scripted from the public record, such as
            engines lost, a stack that never separated, and ships lost on ascent or reentry. Run a flight &ldquo;as planned&rdquo;
            and it flies without them. The numbers are a careful reconstruction, not SpaceX telemetry, so expect small
            differences from the webcast.
          </p>

          <h2 className={styles.h2}>Take the controls</h2>
          <p>
            Open the <strong>flight director</strong> (the amber button, or press K) during any replay. Commands take effect at
            the moment on the clock, and the whole flight is re-simulated in the background. You can:
          </p>
          <ul>
            <li>Shut down engines. Click one on either engine map, or pick one at random.</li>
            <li>Cap the throttle.</li>
            <li>Nudge the steering.</li>
            <li>Command each of Starship&apos;s four flaps after separation, or return a flap to automatic control.</li>
            <li>Command hot staging early.</li>
            <li>Cancel the next burn: a boostback, a relight, the deorbit burn or a landing burn.</li>
            <li>Trigger flight termination.</li>
            <li>Send Super Heavy to the tower, the Gulf, or nowhere.</li>
            <li>Aim Starship for a suborbital path or orbit.</li>
            <li>Change how many Starlink satellites it carries.</li>
            <li>Add upper-level wind, or short-fuel the booster.</li>
          </ul>
          <p>
            The flap readout shows actual angles and motion rates alongside your targets. Positive flap rates mean folding.
            The surfaces take time to move, and their motion
            can change the ship&apos;s attitude and path in the atmosphere. Roll is measured from heat shield down: 0° is down,
            ±90° is side-on and 180° is up. Near a vertical nose, that reference is undefined and the readout shows a dash.
            The separate axial rate measures Earth-relative rotation about the nose, including when vertical. Rates estimate
            motion between replay samples; a dash means there is no valid interval to estimate from.
          </p>
          <p>
            Your commands appear on the timeline in amber. A vehicle flying differently from the real flight is marked{' '}
            <strong>Mod</strong>. With &ldquo;Real flight&apos;s path&rdquo; switched on in settings, the original trajectory stays
            on screen in white for comparison.
          </p>

          <h2 className={styles.h2}>Watching</h2>
          <p>
            The webcast camera cuts between trackers on the ground and in the air and onboard views like the broadcast does, or
            you can pin one view; drag or scroll it to take over with the free camera. Chase rides alongside a vehicle, Free lets
            you fly the camera around, and Globe shows both trajectories over the whole Earth with event markers. Everything is scrubbable: drag the timeline, step event by event with [ and ], or skip long
            coasts. Press ? for every shortcut. The sync button keeps the replay on the clock of a live webcast, so you can follow
            along during a launch. The <Link href="/compare">compare</Link> view puts all fourteen flights on shared axes, and every
            flight downloads as a CSV from the <Link href="/flights">flights</Link> list.
          </p>
          <p>
            Enable sound with the speaker button or M. Engine rumble and airflow are synthesized from the simulation, including
            engine failures and throttle changes; they are not webcast recordings. Sound starts muted and pauses when you pause
            playback, leave the replay, switch tabs, or fast-forward above 5×.
          </p>

          <h2 className={styles.h2} id="credits">
            Credits
          </h2>
          <div className={styles.credits}>
            <div className={styles.credit}>
              <div className={styles.creditTitle}>Earth imagery</div>
              <p className={styles.creditText}>
                Daytime Earth: NASA Blue Marble Next Generation (NASA Earth Observatory, public domain). Night lights: NASA Black
                Marble 2016 (NASA Earth Observatory, public domain). Ground around Starbase: Sentinel-2 cloudless 2016 by EOX IT
                Services GmbH, <a href="https://s2maps.eu">s2maps.eu</a>, licensed{' '}
                <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>; contains modified Copernicus Sentinel data
                2016.
              </p>
            </div>
            <div className={styles.credit}>
              <div className={styles.creditTitle}>Type</div>
              <p className={styles.creditText}>
                D-DIN by Datto, under the <a href="https://openfontlicense.org">SIL Open Font License 1.1</a>.
              </p>
            </div>
            <div className={styles.credit}>
              <div className={styles.creditTitle}>Software</div>
              <p className={styles.creditText}>
                Built with Next.js, React, three.js and Zustand. The vehicles, the launch site, the plumes and the sky are drawn
                procedurally in code. The source is on <a href={REPO_URL}>GitHub</a>.
              </p>
            </div>
          </div>

          <h2 className={styles.h2}>Rights and disclaimers</h2>
          <p>
            This is an independent fan project with no connection to SpaceX. Starship, Super Heavy, Raptor and Starlink are names
            used by Space Exploration Technologies Corp. and appear here only to identify the vehicles. Flight facts come from
            public webcasts and reporting. All numbers shown are simulated reconstructions; don&apos;t use them for anything that
            matters.
          </p>
        </div>
      </main>
    </>
  );
}
