// Collapse state for the nav rail (FR-U10 neighbour: the sidebar is a column only at md
// and up). The choice is per-browser and lives only in localStorage, not on the server:
// it answers "how much room does this window have", which differs between a phone held
// in landscape and the desktop the same account signs in from.
import { useCallback, useState } from 'react';

export const SIDEBAR_STORAGE_KEY = 'opportun.sidebarCollapsed';

/**
 * Short enough that a fixed 14rem rail crowds the page. A phone in landscape is ~430px
 * tall and clears the md breakpoint on width, so it gets the desktop sidebar unasked.
 */
const SHORT_VIEWPORT_QUERY = '(max-height: 500px)';

function readStored(): boolean | null {
  try {
    const v = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (v === 'collapsed') return true;
    if (v === 'expanded') return false;
    return null;
  } catch {
    return null;
  }
}

function writeStored(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // Storage blocked: the choice still holds for this page view.
  }
}

function isShortViewport(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(SHORT_VIEWPORT_QUERY).matches;
}

/** A stored choice always wins; otherwise a short window starts collapsed. */
export function initialCollapsed(): boolean {
  return readStored() ?? isShortViewport();
}

export function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggle = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    writeStored(next);
  }, [collapsed]);
  return { collapsed, toggle };
}
