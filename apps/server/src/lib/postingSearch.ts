// Finding the posting for an opportunity the user already tracks (FR-O1, built on FR-D7's
// machinery). Two signals, in this order:
//
//   1. the ATS job references in the opportunity's own linked messages: a recruiter's mail
//      usually carries the canonical link, and an id resolves exactly where a title cannot;
//   2. the company's ATS board, title-matched with jobs/leadResolve's titleOverlap.
//
// Nothing here writes: the caller decides what to attach (lib/postingAttach). A board that
// cannot be read is logged and skipped, so one unreachable provider still leaves the user the
// paste path. No posting URL from a message is ever fetched: only the adapters' own API hosts
// are, through sctx.fetch (safeFetch), which is what keeps prohibited hosts out (constraint C-1).
//
// A Workday board (FR-D10) is read from its listing only, since its descriptions cost one detail
// request per posting; the posting the flow settles on is then described from its detail
// endpoint (describeWorkdayPosting), as is a Workday candidate the user picks later.
import { AtsDetectTransientError, detectAts } from './atsDetect';
import { TITLE_MATCH_THRESHOLD } from './titleMatch';
import { boardConfig, boardFromUrl, boardOfSource } from './atsBoard';
import {
  greenhouseJidOf,
  NormalizedPostingSchema,
  workdayPosting,
  type NormalizedPosting,
} from '@opportun/core';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  ATS_SOURCE_KINDS,
  getSource,
  hasSource,
  SourceConfigError,
  type SourceContext,
  type SourceKind,
} from '../adapters/discoverySource';
import {
  fetchWorkdayDetail,
  mapWorkdayPosting,
  workdayBoard,
  readWorkdayListing,
} from '../sites/workday';
import type { Db } from '../db/client';
import { communications, discoverySources } from '../db/schema';
import type { AtsJobRefRecord } from '../db/schema.shared';
import type { UserCtx } from '../repos/base';
import { getCompany } from '../repos/companies';
import { splitConfig } from '../repos/discovery';
import {
  getOpportunity,
  searchBasisOf,
  type OpportunityView,
  type SearchBasis,
} from '../repos/opportunities';
import { atsJobRefOfUrl, extractAtsJobRefs, type AtsJobRef } from './atsJobRef';
import { rankCandidates, type PostingCandidate } from './postingCandidates';
import { sanitizePosting } from './postingSanitize';
import { racePoint } from './racePoints';

/** Reads one stored message body (the route hands over app.storage). */
export type BodyReader = (bodyRef: string) => Promise<string>;

/** A board read that may have been cut short (a large Workday board). */
export interface BoardListing {
  postings: NormalizedPosting[];
  /** The board's own posting count. */
  total: number;
  truncated: boolean;
}

/** The postings currently on one ATS board (its source config). Tests inject their own. */
export type BoardLookup = (
  sctx: SourceContext,
  kind: SourceKind,
  config: Record<string, unknown>,
) => Promise<NormalizedPosting[] | BoardListing>;

/** Messages whose bodies are read for references, newest first. */
const MAX_MAILS = 20;
/** Boards of the company's own consulted for one opportunity. */
const MAX_BOARDS = 4;
/** Boards named only by a link in the user's mail, read to resolve an id for confirmation. */
const MAX_REFERENCE_BOARDS = 2;
/** Postings read from one board (a Workday board is capped by MAX_WORKDAY_LOOKUP_PAGES). */
const MAX_BOARD = 2000;
/**
 * Candidates handed back for the user to look through. The search box is the only route to a
 * req whose title scores low against a generic stored title, so this has to be well past the
 * confident few or the box cannot honour its own promise.
 */
const MAX_SHOWN = 50;
/**
 * Workday listing pages read for one interactive lookup (20 postings each). A larger board is
 * cut short and the outcome says so; its other postings stay reachable by link or paste.
 */
export const MAX_WORKDAY_LOOKUP_PAGES = 10;

