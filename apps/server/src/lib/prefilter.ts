// The discovery pre-filter (https://github.com/bgoleno/opportun/issues/217, tl's proposal section 4
// on #190): whether a new board posting is worth a ranking call, judged in process from its
// title, location and remote setting against the user's role targets. Pure, no AI and no I/O.
//
// Shadow mode: the verdict is stored on the result and measured (its recall on the user's own
// accepted postings), and acts on nothing. Every posting is still ranked as before; N2b (#218)
// turns it on once the recall holds.
//
// Built for recall (a missed good posting costs more than a wasted call): a rule only filters on
// what the posting states. A posting with no location, or no remote setting, is not filtered for
// it, and a title passes when at least half of a variant's words are in it.
import type {
  NormalizedPosting,
  PrefilterOutcome,
  PrefilterRule,
  RemotePref,
} from '@opportun/core';

/** A title passes when its score (0 to 1) is at least this. */
export const TITLE_PASS_SCORE = 0.5;

/** The parts of a role target the filter reads. */
export interface PrefilterTarget {
  name: string;
  titleFamily: string;
  titleVariants: readonly string[];
  locations: readonly string[];
  remotePref: RemotePref;
}

export interface PrefilterVerdict {
  outcome: PrefilterOutcome;
  /** The rule that filtered it; null when it passed. */
  rule: PrefilterRule | null;
  /** The best title match over the targets, 0 to 1, two decimals. */
  score: number;
}

/**
 * Words that say nothing about which job it is: seniority and level, and small words. "Senior
 * Platform Engineer" is a "Platform Engineer" for the title rule; seniority is the ranker's call.
 */
const IGNORED = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'to',
  'in',
  'at',
  'on',
  'with',
  'or',
  'senior',
  'sr',
  'junior',
  'jr',
  'staff',
  'principal',
  'lead',
  'chief',
  'head',
  'associate',
  'intern',
  'entry',
  'level',
  'mid',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
]);

/** A text's words, lower case, accents folded, punctuation dropped, ignored words removed. */
export function titleWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !IGNORED.has(w));
}

/** The share of a phrase's words found in the title, best over the phrases (0 when none). */
export function titleScore(postingTitle: string, phrases: readonly string[]): number {
  const words = new Set(titleWords(postingTitle));
  let best = 0;
  for (const phrase of phrases) {
    const want = [...new Set(titleWords(phrase))];
    if (want.length === 0) continue;
    const hit = want.filter((w) => words.has(w)).length;
    best = Math.max(best, hit / want.length);
  }
  return Math.round(best * 100) / 100;
}

/** Whether the posting's remote setting rules it out for this target, from what it states. */
function remoteRefuses(posting: NormalizedPosting, pref: RemotePref): boolean {
  if (posting.remote === true) return pref === 'onsite';
  if (posting.remote === false) return pref === 'remote';
  return false;
}

/**
 * Whether the posting's stated location is none of the target's places. A target with no places,
 * a posting that states none, and a remote posting the target would take, all pass. A place
 * matches when all its words (before any comma: "Austin, TX" is "austin") are in the posting's
 * location.
 */
function locationRefuses(posting: NormalizedPosting, target: PrefilterTarget): boolean {
  if (target.locations.length === 0) return false;
  if (posting.remote === true && target.remotePref !== 'onsite') return false;
  const stated = posting.location?.trim() ?? '';
  if (stated === '') return false;
  const here = new Set(titleWords(stated));
  if (here.has('remote') && target.remotePref !== 'onsite') return false;
  return !target.locations.some((place) => {
    const words = titleWords(place.split(',')[0] ?? '');
    return words.length > 0 && words.every((w) => here.has(w));
  });
}

/** One target's verdict: the title first, then remote, then location. */
function judgeFor(posting: NormalizedPosting, target: PrefilterTarget): PrefilterVerdict {
  const score = titleScore(posting.title, [
    target.name,
    target.titleFamily,
    ...target.titleVariants,
  ]);
  const rule: PrefilterRule | null =
    score < TITLE_PASS_SCORE
      ? 'title'
      : remoteRefuses(posting, target.remotePref)
        ? 'remote'
        : locationRefuses(posting, target)
          ? 'location'
          : null;
  return { outcome: rule === null ? 'pass' : 'filtered', rule, score };
}

/**
 * The verdict over the role targets a source ranks against: it passes when any target passes.
 * Otherwise it is filtered by the rule of the target its title matches best. Null with no target
 * to judge against (the user has none active): nothing can be said.
 */
export function prefilter(
  posting: NormalizedPosting,
  targets: readonly PrefilterTarget[],
): PrefilterVerdict | null {
  if (targets.length === 0) return null;
  const verdicts = targets.map((t) => judgeFor(posting, t));
  const best = Math.max(...verdicts.map((v) => v.score));
  const passed = verdicts.find((v) => v.outcome === 'pass');
  if (passed !== undefined) return { outcome: 'pass', rule: null, score: best };
  const closest = verdicts.find((v) => v.score === best) ?? verdicts[0]!;
  return { outcome: 'filtered', rule: closest.rule, score: best };
}
