// The views that do not meet the desktop width standard yet (desktop.spec.ts, issue
// https://github.com/bgoleno/opportun/issues/33), with the issue that fixes each and the exact
// findings it excuses. Every other finding on these views still fails, and an excuse that stops
// matching fails too, so this list can only shrink: a fix removes its excuses.
import type { Excuse } from './widthStandard';

/**
 * Views that do not meet the standard yet, by test title (the route, or a seeded view's name),
 * with the issue that fixes them and the findings that excuses. Taken from the CI run on
 * https://github.com/bgoleno/opportun/pull/52 before this list existed (run 41293141446, the
 * same on both e2e legs): every one is a wrapped line wider than the spec's 80ch limit.
 *
 * Empty: every view meets the standard. Add an entry with `line()` from widthStandard.ts only for
 * a known exception with an open issue that fixes it.
 */
export const KNOWN = new Map<string, { issue: string; excuses: readonly Excuse[] }>([
  // The resume workspace's chat messages and a suggestion's rationale were the last entry, until
  // https://github.com/bgoleno/opportun/issues/35 gave the chat its own 28rem column and capped
  // each bubble at reading width. (The assistant's message had already been cleared by
  // https://github.com/bgoleno/opportun/issues/34, through the shared Markdown component.)
]);
