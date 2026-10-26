// Posting candidates for one opportunity: the postings on a company's board, scored against the
// opportunity's title with FR-D7's titleOverlap so the same rule decides a discovery lead and an
// opportunity. Ranking only: nothing here attaches anything, and the caller decides what a score
// is worth (jobs/leadResolve's TITLE_MATCH_THRESHOLD is the confident bar).
//
// One role is often posted once per location. Those rows carry the same title and the same
// description, so they collapse to a single candidate for the location the user cares about,
// with the rest named on otherLocations.
import type { NormalizedPosting } from '@opportun/core';
import { titleOverlap } from '../jobs/leadResolve';

export interface PostingCandidate {
  posting: NormalizedPosting;
  /** Title overlap with the opportunity, 0 to 1. */
  score: number;
  /** Locations of the sibling postings this candidate stands for, in board order. */
  otherLocations: string[];
}

/** Description characters that decide whether two same-titled postings are one role. */
const SAME_ROLE_PREFIX = 200;
/** Whose location wins a collapse when nothing else is said. */
export const DEFAULT_PREFER_LOCATION = 'United States';

interface Group {
  chosen: NormalizedPosting;
  rest: NormalizedPosting[];
}

/** A posting with no description cannot be attached: there is nothing to read or tailor against. */
function isFull(posting: NormalizedPosting): boolean {
  return posting.descriptionMd != null && posting.descriptionMd.trim() !== '';
}

function roleKey(posting: NormalizedPosting): string {
  const body = (posting.descriptionMd ?? '').slice(0, SAME_ROLE_PREFIX);
  return `${posting.title.trim().toLowerCase()}\u0000${body}`;
}

/**
 * The board's postings as candidates, best title match first. Ties keep board order, so a caller
 * that passes the newest postings first sees the newest of an equal pair. `attachable` decides
 * which postings may be offered at all: by default only described ones, while a caller that can
 * describe a posting on demand (a Workday board row, FR-D10) widens it.
 */
export function rankCandidates(
  postings: readonly NormalizedPosting[],
  title: string,
  preferLocation: string = DEFAULT_PREFER_LOCATION,
  attachable: (posting: NormalizedPosting) => boolean = isFull,
): PostingCandidate[] {
  const prefer = preferLocation.toLowerCase();
  const preferred = (posting: NormalizedPosting): boolean =>
    prefer !== '' && (posting.location ?? '').toLowerCase().includes(prefer);
  const groups = new Map<string, Group>();
  for (const posting of postings) {
    if (!attachable(posting)) continue;
    const key = roleKey(posting);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { chosen: posting, rest: [] });
    } else if (preferred(posting) && !preferred(group.chosen)) {
      group.rest.push(group.chosen);
      group.chosen = posting;
    } else {
      group.rest.push(posting);
    }
  }
  return [...groups.values()]
    .map(({ chosen, rest }) => ({
      posting: chosen,
      score: titleOverlap(title, chosen.title),
      otherLocations: rest.map((p) => p.location ?? '').filter((l) => l !== ''),
    }))
    .sort((a, b) => b.score - a.score);
}
