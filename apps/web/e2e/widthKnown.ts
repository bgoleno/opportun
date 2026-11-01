// The views that do not meet the desktop width standard yet (desktop.spec.ts, issue
// https://github.com/bgoleno/opportun/issues/33), with the issue that fixes each and the exact
// findings it excuses. Every other finding on these views still fails, and an excuse that stops
// matching fails too, so this list can only shrink: a fix removes its excuses.
import { line, WIDTHS, type Excuse } from './widthStandard';

/** The tailoring chat in its own column, capped when stacked (W4). */
export const CHAT_COLUMN = 'https://github.com/bgoleno/opportun/issues/35';

/**
 * Views that do not meet the standard yet, by test title (the route, or a seeded view's name),
 * with the issue that fixes them and the findings that excuses. Taken from the CI run on
 * https://github.com/bgoleno/opportun/pull/52 before this list existed (run 41293141446, the
 * same on both e2e legs): every one is a wrapped line wider than the spec's 80ch limit.
 */
export const KNOWN = new Map<string, { issue: string; excuses: readonly Excuse[] }>([
  // The user's chat message and a suggestion's rationale. The document text and the match report
  // already wrap at reading width. The assistant's message was excused here too until
  // https://github.com/bgoleno/opportun/issues/34 set the reading width once in the shared
  // Markdown component it renders through, which cleared it.
  [
    '/resumes/:id with text, a conversation and a match report',
    {
      issue: CHAT_COLUMN,
      excuses: [
        line('p', 'Emphasize the platform work for this role.', WIDTHS),
        line('p', 'You will own the platform that every product', WIDTHS),
      ],
    },
  ],
]);
