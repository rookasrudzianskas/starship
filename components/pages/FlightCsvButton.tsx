'use client';

import { useState } from 'react';
import { IconDownload } from '@/components/icons';
import { downloadCsv } from '@/lib/csv';
import { runSimulation } from '@/lib/sim/client';
import styles from './pages.module.css';

/** Simulates the flight in the browser and downloads its numbers as CSV. */
export function FlightCsvButton({ flight, name }: { flight: number; name: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={styles.btn}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const result = await runSimulation(flight, { asFlown: true, interventions: [] });
          downloadCsv(result, name);
        } finally {
          setBusy(false);
        }
      }}
    >
      <IconDownload size={13} /> {busy ? 'Simulating…' : 'CSV'}
    </button>
  );
}
