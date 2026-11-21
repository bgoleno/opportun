// The resume flow's polite live region, shared by the Resume tab's card and the resume page's
// strip (https://github.com/bgoleno/opportun/issues/596).
//
// Each message is rendered as a new node (keyed by a count), not as new text in the same node: a
// screen reader is told of an addition, so the same message twice in a row ("Marked final. Next:
// apply." after a copy went back to In review and was marked final again) is said twice. Before,
// setting the same string again changed nothing in the page and was not said at all.
//
// The region then empties, so the last message is not left for a screen reader's reading cursor
// to come upon later, out of its moment. Removing the node is not announced.
import { useCallback, useEffect, useState } from 'react';

/** Long enough for a polite message to be read out after the speech already queued. */
export const ANNOUNCE_CLEAR_MS = 7000;

export interface Announced {
  text: string;
  /** Counts every message, a repeat included, so each is its own node. */
  n: number;
}

export function useFlowAnnouncer(): { value: Announced; announce: (text: string) => void } {
  const [value, setValue] = useState<Announced>({ text: '', n: 0 });
  useEffect(() => {
    if (value.text === '') return;
    // Restarted by each message (its n differs), so a new one is never cut short.
    const timer = setTimeout(() => setValue((v) => ({ ...v, text: '' })), ANNOUNCE_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [value]);
  const announce = useCallback((text: string) => setValue((v) => ({ text, n: v.n + 1 })), []);
  return { value, announce };
}

export function FlowAnnouncement({ value }: { value: Announced }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {value.text === '' ? null : <span key={value.n}>{value.text}</span>}
    </p>
  );
}
