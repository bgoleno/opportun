// The job an opportunity names (https://github.com/bgoleno/opportun/issues/1055, #1057): by its stored
// posting identity, else by its posting link. One comparison for the server's mark and the screens'
// notice, so they cannot disagree.
import { ATS_SITES, type SiteUrl } from './index';

// core compiles without DOM or node types; WHATWG URL is a global in every runtime it serves (as in
// greenhouseJid.ts).
declare const URL: new (input: string) => SiteUrl;

export interface NamedJob {
  kind: string;
  /** The board, where the link names one. */
  org: string | null;
  externalId: string;
}

/** The job an application was started for, which it keeps. */
export interface PinnedJob {
  atsKind: string;
  atsRef: string | null;
  atsExternalId: string;
}

/**
 * The job a link names on an ATS board, or a Greenhouse job a careers page names (`gh_jid`); null for
 * anything else. The server's atsJobRefOfUrl reads the same (apps/server/test/namedJob.test.ts).
 */
export function jobNamedByLink(link: string): NamedJob | null {
  let url: SiteUrl;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const site = ATS_SITES.find((s) => s.board!.fromUrl(url) !== null);
  if (site === undefined) {
    for (const s of ATS_SITES) {
      const job = s.embeddedJobFromUrl?.(url) ?? null;
      if (job !== null) return { kind: s.sourceKind!, org: job.board, externalId: job.id };
    }
    return null;
  }
  const job = site.jobFromUrl(url) ?? site.embeddedJobFromUrl?.(url) ?? null;
  if (job === null) return null;
  return { kind: site.sourceKind!, org: job.board, externalId: job.id };
}

/**
 * How the job an opportunity names stands to the one an application is for. A careers page's `gh_jid`
 * names its job and no board, where the application has the board's: that is no difference, so the kind
 * and the job id decide (tl). A stored identity is compared whole, the board without case.
 */
export function namedAgainst(
  opp: { atsJobRef: NamedJob | null | undefined; postingUrl: string | null },
  pinned: PinnedJob,
  readLink: (link: string) => NamedJob | null = jobNamedByLink,
): 'same' | 'another' | 'none' {
  const stored = opp.atsJobRef ?? null;
  const job = stored ?? (opp.postingUrl === null ? null : readLink(opp.postingUrl));
  if (job === null) return 'none';
  if (job.kind !== pinned.atsKind || job.externalId !== pinned.atsExternalId) return 'another';
  if (stored === null && job.org === null) return 'same';
  return (job.org ?? '').toLowerCase() === (pinned.atsRef ?? '').toLowerCase() ? 'same' : 'another';
}