/**
 * The board a posting was read from just now (#398): its kind and slug. A posting out of a
 * Greenhouse board read is proven to be on that board, which is what an embedded job's identity
 * needs (lib/atsJobRef boardReadAtsJobRef). Absent when the posting came from no board read.
 */
export interface ReadFrom {
  kind: SourceKind;
  org: string;
}

/** What was found, without what it was found for. */
type Found = (
  | {
      status: 'exact';
      candidate: PostingCandidate;
      /** 'posting_link': the opportunity's own careers link named it (#398). */
      via: 'email_link' | 'posting_link';
      readFrom?: ReadFrom;
    }
  | { status: 'single'; candidate: PostingCandidate; via: 'board'; readFrom?: ReadFrom }
  | {
      status: 'candidates';
      candidates: PostingCandidate[];
      /** The rest of the board, ranked, so the picker can search past the confident ones. */
      board: PostingCandidate[];
      /** 'email_link_unverified': one posting a message pointed at, on a board the company
       *  does not own. It is offered for confirmation, never attached by the server. */
      via: 'board' | 'email_link_unverified';
    }
  | { status: 'none'; candidates: PostingCandidate[]; via: 'board' }
  /** The company has boards, and none of them could be read (#835): not "no match". */
  | { status: 'unreachable' }
  | { status: 'no_board'; needsCareersUrl: boolean }
) & {
  /** Said to the user beside the outcome (a large board read only in part). */
  note?: string;
};
/** `searchedFor`: what the search went by, as it read it (#892). */
export type FindOutcome = Found & { searchedFor: SearchBasis };

interface Board {
  kind: SourceKind;
  org: string;
  config: Record<string, unknown>;
}

/**
 * The default lookup: whatever adapter is registered for the kind (Greenhouse, Lever, Ashby),
 * except that a Workday board is read from its listing alone (no descriptions).
 */
export const adapterBoardLookup: BoardLookup = async (sctx, kind, config) => {
  if (kind === 'ats_workday') {
    const b = workdayBoard(config);
    const read = await readWorkdayListing(sctx, b, MAX_WORKDAY_LOOKUP_PAGES);
    return {
      postings: read.rows.map((row) => mapWorkdayPosting(b, row, null)),
      total: read.total,
      truncated: read.truncated,
    };
  }
  if (!hasSource(kind)) return [];
  const out: NormalizedPosting[] = [];
  for await (const item of getSource(kind).fetchPostings(sctx, config, null)) {
    out.push(item.posting);
    if (out.length >= MAX_BOARD) break;
  }
  return out;
};

/**
 * Sanitized postings that still satisfy the posting schema. An adapter can map an untitled job
 * to an empty title, which no schema accepts; the discovery and capture paths drop such rows the
 * same way (jobs/discoveryRun.ts, routes/capture.ts) rather than fail everything around them.
 */
