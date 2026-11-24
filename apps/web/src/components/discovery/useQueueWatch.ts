// Keeps the open review queue true while the user captures its postings with the extension
// (https://github.com/bgoleno/opportun/issues/968): nothing on the page is told of a capture, so a
// card it accepted would stay until a reload. The page reads its list again when the user comes
// back to it, and, while a capture may still be finishing, asks every few seconds whether anything
// was accepted (tl's rulings on https://github.com/bgoleno/opportun/issues/967).
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { qk } from '@/lib/opportunities';
import { discoveryKeys, fetchLatestAccepted, QUEUE_DECISION } from './api';

/** Coming back to a tab fires both events: one within this of the other is the same return. */
const SAME_RETURN_MS = 1000;
/** How often the page asks. A card leaves within 5 s of its capture. */
const ASK_MS = 3000;
/** For how long after a return: the user may be back before the server has finished. */
const AFTER_RETURN_MS = 60_000;
/** And after a posting is opened from the page: in a second window beside it, nobody returns. */
const AFTER_POSTING_MS = 600_000;

/** Returns what to call when a posting is opened from the page. */
export function useQueueWatch(): () => void {
  const qc = useQueryClient();
  const opened = useRef<() => void>(() => undefined);

  useEffect(() => {
    let lastReturn = Number.NEGATIVE_INFINITY;
    let until = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The latest question; the answer to an earlier one is dropped. */
    let asking = 0;
    /** A return's read not made yet: the question before it was slow, and a later one replaced it. */
    let owed = false;
    /** The latest accepted result as last seen, undefined before the first answer. */
    let seen: string | undefined;

    const hidden = (): boolean => document.visibilityState === 'hidden';
    // A decision in flight reads the list when it settles, and a read answered before its commit
    // would bring the card back for a moment.
    const deciding = (): boolean => qc.isMutating({ mutationKey: QUEUE_DECISION }) > 0;

    /** Asks, then reads the list if something was accepted since the last answer (or `always`).
     *  In that order: an accept between the two is in the list, or a difference next time. */
    async function ask(always: boolean): Promise<void> {
      owed ||= always;
      asking += 1;
      const mine = asking;
      clearTimeout(timer);
      if (!deciding()) {
        // A failed question is silent: the next one, or the next return, makes up for it.
        const latest = await fetchLatestAccepted().catch(() => undefined);
        if (mine !== asking) return;
        const changed = latest !== undefined && latest !== seen;
        seen = latest ?? seen;
        if (deciding()) {
          seen = undefined;
          owed = false;
        } else if (owed || changed) {
          owed = false;
          // The Decided view and the pipeline, opened next, have what was captured too.
          void qc.invalidateQueries({ queryKey: discoveryKeys.results });
          void qc.invalidateQueries({ queryKey: qk.opportunities });
        }
      } else {
        // The decision's own read is the return's.
        owed = false;
      }
      next();
    }

    /** The next question, while there is a reason to ask and somebody to see the answer. */
    function next(): void {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (hidden() || performance.now() > until) return;
        void ask(false);
      }, ASK_MS);
    }

    // Two events, because TanStack Query's own refetchOnWindowFocus listens to visibilitychange
    // only, and a posting opened in a second window never hides this page: going back to it fires
    // only the window's focus. Nor does it read a list younger than its staleTime, and a capture
    // can take less.
    function onReturn(): void {
      if (hidden()) return;
      const now = performance.now();
      if (now - lastReturn < SAME_RETURN_MS) return;
      lastReturn = now;
      until = Math.max(until, now + AFTER_RETURN_MS);
      void ask(true);
    }

    opened.current = () => {
      until = Math.max(until, performance.now() + AFTER_POSTING_MS);
      next();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      opened.current = () => undefined;
      asking += 1;
      clearTimeout(timer);
    };
  }, [qc]);

  return useCallback(() => opened.current(), []);
}
