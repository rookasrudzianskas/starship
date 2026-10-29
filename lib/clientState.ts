'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Browser-only state read through useSyncExternalStore: the server snapshot is used for the first
// (hydrating) render, then React re-renders with the real value without a hydration mismatch.

const flagListeners = new Set<() => void>();

function subscribeFlags(cb: () => void): () => void {
  flagListeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    flagListeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** A boolean remembered in localStorage (per browser). `serverValue` is used before hydration. */
export function useLocalFlag(key: string, serverValue: boolean): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    subscribeFlags,
    () => readFlag(key),
    () => serverValue,
  );
  const set = useCallback(
    (v: boolean) => {
      try {
        if (v) window.localStorage.setItem(key, '1');
        else window.localStorage.removeItem(key);
      } catch {
        // Storage unavailable: the flag just won't persist.
      }
      flagListeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}

let webgl2: boolean | null = null;

function detectWebgl2(): boolean {
  if (webgl2 === null) {
    try {
      webgl2 = Boolean(document.createElement('canvas').getContext('webgl2'));
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
}

const noop = () => () => undefined;

export function useWebgl2(): boolean {
  return useSyncExternalStore(noop, detectWebgl2, () => true);
}

function subscribeLocation(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  return () => window.removeEventListener('popstate', cb);
}

/** A query-string parameter of the current URL ('' on the server). */
export function useSearchParam(name: string): string {
  const search = useSyncExternalStore(
    subscribeLocation,
    () => window.location.search,
    () => '',
  );
  return new URLSearchParams(search).get(name) ?? '';
}
