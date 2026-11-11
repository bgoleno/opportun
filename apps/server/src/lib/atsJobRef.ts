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
import { greenhouseBoardJobUrl, greenhouseJidOf } from '@opportun/core';
import { boardFromUrl, type AtsBoard, type AtsKind } from '../jobs/atsDetect';

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
  /**
   * #398: set on an identity proven for a `gh_jid` link on a company's own page. Greenhouse's
   * API confirmed board `org` holds job `externalId`, and `url` is then that board's page for
   * it (greenhouseBoardJobUrl), never the company's link.
   */
  verifiedVia?: 'gh_jid';
  /** When that confirmation was made. */
  verifiedAt?: number;
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

/** The job a board URL's own path names (board host and path, never a query parameter). */
function fromBoardPath(board: AtsBoard, url: URL): Omit<AtsJobRef, 'url'> | null {
  const externalId = idFromPath(board.kind, url);
  if (externalId === null) return null;
  return {
    kind: board.kind,
    org: board.slug,
    ...(board.host === undefined ? {} : { host: board.host }),
    ...(board.kind === 'ats_workday' ? { externalPath: workdayPosting(url)?.externalPath } : {}),
    externalId,
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
    // On a recognised board host the board's own path names the job (tl on #151): a stray
    // `gh_jid` there may name another requisition, or (on Lever, Ashby, Workday) none of this
    // board's at all. It counts only when the path names no job, and only of the board's kind.
    // A `gh_jid` on any other host (a company career page) is read as before.
    const board = boardFromUrl(raw);
    let ref: Omit<AtsJobRef, 'url'> | null;
    if (board === null) {
      ref = fromGreenhouseJid(url);
    } else {
      ref = fromBoardPath(board, url);
      if (ref === null) {
        const jid = fromGreenhouseJid(url);
        ref = jid !== null && jid.kind === board.kind ? jid : null;
      }
    }
    if (ref === null) continue;
    const key = `${ref.kind}:${ref.org ?? ''}:${ref.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...ref, url: raw });
  }
  return out;
}

/**
 * The ATS identity a stored posting URL gives an opportunity (issue #137): its job reference,
 * only when the URL is a recognised ATS board host of the same kind; null for anything else,
 * including a company career page that embeds a board (`?gh_jid=`). Every writer of a posting
 * URL derives the identity here (attach, reconcile, a URL edit, a user's confirm, the backfill),
 * so no two paths can disagree. The board-host rule is the handoff's own (destinationAllowed in
 * repos/submissionReview.ts): a ref read from a career page would give a draft whose handoff
 * can never pass. The org is always the board's own slug, from the host and path: a Greenhouse
 * `board=` parameter can name another board than the path does, and the handoff compares the
 * destination's slug (tl on #140).
 */
export function postingAtsJobRef(postingUrl: string | null | undefined): AtsJobRef | null {
  if (postingUrl == null) return null;
  const board = boardFromUrl(postingUrl);
  if (board === null) return null;
  // extractAtsJobRefs reads a board URL's own path first (#143), as destinationAllowed does
  // through it: the two must name the same job, or a draft could never be handed off. On a board
  // host it only ever returns a ref of that board's kind, so no second kind check is needed here.
  const ref = extractAtsJobRefs(postingUrl, 1)[0];
  if (ref === undefined) return null;
  return { ...ref, org: board.slug };
}

/**
 * The identity a posting URL keeps, for the writers that ask nobody (#398 criterion 3: confirm,
 * the backfill, and every writer when no board read or Greenhouse check applies):
 * - a board-host URL gives its identity, as postingAtsJobRef;
 * - a link with a numeric `gh_jid` keeps `current` only while it is a verified `gh_jid` identity
 *   for that same job id, so a page of the company naming another job drops it;
 * - anything else gives none.
 * It never makes an identity up: only a board read (boardReadAtsJobRef) or Greenhouse's API
 * (lib/greenhouseEmbed) can.
 */
export function postingAtsJobRefKeeping(
  postingUrl: string | null | undefined,
  current: AtsJobRef | null | undefined,
): AtsJobRef | null {
  if (postingUrl == null) return null;
  if (boardFromUrl(postingUrl) !== null) return postingAtsJobRef(postingUrl);
  const jid = greenhouseJidOf(postingUrl);
  if (jid === null || current == null) return null;
  return current.kind === 'ats_greenhouse' &&
    current.verifiedVia === 'gh_jid' &&
    current.externalId === jid
    ? current
    : null;
}

/**
 * The identity of a posting that came out of a board read just made (tl on #398): reconcile, and
 * Find posting attaching a posting it read. An embedded Greenhouse board's API gives each posting
 * the company's careers link as its URL, so the read itself is the proof criterion 1 asks for:
 * - the token is the board that was read (`read.org`), never anything in the link (its `board=`
 *   parameter can name another board, #140);
 * - the id is the posting's own id in the API's answer, and it counts only when the link's
 *   numeric `gh_jid` is that id.
 * A board-host link gives its identity as postingAtsJobRef. Nothing else gives one here.
 */
export function boardReadAtsJobRef(
  posting: { postingUrl?: string | null; externalId?: string | null },
  read: { kind: string; org: string },
  at: number,
): AtsJobRef | null {
  const link = posting.postingUrl;
  if (link == null) return null;
  if (boardFromUrl(link) !== null) return postingAtsJobRef(link);
  if (read.kind !== 'ats_greenhouse' || posting.externalId == null) return null;
  const jid = greenhouseJidOf(link);
  if (jid === null || jid !== posting.externalId) return null;
  return verifiedGreenhouseRef(read.org, jid, at);
}

/** The identity recorded for a proven embedded job (#398 criteria 1 and 2). */
export function verifiedGreenhouseRef(token: string, jid: string, at: number): AtsJobRef | null {
  let url: string;
  try {
    url = greenhouseBoardJobUrl(token, jid);
  } catch {
    return null;
  }
  return {
    kind: 'ats_greenhouse',
    org: token,
    externalId: jid,
    url,
    verifiedVia: 'gh_jid',
    verifiedAt: at,
  };
}
