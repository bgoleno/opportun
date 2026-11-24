// What the review queue says when the result it acts on was decided somewhere else: captured with
// the extension, or decided in another tab (https://github.com/bgoleno/opportun/issues/968). The
// server then answers 409 already_decided to accept, attach, create anyway and dismiss alike, and
// nothing was created or changed: nothing failed either, so none of these is an error.
import { ApiError } from '@/lib/api';

export interface Decided {
  disposition: 'accepted' | 'dismissed';
  /** The opportunity it was accepted into; null when dismissed, or when that one was deleted. */
  existingId: string | null;
}

/** How the result was decided, or null when `err` is any other answer. */
export function decidedOf(err: unknown): Decided | null {
  if (!(err instanceof ApiError) || err.code !== 'already_decided') return null;
  const { disposition, existingId } = err.details;
  return {
    disposition: disposition === 'accepted' ? 'accepted' : 'dismissed',
    existingId: typeof existingId === 'string' ? existingId : null,
  };
}

/** The sentence for one result. `accept` is also attach and create anyway. */
export function decidedSentence(pressed: 'accept' | 'dismiss', d: Decided): string {
  if (d.disposition === 'dismissed') {
    return pressed === 'accept'
      ? 'Not accepted: this result was already dismissed.'
      : 'Already dismissed.';
  }
  if (d.existingId === null) {
    return pressed === 'accept'
      ? 'Already accepted; its opportunity has since been deleted.'
      : 'Not dismissed: already accepted, and its opportunity has since been deleted.';
  }
  return pressed === 'accept'
    ? 'Already in your pipeline'
    : 'Not dismissed: already in your pipeline';
}

/**
 * How several results were decided, counted as the sentences above name it. One whose opportunity
 * was deleted is accepted and in no pipeline.
 */
export function decidedCounts(decided: readonly Decided[]): (readonly [number, string])[] {
  const n = (is: (d: Decided) => boolean): number => decided.filter(is).length;
  return [
    [n((d) => d.existingId !== null), 'already in your pipeline'],
    [n((d) => d.disposition === 'accepted' && d.existingId === null), 'already accepted'],
    [n((d) => d.disposition === 'dismissed'), 'already dismissed'],
  ];
}

/** What became of each location of a card, counted: "1 dismissed; 1 already in your pipeline". */
export function countParts(counts: readonly (readonly [number, string])[]): string {
  return counts
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${String(n)} ${what}`)
    .join('; ');
}
