'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconClose, IconGithub, IconMenu } from '@/components/icons';
import styles from './shell.module.css';

export type SiteSection = 'replay' | 'compare' | 'flights' | 'about';

const NAV: { id: SiteSection; label: string; href: string }[] = [
  { id: 'replay', label: 'Replay', href: '/' },
  { id: 'compare', label: 'Compare', href: '/compare' },
  { id: 'flights', label: 'Flights', href: '/flights' },
  { id: 'about', label: 'About', href: '/about' },
];

export const REPO_URL = 'https://github.com/rookasrudzianskas/starship';

interface Props {
  active: SiteSection;
  /** Replay-only controls (flight picker), placed after the brand. */
  picker?: ReactNode;
  /** Replay-only actions (share), placed at the far right. */
  actions?: ReactNode;
}

export function SiteHeader({ active, picker, actions }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="Starship Telemetry, latest flight">
        <span className={styles.brandTitle}>
          Starship<span className={styles.brandTitleRest}> Telemetry</span>
        </span>
        <span className={styles.brandSub}>Every flight · simulated</span>
      </Link>
      <a className={styles.source} href={REPO_URL} target="_blank" rel="noreferrer" aria-label="Source code on GitHub">
        <span className={styles.sourceBy}>Open source</span>
        <IconGithub size={15} />
      </a>
      {picker ? <div className={styles.pickerSlot}>{picker}</div> : null}
      <nav className={styles.nav} aria-label="Views">
        {NAV.map((n) => (
          <Link
            key={n.id}
            href={n.href}
            className={styles.navLink}
            data-active={n.id === active || undefined}
            aria-current={n.id === active ? 'page' : undefined}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
      <div className={styles.menuWrap} ref={menuRef}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <IconClose size={18} /> : <IconMenu size={18} />}
        </button>
        {menuOpen ? (
          <div className={styles.menu} role="menu">
            {NAV.map((n) => (
              <Link
                key={n.id}
                href={n.href}
                role="menuitem"
                className={styles.menuItem}
                data-active={n.id === active || undefined}
                onClick={() => setMenuOpen(false)}
              >
                {n.label}
              </Link>
            ))}
            <a className={styles.menuItem} href={REPO_URL} target="_blank" rel="noreferrer" role="menuitem">
              Source on GitHub
            </a>
          </div>
        ) : null}
      </div>
    </header>
  );
}
