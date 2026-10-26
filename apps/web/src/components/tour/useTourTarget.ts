// Finds a tour step's target on the page (design section 7): the first `[data-tour]` id in
// priority order that is actually visible, waiting for it to render (most pages show
// "Loading..." first). The tour never points at something that is not on screen: a target that
// never shows up within TARGET_WAIT_MS gets the centered layout instead, and one that vanishes
// while its step is showing goes centered at once, re-anchoring if it is back within
// TARGET_RETURN_MS.
import { useEffect, useState, useSyncExternalStore } from 'react';

export const TARGET_WAIT_MS = 2500;
export const TARGET_RETURN_MS = 1000;
const SCROLL_SETTLE_MS = 600;
/** The sticky header (h-14) plus 16px, so a scrolled-to target is not under it. */
const HEADER_CLEARANCE_PX = 72;

/** The bottom-sheet layout (section 9): below sm, or a short window (lib/sidebar.ts's query). */
export const SHEET_QUERY = '(max-width: 639.98px), (max-height: 500px)';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
}

export const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;

/** In the DOM, nonzero size, rendered, not inside a closed <details> or an inert subtree. */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (el.closest('details:not([open]) > :not(summary)') !== null) return false;
  const inert = el.closest('[inert]');
  return inert === null || inert.closest('[data-tour-layer]') !== null;
}

export function findTarget(ids: readonly string[], opts: { enabledOnly?: boolean } = {}) {
  for (const id of ids) {
    for (const el of document.querySelectorAll(`[data-tour="${CSS.escape(id)}"]`)) {
      if (opts.enabledOnly === true && el.matches(':disabled, [aria-disabled="true"]')) continue;
      if (isVisible(el)) return el;
    }
  }
  return null;
}

/** Scrolls `el` into view and resolves once the scroll has settled (or after a timeout). */
export function scrollToTarget(el: Element, sheet: boolean): Promise<void> {
  const reduced = prefersReducedMotion();
  const html = el as HTMLElement;
  // CSSOM writes are allowed under the CSP; restored straight after.
  const prevMargin = html.style.scrollMarginTop;
  html.style.scrollMarginTop = `${HEADER_CLEARANCE_PX}px`;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('scrollend', finish, true);
      html.style.scrollMarginTop = prevMargin;
      resolve();
    };
    window.addEventListener('scrollend', finish, true);
    el.scrollIntoView({
      block: sheet ? 'start' : 'center',
      inline: 'nearest',
      behavior: reduced ? 'instant' : 'smooth',
    });
    window.setTimeout(finish, reduced ? 0 : SCROLL_SETTLE_MS);
  });
}

export type TargetState =
  | { status: 'searching'; el: null }
  | { status: 'found'; el: Element }
  /** No target (a centered step, the fallback, or a target that vanished). */
  | { status: 'centered'; el: null };

/**
 * Resolves `ids` while `active`. `resolveKey` restarts the search (a new step). An empty id
 * list is a centered step by definition.
 */
export function useTourTarget(
  ids: readonly string[],
  active: boolean,
  resolveKey: string,
  sheet: boolean,
): TargetState {
  const [state, setState] = useState<TargetState>({ status: 'searching', el: null });
  const idsKey = ids.join('|');

  useEffect(() => {
    if (!active) return;
    const list = idsKey === '' ? [] : idsKey.split('|');
    if (list.length === 0) {
      setState({ status: 'centered', el: null });
      return;
    }
    let cancelled = false;
    let current: Element | null = null;
    let timer: number | undefined;
    const fallbackAfter = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!cancelled && current === null) setState({ status: 'centered', el: null });
      }, ms);
    };
    const check = () => {
      if (cancelled) return;
      if (current !== null && isVisible(current)) return;
      const el = findTarget(list);
      if (el === null) {
        if (current !== null) {
          // It vanished while showing: centered now, and give it a moment to come back.
          current = null;
          setState({ status: 'centered', el: null });
          fallbackAfter(TARGET_RETURN_MS);
        }
        return;
      }
      current = el;
      window.clearTimeout(timer);
      void scrollToTarget(el, sheet).then(() => {
        if (!cancelled && current === el) setState({ status: 'found', el });
      });
    };
    setState({ status: 'searching', el: null });
    const mo = new MutationObserver(check);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true });
    check();
    if (current === null) fallbackAfter(TARGET_WAIT_MS);
    return () => {
      cancelled = true;
      mo.disconnect();
      window.clearTimeout(timer);
    };
  }, [idsKey, active, resolveKey, sheet]);

  return active ? state : { status: 'searching', el: null };
}

/**
 * Do it now's landing: waits for the first enabled, visible match, scrolls to it and focuses
 * it (a non-focusable card gets tabindex=-1 first). Resolves false if none appears in time.
 */
export async function focusFirst(ids: readonly string[], sheet: boolean): Promise<boolean> {
  if (ids.length === 0) return false;
  const deadline = Date.now() + TARGET_WAIT_MS;
  let el = findTarget(ids, { enabledOnly: true });
  while (el === null && Date.now() < deadline) {
    await new Promise((r) => window.setTimeout(r, 50));
    el = findTarget(ids, { enabledOnly: true });
  }
  if (el === null) return false;
  await scrollToTarget(el, sheet);
  const html = el as HTMLElement;
  if (html.tabIndex < 0 && !html.hasAttribute('tabindex')) html.setAttribute('tabindex', '-1');
  html.focus({ preventScroll: true });
  return true;
}
