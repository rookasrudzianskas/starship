import type { KeyboardEvent } from 'react';

/**
 * Arrow-key navigation inside a menu or list: Up/Down move between the items matching `selector`
 * (wrapping around), Home/End go to the ends. Returns true when the key was used; it then stops there,
 * so the replay's own shortcuts never see it.
 */
export function rovingFocus(e: KeyboardEvent<HTMLElement>, selector: string): boolean {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (items.length === 0) return false;
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else return false;
  e.preventDefault();
  e.stopPropagation();
  items[next].focus();
  items[next].scrollIntoView({ block: 'nearest' });
  return true;
}