function validPostings(raw: NormalizedPosting[]): NormalizedPosting[] {
  const out: NormalizedPosting[] = [];
  for (const posting of raw) {
    const parsed = NormalizedPostingSchema.safeParse(sanitizePosting(posting));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function isAtsKind(kind: string | null): kind is SourceKind {
  return kind !== null && (ATS_SOURCE_KINDS as readonly string[]).includes(kind);
}

const hasDescription = (p: NormalizedPosting): boolean =>
  p.descriptionMd != null && p.descriptionMd.trim() !== '';

/** Described already, or a Workday row whose description describeWorkdayPosting can fetch. */
const describable = (p: NormalizedPosting): boolean =>
  hasDescription(p) || (p.postingUrl != null && boardFromUrl(p.postingUrl)?.kind === 'ats_workday');

/**
 * A Workday posting with its description filled from the CXS detail endpoint, sanitized. Any
 * other posting, one already described, or one whose detail cannot be read (the service window,
 * a req taken down) comes back unchanged: the caller decides what an undescribed posting means.
 */
export async function describeWorkdayPosting(
  sctx: SourceContext,
  posting: NormalizedPosting,
): Promise<NormalizedPosting> {
  if (hasDescription(posting) || posting.postingUrl == null) return posting;
  const board = boardFromUrl(posting.postingUrl);
  if (board?.kind !== 'ats_workday') return posting;
  try {
    const path = workdayPosting(new URL(posting.postingUrl));
    if (path === null) return posting;
    const b = workdayBoard(boardConfig(board));
    const detail = await fetchWorkdayDetail(sctx, b, path.externalPath);
    if (detail === null) return posting;
    const listingRow = {
      title: posting.title,
      externalPath: path.externalPath,
      locationsText: posting.location,
      bulletFields: [posting.externalId ?? path.reqId],
    };
    const parsed = NormalizedPostingSchema.safeParse(
      sanitizePosting(mapWorkdayPosting(b, listingRow, detail)),
    );
    return parsed.success && hasDescription(parsed.data) ? parsed.data : posting;
  } catch (err) {
    sctx.log.warn({ err }, 'workday posting detail failed');
    return posting;
  }
}

/**
 * The references stored on a row, keeping only the kinds this build knows: the column is JSON
 * written by some version of the app, and an unknown kind would reach a board lookup that
 * cannot serve it.
 */
function storedRefs(stored: AtsJobRefRecord[] | null): AtsJobRef[] {
  if (stored === null) return [];
  const out: AtsJobRef[] = [];
  for (const row of stored) {
    const kind = row.kind;
    if (!isAtsKind(kind)) continue;
    out.push({ ...row, kind: kind as AtsJobRef['kind'] });
  }
  return out;
}

/** A message's text for reference extraction: its body if there still is one, else its snippet. */
async function mailText(
  row: { id: string; bodyRef: string | null; snippet: string | null },
  readBody: BodyReader,
  log: SourceContext['log'],
): Promise<string> {
  if (row.bodyRef === null) return row.snippet ?? '';
  try {
    return await readBody(row.bodyRef);
  } catch (err) {
    // A body that cannot be read costs this message, not the search.
    log.warn({ 'opportun.communication.id': row.id, err }, 'message body unreadable');
    return row.snippet ?? '';
  }
}

/** The ATS job references in the opportunity's linked messages, newest first, none rejected. */
async function refsFromMail(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  readBody: BodyReader,
  log: SourceContext['log'],
): Promise<AtsJobRef[]> {
  const rows = await db
    .select({
      id: communications.id,
      bodyRef: communications.bodyRef,
      snippet: communications.snippet,
      atsJobRefs: communications.atsJobRefs,
    })
    .from(communications)
    .where(
      and(
        eq(communications.userId, ctx.userId),
        eq(communications.opportunityId, opportunityId),
        isNull(communications.rejectedAt),
      ),
    )
    .orderBy(desc(communications.sentAt), desc(communications.id))
    .limit(MAX_MAILS)
    .all();
  const refs: AtsJobRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    // What ingest extracted comes first (design D-5): it was taken from the whole body, which
    // is no longer kept, and reading a body that is gone would silently lose a link that was
    // below the snippet. Rows ingested before D-5 have none, and fall through as they did.
    const stored = storedRefs(row.atsJobRefs);
    const found =
      stored.length > 0 ? stored : extractAtsJobRefs(await mailText(row, readBody, log));
    for (const ref of found) {
      const key = `${ref.kind}:${ref.org ?? ''}:${ref.externalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

/** The boards the company itself posts on: its verified board, then its ATS discovery sources. */
async function companyBoards(
  db: Db,
  ctx: UserCtx,
  company: { id: string; atsKind: string | null; atsRef: string | null },
): Promise<Board[]> {
  const out: Board[] = [];
  const seen = new Set<string>();
  const add = (kind: SourceKind, config: Record<string, unknown>): void => {
    const board = boardOfSource(kind, config);
    if (board === null || seen.has(`${kind}:${board.slug}`)) return;
    seen.add(`${kind}:${board.slug}`);
    out.push({ kind, org: board.slug, config: boardConfig(board) });
  };
  // A Workday ats_ref (`<tenant>/<site>`) lacks the host; its source below supplies the board.
  if (isAtsKind(company.atsKind) && company.atsKind !== 'ats_workday') {
    add(company.atsKind, { org: company.atsRef });
  }
  const sources = await db
    .select()
    .from(discoverySources)
    .where(
      and(
        eq(discoverySources.userId, ctx.userId),
        eq(discoverySources.companyId, company.id),
        inArray(discoverySources.kind, ATS_SOURCE_KINDS as SourceKind[]),
      ),
    )
    .all();
  for (const source of sources) add(source.kind, splitConfig(source).config);
  return out.slice(0, MAX_BOARDS);
}

/**
 * Boards named only by a link in the user's mail. A message can carry anyone's posting (a
 * forwarded referral, a recruiter listing other roles), so these boards resolve an id for the
 * user to confirm and never feed the title ranking: attaching another company's job description
 * silently is the one outcome worse than attaching nothing.
 */
function referenceBoards(refs: AtsJobRef[], owned: Board[]): Board[] {
  const ownedKeys = new Set(owned.map((b) => `${b.kind}:${b.org}`));
  const out: Board[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.org === null) continue;
    const key = `${ref.kind}:${ref.org}`;
    if (ownedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    const board = {
      kind: ref.kind,
      slug: ref.org,
      ...(ref.host === undefined ? {} : { host: ref.host }),
    };
    let config: Record<string, unknown>;
    try {
      config = boardConfig(board);
    } catch (err) {
      // A stored reference that names no board: there is none to read, and the others still are.
      if (!(err instanceof SourceConfigError)) throw err;
      continue;
    }
    out.push({ kind: ref.kind, org: ref.org, config });
    if (out.length >= MAX_REFERENCE_BOARDS) break;
  }
  return out;
}

interface BoardRead {
  board: Board;
  postings: NormalizedPosting[];
  /** Set when the read was cut short: how many postings were read of how many. */
  cut?: { shown: number; total: number };
}

/** Reads each board; one that cannot be read is logged and skipped, never fatal. */
async function readBoards(
  sctx: SourceContext,
  lookup: BoardLookup,
  boards: Board[],
): Promise<BoardRead[]> {
  const reads: BoardRead[] = [];
  for (const board of boards) {
    try {
      const read = await lookup(sctx, board.kind, board.config);
      if (Array.isArray(read)) {
        reads.push({ board, postings: validPostings(read) });
      } else {
        const postings = validPostings(read.postings);
        reads.push({
          board,
          postings,
          ...(read.truncated ? { cut: { shown: read.postings.length, total: read.total } } : {}),
        });
      }
    } catch (err) {
      sctx.log.warn({ err }, 'posting search board lookup failed');
    }
  }
  return reads;
}

/**
 * The posting a reference names. References are tried in their own order (newest message first)
 * across every board, so when an opportunity's messages name two reqs the one the user heard
 * about last wins. A reference with no board of its own (a bare `gh_jid` link on a company
 * page) matches any board of its provider.
 */
function referenceHit(
  reads: BoardRead[],
  refs: AtsJobRef[],
): { posting: NormalizedPosting; board: Board } | null {
  for (const ref of refs) {
    const wanted = ref.externalId.toLowerCase();
    for (const read of reads) {
      if (read.board.kind !== ref.kind) continue;
      const hit = read.postings.find(
        (p) =>
          p.externalId != null &&
          p.externalId.toLowerCase() === wanted &&
          // The board read, or the board the posting's own link names (qa and tl on #830): an
          // identity's org is the slug of its link (postingAtsJobRef, tl on #140: the handoff
          // compares it), which can be another spelling than the board's token (vandelay on the
          // vandelayindustries board). Either one is this job.
          (ref.org === null ||
            ref.org === read.board.org ||
            ref.org === postingUrlSlug(p.postingUrl)),
      );
      if (hit !== undefined) return { posting: hit, board: read.board };
    }
  }
  return null;
}

/** The board slug a posting's own link names, if it is a board-host link. */
function postingUrlSlug(url: string | null | undefined): string | null {
  return url == null ? null : (boardFromUrl(url)?.slug ?? null);
}

/**
 * The Greenhouse job an opportunity's own posting link names, when it is a careers page carrying
 * a numeric `gh_jid` and the opportunity has no identity yet (#398). Its board is unknown (org
 * null), so only the company's own boards can match it. Nothing is asked of Greenhouse for this
 * when an opportunity is created or its mail is read: Find posting, or a new link, is when the
 * server looks (tl on #414).
 */
export function ownGreenhouseRef(opp: {
  postingUrl?: string | null;
  atsJobRef?: AtsJobRef | null;
}): AtsJobRef | null {
  const link = opp.postingUrl;
  if (link == null || opp.atsJobRef != null || boardFromUrl(link) !== null) return null;
  const jid = greenhouseJidOf(link);
  return jid === null ? null : { kind: 'ats_greenhouse', org: null, externalId: jid, url: link };
}

/**
 * The job the opportunity itself names (qa and tl on #804): its stored identity, else the job its
 * own posting link names on a board, else the Greenhouse `gh_jid` its careers link carries. Found
 * on a board that was read, it is the posting; missing there, no title match stands in for it.
 */
export function ownJobRef(opp: {
  postingUrl?: string | null;
  atsJobRef?: AtsJobRef | null;
}): AtsJobRef | null {
  if (opp.atsJobRef != null) return opp.atsJobRef;
  const link = opp.postingUrl;
  if (link == null) return null;
  return atsJobRefOfUrl(link) ?? ownGreenhouseRef(opp);
}

/** The board a posting of `reads` came from, by identity: ranking keeps the posting objects. */
function readFromOf(reads: BoardRead[], posting: NormalizedPosting): ReadFrom | undefined {
  const read = reads.find((r) => r.postings.includes(posting));
  return read === undefined ? undefined : { kind: read.board.kind, org: read.board.org };
}

/**
 * The posting a Workday reference names, from its detail endpoint directly: the link carries
 * the posting's path, so no listing needs reading. Null when the reference has no path, the
 * posting is gone, or the detail cannot be read (the caller falls back to the listing).
 */
async function directWorkdayPosting(
  sctx: SourceContext,
  ref: AtsJobRef,
): Promise<NormalizedPosting | null> {
  if (ref.kind !== 'ats_workday' || ref.org === null || ref.host === undefined) return null;
  if (ref.externalPath === undefined) return null;
  try {
    const b = workdayBoard(boardConfig({ kind: ref.kind, slug: ref.org, host: ref.host }));
    const detail = await fetchWorkdayDetail(sctx, b, ref.externalPath);
    if (detail === null) return null;
    const row = { externalPath: ref.externalPath, bulletFields: [ref.externalId] };
    const parsed = NormalizedPostingSchema.safeParse(
      sanitizePosting(mapWorkdayPosting(b, row, detail)),
    );
    return parsed.success && hasDescription(parsed.data) ? parsed.data : null;
  } catch (err) {
    sctx.log.warn({ err }, 'workday posting detail failed');
    return null;
  }
}

/** The first Workday reference, in reference order, on one of `boards` that resolves directly. */
async function directWorkdayHit(
  sctx: SourceContext,
  refs: AtsJobRef[],
  boards: Board[],
): Promise<NormalizedPosting | null> {
  const keys = new Set(boards.map((b) => `${b.kind}:${b.org}`));
  for (const ref of refs) {
    if (ref.kind !== 'ats_workday' || !keys.has(`${ref.kind}:${ref.org ?? ''}`)) continue;
    const posting = await directWorkdayPosting(sctx, ref);
    if (posting !== null) return posting;
  }
  return null;
}

const exactly = (posting: NormalizedPosting): PostingCandidate => ({
  posting,
  score: 1,
  otherLocations: [],
});

/**
 * The posting for one of the user's opportunities: resolved from a linked message's job id, or
 * the ranked candidates from the company's own board. Throws 404 when the opportunity is not the
 * caller's (getOpportunity).
 */
export async function findPosting(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  sctx: SourceContext,
  opts: { readBody: BodyReader; board?: BoardLookup },
): Promise<FindOutcome> {
  await racePoint('posting.search');
  const opp = await getOpportunity(db, ctx, opportunityId);
  return { ...(await search(db, ctx, opp, sctx, opts)), searchedFor: searchBasisOf(opp) };
}

async function search(
  db: Db,
  ctx: UserCtx,
  opp: OpportunityView,
  sctx: SourceContext,
  opts: { readBody: BodyReader; board?: BoardLookup },
): Promise<Found> {
  const lookup = opts.board ?? adapterBoardLookup;
  const company = await getCompany(db, ctx, opp.companyId);
  const refs = await refsFromMail(db, ctx, opp.id, opts.readBody, sctx.log);
  let owned = await companyBoards(db, ctx, company);
  /** Detection could not finish, so whether the company has a board is not known (#866). */
  let detectionFailed = false;
  if (owned.length === 0) {
    // FR-D9 detection, only when the company has no board on record.
    try {
      const detected = await detectAts(db, ctx, company.id, sctx);
      if (detected.status === 'found') {
        const board = {
          kind: detected.kind,
          slug: detected.org,
          ...(detected.host === undefined ? {} : { host: detected.host }),
        };
        owned = [{ kind: detected.kind, org: detected.org, config: boardConfig(board) }];
      }
    } catch (err) {
      // A transient probe failure is not a verdict: "no board" would say the company has none. It
      // is tried again, as a board that could not be read is, and the panel keeps the paste path.
      if (!(err instanceof AtsDetectTransientError)) throw err;
      detectionFailed = true;
      sctx.log.warn({ 'opportun.company.id': company.id, err }, 'ats detection failed');
    }
  }
  const foreign = referenceBoards(refs, owned);
  const noBoard = (): Found =>
    detectionFailed
      ? { status: 'unreachable' }
      : { status: 'no_board', needsCareersUrl: company.careersUrl == null };
  if (owned.length === 0 && foreign.length === 0) return noBoard();

  /** An undescribed posting cannot be attached: the user is shown it to pick or paste for. */
  const unattachable = (candidate: PostingCandidate): Found => ({
    status: 'candidates',
    candidates: [candidate],
    board: [candidate],
    via: 'board',
  });

  // A Workday link names its posting's path: its detail answers without a listing read.
  const direct = await directWorkdayHit(sctx, refs, owned);
  if (direct !== null) return { status: 'exact', candidate: exactly(direct), via: 'email_link' };

  const reads = await readBoards(sctx, lookup, owned);
  // Every board failed to read (a network error, a timeout, a 5xx: #835, qa on #830). That is not
  // "no close match", which would say the board was read; it is said as such, and tried again.
  // Only when nothing a message names could stand in: a reference from another board still can.
  if (owned.length > 0 && reads.length === 0 && foreign.length === 0) {
    return { status: 'unreachable' };
  }
  const cut = reads.find((r) => r.cut !== undefined)?.cut;
  let note: { note?: string } =
    cut === undefined
      ? {}
      : {
          note: `Large Workday board: showing the first ${cut.shown} of ${cut.total} postings. Paste the posting link or text if yours is not among them.`,
        };
  // The opportunity's own job (ownJobRef: its stored identity, its board link, or its careers
  // link's gh_jid, #398 and tl on #414 and #804): that job on the company's own board is the
  // posting, ahead of any message's link and any title match, and the read is the proof of its
  // board. Only the company's own boards are searched for it.
  const ownRef = ownJobRef(opp);
  const own = ownRef === null ? null : referenceHit(reads, [ownRef]);
  if (own !== null) {
    const candidate = exactly(own.posting);
    const readFrom = { kind: own.board.kind, org: own.board.org };
    return hasDescription(candidate.posting)
      ? { status: 'exact', candidate, via: 'posting_link', readFrom }
      : unattachable(candidate);
  }

  // The opportunity names a job the company's boards were read without (qa and tl on #414 and
  // #804): any other posting found below is for the user to choose, never attached or confirmed by
  // itself, or a title match would swap its identity for another job's. Boards that could not be
  // read at all change nothing.
  const ownMissed = ownRef !== null && reads.length > 0;
  if (ownMissed) {
    // Said with whatever is offered (#812, tl): the job this opportunity names is not there now.
    const missing = "The job this opportunity names isn't on the company's board now.";
    note = { note: note.note === undefined ? missing : `${missing} ${note.note}` };
  }

  const hit = referenceHit(reads, refs);
  if (hit !== null) {
    const candidate = exactly(await describeWorkdayPosting(sctx, hit.posting));
    const readFrom = { kind: hit.board.kind, org: hit.board.org };
    if (ownMissed) return { ...unattachable(candidate), ...note };
    return hasDescription(candidate.posting)
      ? { status: 'exact', candidate, via: 'email_link', readFrom }
      : unattachable(candidate);
  }

  if (foreign.length > 0) {
    const elsewhere =
      (await directWorkdayHit(sctx, refs, foreign)) ??
      referenceHit(await readBoards(sctx, lookup, foreign), refs)?.posting ??
      null;
    if (elsewhere !== null) {
      const candidate = exactly(await describeWorkdayPosting(sctx, elsewhere));
      return {
        status: 'candidates',
        candidates: [candidate],
        board: [candidate],
        via: 'email_link_unverified',
      };
    }
  }
  if (owned.length === 0) return noBoard();

  const ranked = rankCandidates(
    reads.flatMap((r) => r.postings),
    opp.title,
    undefined,
    describable,
  );
  const confident = ranked.filter((c) => c.score >= TITLE_MATCH_THRESHOLD);
  // A perfect title match (#235): the raw overlap score, never the UI's rounded percentage, since
  // titleOverlap is always an exact ratio of shared to larger token-set size, so `=== 1` only
  // holds when the sets truly match (no epsilon needed: n/n is exactly 1.0 in IEEE-754 for any
  // nonzero integer n). Exactly one such candidate outvotes its own lesser siblings rather than
  // being outvoted by them; two or more stay ambiguous, same as today, since nothing here can
  // tell them apart. If titleOverlap ever becomes a continuous score instead of a token-count
  // ratio, this `=== 1` stops being safe and needs an epsilon (or a different signal) again.
  const perfect = confident.filter((c) => c.score === 1);
  const [best] = confident;
  if (best !== undefined && !ownMissed && (perfect.length === 1 || confident.length === 1)) {
    const readFrom = readFromOf(reads, best.posting);
    const candidate = { ...best, posting: await describeWorkdayPosting(sctx, best.posting) };
    return hasDescription(candidate.posting)
      ? {
          status: 'single',
          candidate,
          via: 'board',
          ...(readFrom === undefined ? {} : { readFrom }),
          ...note,
        }
      : { ...unattachable(candidate), ...note };
  }
  if (confident.length > 1 || (ownMissed && confident.length > 0)) {
    return {
      status: 'candidates',
      candidates: confident.slice(0, MAX_SHOWN),
      board: ranked.slice(0, MAX_SHOWN),
      via: 'board',
      ...note,
    };
  }
  return { status: 'none', candidates: ranked.slice(0, MAX_SHOWN), via: 'board', ...note };
}
