import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '@/components/pages/pages.module.css';
import { SiteHeader } from '@/components/shell/SiteHeader';

export const metadata: Metadata = {
  title: 'Page not found',
};

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main className={styles.page}>
        <div className={`${styles.inner} ${styles.prose}`}>
          <h1 className={styles.h1}>Lost signal</h1>
          <p className={styles.lead}>There is nothing at this address. The latest flight is one click away.</p>
          <p style={{ marginTop: 24 }}>
            <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/">
              Back to the replay
            </Link>
          </p>
        </div>
      </main>
    </>
  );
}
