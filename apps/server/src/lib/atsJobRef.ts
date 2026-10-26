// ATS job references in free text: the board and job id a link identifies, so one posting can
// be fetched by its id instead of guessed from its title. This is FR-D7's idea applied to an
// opportunity the user already tracks: the link usually arrives in a recruiter's mail.
//
// Host matching is boardFromUrl's (jobs/atsDetect), which already rejects lookalike hosts,
// embed boards and escaped ampersands; this module adds the job id and the `gh_jid` form that
// company career pages use. LinkedIn is not an ATS host, so a LinkedIn job link never becomes
// a reference and is never fetched (constraint C-1).
//
// Workday (FR-D10) is addressed by tenant plus site, so its reference carries `org` =
// `<tenant>/<site>` and the tenant's `host` (whose datacenter label cannot be derived), and its
// job id is the requisition id at the end of the posting slug:
// `https://<tenant>.<dc>.myworkdayjobs.com[/<locale>]/<site>/job/<location>/<title>_<reqId>[/apply]`.
// Requisition ids are not all digits (`1000001`, `1000002-1`, `JR-000001`): the id is whatever
// follows the last underscore. Reading one needs no network at all.
import { boardFromUrl, type AtsKind } from '../jobs/atsDetect';

export interface AtsJobRef {
  kind: AtsKind;
  /**
   * The board slug when the link names one (Workday: `<tenant>/<site>`); null for a `gh_jid`
   * link on a company domain.
   */
  org: string | null;
  /** Workday only: the tenant's host, `<tenant>.<dc>.myworkdayjobs.com`. */
  host?: string;
  /** Workday only: the posting's CXS path (`/job/<location>/<title>_<reqId>`), when known. */
  externalPath?: string;
  externalId: string;
  /** The link the reference came from, with HTML escaping undone. */
  url: string;
}

/** Default number of references read from one text. */
const DEFAULT_MAX = 20;
/** Provider job ids are opaque; this is the shape a link may carry. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SLUG = /^[a-z0-9-]{1,100}$/;
const URLISH = /https?:\/\/[^\s"'<>)\]}]+/g;
const TRAILING = /[.,;:!?]+$/;

function segmentsOf(url: URL): string[] {
  return url.pathname.split('/').filter((s) => s.length > 0);
}

/**
 * The posting part of a Workday link: the segments after `/job/` or `/details/` up to and
 * including the `<title>_<reqId>` one (a location segment may precede it; `/apply` and the like
 * may follow). Workday's public career site uses either marker depending on tenant/version
 * (issue #20); the CXS detail endpoint's own path is `/job/...` regardless, which is why the
 * returned `externalPath` below always starts with `/job/` even when the link read `/details/`.
 */
export function workdayPosting(url: URL): { externalPath: string; reqId: string } | null {
  const seg = segmentsOf(url);
  const marker = seg.includes('job') ? 'job' : 'details';
  const at = seg.indexOf(marker);
  if (at < 1) return null;
  const after = seg.slice(at + 1);
  // `<location>/<title>_<reqId>` when the second segment carries a requisition, else `<title>_<reqId>`.
  const take = after[1]?.includes('_') === true ? 2 : after[0]?.includes('_') === true ? 1 : 0;
  if (take === 0) return null;
  const slug = after[take - 1] as string;
  const reqId = slug.slice(slug.lastIndexOf('_') + 1);
  if (!ID.test(reqId)) return null;
  return { externalPath: `/job/${after.slice(0, take).join('/')}`, reqId };
}

/** The job id a board link carries, by provider shape; null when the link names no single job. */
function idFromPath(kind: AtsJobRef['kind'], url: URL): string | null {
  if (kind === 'ats_workday') return workdayPosting(url)?.reqId ?? null;
  const seg = segmentsOf(url);
  const host = url.hostname.toLowerCase();
  let raw: string | undefined;
  if (kind === 'ats_greenhouse') {
    // boards.greenhouse.io/<org>/jobs/<id> and the API's /v1/boards/<org>/jobs/<id>.
    raw = seg[1] === 'jobs' ? seg[2] : seg[3] === 'jobs' ? seg[4] : undefined;
  } else if (kind === 'ats_lever' && host === 'jobs.lever.co') {
    raw = seg[1];
  } else if (kind === 'ats_ashby' && host === 'jobs.ashbyhq.com') {
    raw = seg[1];
  }
  return raw !== undefined && ID.test(raw) ? raw : null;
}

/** A `gh_jid` link: a Greenhouse job embedded in a page on any host, so boardFromUrl misses it. */
function fromGreenhouseJid(url: URL): Omit<AtsJobRef, 'url'> | null {
  const jid = url.searchParams.get('gh_jid');
  if (jid === null || !ID.test(jid)) return null;
  const board = url.searchParams.get('board')?.toLowerCase() ?? '';
  return {
    kind: 'ats_greenhouse',
    org: SLUG.test(board) ? board : null,
    externalId: jid,
  };
}

/**
 * The ATS job references in `text`, deduplicated by board and job id, in first-seen order.
 * A link that names a board but no single job is not a reference: nothing can be fetched by it.
 */
export function extractAtsJobRefs(text: string, max: number = DEFAULT_MAX): AtsJobRef[] {
  const out: AtsJobRef[] = [];
  const seen = new Set<string>();
  for (const match of text.replace(/&amp;/g, '&').matchAll(URLISH)) {
    if (out.length >= max) break;
    const raw = match[0].replace(TRAILING, '');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    let ref: Omit<AtsJobRef, 'url'> | null = fromGreenhouseJid(url);
    if (ref === null) {
      const board = boardFromUrl(raw);
      const externalId = board === null ? null : idFromPath(board.kind, url);
      ref =
        board === null || externalId === null
          ? null
          : {
              kind: board.kind,
              org: board.slug,
              ...(board.host === undefined ? {} : { host: board.host }),
              ...(board.kind === 'ats_workday'
                ? { externalPath: workdayPosting(url)?.externalPath }
                : {}),
              externalId,
            };
    }
    if (ref === null) continue;
    const key = `${ref.kind}:${ref.org ?? ''}:${ref.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ref, url: raw });
  }
  return out;
}
