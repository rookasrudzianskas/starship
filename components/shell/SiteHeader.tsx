'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { IconClose, IconGithub, IconMenu } from '@/components/icons';
import { rovingFocus } from '@/components/replay/a11y';
import { useReplayHref } from '@/lib/store/replayAddress';
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
  /** The section this page belongs to; none on pages outside the main views (the 404). */
  active?: SiteSection;
  /** Replay-only controls (flight picker), placed after the brand. */
  picker?: ReactNode;
  /** Replay-only actions (share), placed at the far right. */
  actions?: ReactNode;
}

export function SiteHeader({ active, picker, actions }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // "Replay" resumes the flight being watched in this visit; the brand always opens the latest flight.
  const replayHref = useReplayHref();
  const hrefOf = (n: (typeof NAV)[number]) => (n.id === 'replay' ? replayHref : n.href);

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
    // Focus moves into the menu, to the page you are on (or the first item).
    const menu = menuRef.current;
    (menu?.querySelector<HTMLElement>('[role="menuitem"][data-active]') ?? menu?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus();
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Arrow keys move between the items; Escape closes the menu and goes back to its button.
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (rovingFocus(e, '[role="menuitem"]')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'Tab') {
      setMenuOpen(false);
    }
  };

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
            href={hrefOf(n)}
            // The page you are on needs no prefetch (and the replay's own address changes as you watch).
            prefetch={n.id === active ? false : undefined}
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
          ref={buttonRef}
          type="button"
          className={styles.iconButton}
          aria-label="Menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <IconClose size={18} /> : <IconMenu size={18} />}
        </button>
        {menuOpen ? (
          <div className={styles.menu} role="menu" onKeyDown={onMenuKey}>
            {NAV.map((n) => (
              <Link
                key={n.id}
                href={hrefOf(n)}
                prefetch={n.id === active ? false : undefined}
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
