'use client';

import { useSyncExternalStore } from 'react';

// The replay's own address (path and query), as the replay last wrote it to the address bar or read it from
// there. Any other address on the replay page came from a navigation; links back to the replay from the other
// pages go here, so they resume what was on screen instead of starting the latest flight over.

let address: string | null = null;
const listeners = new Set<() => void>();

/** The replay's address, or null before the replay has been shown in this visit. */
export function replayAddress(): string | null {
  return address;
}

export function setReplayAddress(url: string): void {
  if (url === address) return;
  address = url;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Where a link back to the replay goes: the replay as it was left, or the latest flight before any visit. */
export function useReplayHref(): string {
  return useSyncExternalStore(subscribe, () => address ?? '/', () => '/');
}
