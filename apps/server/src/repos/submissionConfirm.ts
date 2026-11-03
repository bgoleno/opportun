// Confirmation email matching, the wiring (assisted apply M2b,
// https://github.com/bgoleno/opportun/issues/119; design Part A 5.3, tl's cut on #119).
//
// Mail ingest (jobs/mailIngest.ts) reads the candidates before its transaction, runs the pure
// matcher (lib/submissionMatch.ts), and on a single match calls confirmFromEmail inside the
// transaction that stores the message, after taking the attempt's lock first. The body is read
// there and never stored: what an attempt keeps is the message's id and the names of the signals
// that matched (NFR-PRV5). An email confirmation changes no stage, and the user can undo it
// (unlinkConfirmation): signal B is the sender's unauthenticated address (sec on #128).
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { lockScope, withTransaction } from '../db/client';
import {
  activities,
  applicationSubmissions,
  communications,
  companies,
  nextSteps,
  opportunities,
} from '../db/schema';
import { WORKDAY_HOST } from '../adapters/discoverySource';
import { boardFromUrl } from '../jobs/atsDetect';
import { extractAtsJobRefs } from '../lib/atsJobRef';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { racePoint } from '../lib/racePoints';
import { isPageFetchProhibited } from '../lib/safeFetch';
import { cleanText } from '../lib/safeText';
import {
  CONFIRMATION_SKEW_MS,
  CONFIRMATION_WINDOW_MS,
  type ConfirmationCandidate,
  type ConfirmationSignal,
} from '../lib/submissionMatch';
import { senderAddress } from '../adapters/sources/alertEmail';
import { createActivity } from './activities';
import type { Db, Exec, UserCtx } from './base';
import { submissionScope } from './submissionReview';
import { getRow, notNow, owned, view, type SubmissionRow } from './submissions';
import type { Submission } from '@opportun/core';

/** The attempts an email may confirm: submitted or with no confirmation seen. */
const AWAITING = ['submitted', 'unknown'] as const;

/** What an email confirmation stores: the names of the signals that matched, nothing else. */
export interface EmailConfirmationBasis {
  signals: ConfirmationSignal[];
}

function emailBasis(value: unknown): EmailConfirmationBasis | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<EmailConfirmationBasis>;
  return Array.isArray(v.signals) ? { signals: v.signals } : null;
}

/**
 * The user's attempts awaiting a confirmation whose window (D) covers a message sent at
 * `sentAt`: submitted no later than 5 minutes after it and no earlier than 14 days before it.
 * One query, read before ingest's transaction; confirmFromEmail re-checks the status under the
 * attempt's lock.
 */
export async function confirmationCandidates(
  exec: Exec,
  ctx: UserCtx,
  sentAt: number,
): Promise<ConfirmationCandidate[]> {
  const rows = await exec
    .select({
      id: applicationSubmissions.id,
      atsKind: applicationSubmissions.atsKind,
      atsRef: applicationSubmissions.atsRef,
      atsExternalId: applicationSubmissions.atsExternalId,
      submittedAt: applicationSubmissions.submittedAt,
      roleTitle: opportunities.title,
      companyName: companies.name,
      companyDomain: companies.domain,
    })
    .from(applicationSubmissions)
    .innerJoin(opportunities, eq(opportunities.id, applicationSubmissions.opportunityId))
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(
      and(
        eq(applicationSubmissions.userId, ctx.userId),
        inArray(applicationSubmissions.status, [...AWAITING]),
        lte(applicationSubmissions.submittedAt, sentAt + CONFIRMATION_SKEW_MS),
        gte(applicationSubmissions.submittedAt, sentAt - CONFIRMATION_WINDOW_MS),
      ),
    )
    .all();
  return rows.flatMap((r) =>
    r.submittedAt === null ? [] : [{ ...r, submittedAt: r.submittedAt }],
  );
}

/**
 * Confirms one attempt from a matched email, inside ingest's transaction. The caller has taken
 * `submission:<id>` before anything else in that transaction (the order at submissionScope).
 * Returns false, writing nothing, when the attempt no longer awaits a confirmation (the user
 * recorded an outcome first): then the message is not linked either (tl on #119).
 */
export async function confirmFromEmail(
  tx: Exec,
  ctx: UserCtx,
  submissionId: string,
  communicationId: string,
  signals: ConfirmationSignal[],
  now: number,
): Promise<boolean> {
  const current = await tx
    .select()
    .from(applicationSubmissions)
    .where(owned(ctx, submissionId))
    .get();
  if (current === undefined || !(AWAITING as readonly string[]).includes(current.status)) {
    return false;
  }
  const basis: EmailConfirmationBasis = { signals: [...signals] };
  const [updated] = await tx
    .update(applicationSubmissions)
    .set({
      status: 'confirmed',
      confirmedAt: now,
      confirmationKind: 'email',
      confirmationCommId: communicationId,
      confirmationBasis: basis,
      updatedAt: now,
    })
    .where(and(owned(ctx, submissionId), eq(applicationSubmissions.status, current.status)))
    .returning();
  if (updated === undefined) return false;
  // The attempt row is now locked by this transaction (tests park a merge or a delete here).
  await racePoint('submissions.confirm.updated');
  // The message itself is not written: the attempt refers to it by confirmation_comm_id, and
  // the evidence card reads it from there. A confirmation found by matching an unauthenticated
  // sender does not place the message on the opportunity, or its thread with it (tl and sec on
  // https://github.com/bgoleno/opportun/pull/173); the classifier and the user decide that, as
  // for any other message.
  // The follow-up's "Check whether…" step has its answer (#148's rule): done if still open; a
  // step the user completed keeps its own time.
  if (current.followupNextStepId !== null) {
    await tx
      .update(nextSteps)
      .set({ doneAt: now, updatedAt: now })
      .where(
        and(
          eq(nextSteps.id, current.followupNextStepId),
          eq(nextSteps.userId, ctx.userId),
          isNull(nextSteps.doneAt),
        ),
      )
      .run();
  }
  await audit(tx, 'submission.confirmed', {
    userId: ctx.userId,
    detail: {
      submissionId,
      opportunityId: current.opportunityId,
      from: current.status,
      kind: 'email',
      communicationId,
      signals: [...signals],
    },
  });
  return true;
}

/** A page URL's host for an audit entry or a title: never its path or query (tl on #182). */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Whether a page may confirm an attempt, or why not (confirmationPageVerdict). */
export type ConfirmationPageVerdict = 'ok' | 'wrong_site' | 'different_job';

/**
 * Whether `pageUrl` may confirm this attempt: the one rule for both the extension's lookup and
 * the recording itself (tl on #121: one function, not a copy).
 *
 * The site (tl's ruling 3 on #121, made stricter where a board host is shared):
 * - A page that names an ATS board (boardFromUrl) counts only when it is the attempt's board:
 *   the same ATS, and the attempt's board or tenant whatever its case. So Greenhouse's thank-you
 *   page on job-boards.greenhouse.io counts for an attempt opened on boards.greenhouse.io.
 * - A page that names no board counts only on the destination's own origin, and only where that
 *   origin is the employer's alone: a Workday tenant's host. boards.greenhouse.io, jobs.lever.co
 *   and jobs.ashbyhq.com serve every employer, so "the same origin" there would let another
 *   employer's page through.
 * - https only, no credentials, and never a host the server may not read pages from (LinkedIn,
 *   Indeed), which boardFromUrl never names either.
 *
 * The job (tl, from qa's PASS on https://github.com/bgoleno/opportun/pull/188): a page on the
 * right site whose address names a job of that ATS (extractAtsJobRefs) other than the attempt's
 * is another job's page: `different_job`. One that names no job counts, as does the posting
 * page itself (Ashby may show its confirmation at the posting's address).
 */
export function confirmationPageVerdict(
  pageUrl: string,
  sub: Pick<SubmissionRow, 'destinationUrl' | 'atsKind' | 'atsRef' | 'atsExternalId'>,
): ConfirmationPageVerdict {
  let url: URL;
  let destination: URL;
  try {
    url = new URL(pageUrl);
    destination = new URL(sub.destinationUrl);
  } catch {
    return 'wrong_site';
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return 'wrong_site';
  if (isPageFetchProhibited(url.hostname)) return 'wrong_site';
  const board = boardFromUrl(url.href);
  const site =
    board !== null
      ? board.kind === sub.atsKind &&
        sub.atsRef !== null &&
        board.slug.toLowerCase() === sub.atsRef.toLowerCase()
      : url.origin === destination.origin && WORKDAY_HOST.test(url.hostname);
  if (!site) return 'wrong_site';
  const jobs = extractAtsJobRefs(url.href).filter((r) => r.kind === sub.atsKind);
  if (jobs.length > 0 && !jobs.some((r) => r.externalId === sub.atsExternalId)) {
    return 'different_job';
  }
  return 'ok';
}

/** The refusal for a page that may not confirm the attempt. */
function verdictRefusal(verdict: Exclude<ConfirmationPageVerdict, 'ok'>): HttpError {
  return verdict === 'different_job'
    ? new HttpError(409, 'different_job', 'This page is for another job, so it was not recorded.')
    : new HttpError(
        422,
        'wrong_site',
        "This page is not on this application's site, so it was not recorded.",
      );
}

/**
 * The page's address as the timeline keeps it: no query or fragment, which on a thank-you page
 * can carry a session or an application token (sec on https://github.com/bgoleno/opportun/pull/188).
 * The site check above reads the whole address (Greenhouse's embed names its board in `?for=`).
 */
function withoutQuery(pageUrl: string): string {
  const url = new URL(pageUrl);
  url.search = '';
  url.hash = '';
  return url.href;
}

/** What the extension sends from the page the user is on (design 6.2). */
export interface ConfirmationPageInput {
  url: string;
  /** The tab's title. Not stored: the entry's title names the host, which the server checked. */
  title: string;
  /** The page's text as the browser read it, at most 20,000 characters (the route's schema). */
  text: string;
}

/** Who recorded it, for the audit entries. */
export interface DeviceCaller {
  tokenId: string;
  ip: string;
}

/** The timeline entry for a recorded page (cleanText: Postgres refuses a NUL, tl on #188). */
async function pageEntry(
  tx: Exec,
  ctx: UserCtx,
  opportunityId: string,
  input: ConfirmationPageInput,
) {
  return await createActivity(tx, ctx, opportunityId, {
    kind: 'confirmation_page',
    title: `Confirmation page recorded (${hostOf(input.url)})`,
    bodyMd: cleanText(input.text),
    occurredAt: Date.now(),
    participants: [],
    externalUrl: withoutQuery(input.url),
  });
}

/** A new copy for a page confirmation whose copy was deleted; the caller holds the lock. */
async function relinkPage(
  tx: Exec,
  ctx: UserCtx,
  current: SubmissionRow,
  input: ConfirmationPageInput,
  caller: DeviceCaller,
): Promise<SubmissionRow> {
  const entry = await pageEntry(tx, ctx, current.opportunityId, input);
  const [updated] = await tx
    .update(applicationSubmissions)
    .set({ confirmationActivityId: entry.id, updatedAt: Date.now() })
    .where(
      and(
        owned(ctx, current.id),
        eq(applicationSubmissions.status, 'confirmed'),
        isNull(applicationSubmissions.confirmationActivityId),
      ),
    )
    .returning();
  // Unreachable while every writer takes the attempt's lock; kept as a guard.
  if (updated === undefined) throw notNow(await getRow(tx, ctx, current.id), 'confirmed');
  await audit(tx, 'submission.confirmation_page_relinked', {
    userId: ctx.userId,
    ip: caller.ip,
    detail: {
      submissionId: current.id,
      opportunityId: current.opportunityId,
      deviceTokenId: caller.tokenId,
      host: hostOf(input.url),
    },
  });
  return updated;
}

/**
 * Records the application site's confirmation page (#121, tl's rulings): the attempt becomes
 * confirmed, kind `page`, with the page kept whole as a `confirmation_page` timeline entry.
 *
 * - Only for an attempt the user said they submitted (submitted, or unknown after the follow-up).
 *   Handed off is 409 not_submitted: a device never records "I submitted it" (ruling 1).
 * - Once: an attempt an email or a page already confirmed answers unchanged and stores nothing.
 *   One the user marked confirmed is backed by the page: kind `page`, the entry linked, the
 *   user's note left on the timeline and their confirmation time kept (ruling 2).
 * - A page from anywhere else is 422 wrong_site, and another job's page 409 different_job, each
 *   storing nothing; the refusal is audited with the page's host only (confirmationPageVerdict).
 * - A page confirmation whose copy was deleted takes the new copy (relinkPage).
 *
 * This decides alone: the extension's lookup (confirmableForPage) only says which attempt to
 * name, and nothing here assumes it was asked (tl on #121).
 *
 * The text is the user's own capture and stays on the timeline only: no job, no AI, no audit
 * (ruling 4). Lock order as everywhere: the attempt's lock first, before any row write.
 */
export async function confirmFromPage(
  db: Db,
  ctx: UserCtx,
  id: string,
  input: ConfirmationPageInput,
  caller: DeviceCaller,
): Promise<{ row: SubmissionRow; recorded: boolean }> {
  // Another user's id is a 404 and takes no lock. The destination, ATS kind and board are fixed
  // when the attempt is created, so checking the page against this read is checking it against
  // the row the transaction will see.
  const pre = await getRow(db, ctx, id);
  const host = hostOf(input.url);
  const verdict = confirmationPageVerdict(input.url, pre);
  if (verdict !== 'ok') {
    await audit(db, 'submission.confirmation_refused', {
      userId: ctx.userId,
      ip: caller.ip,
      detail: { submissionId: id, deviceTokenId: caller.tokenId, reason: verdict, host },
    });
    throw verdictRefusal(verdict);
  }
  await racePoint('submissions.confirmPage');
  return await withTransaction(db, async (tx) => {
    await lockScope(tx, submissionScope(id));
    const current = await getRow(tx, ctx, id);
    // A page confirmation whose copy the user deleted takes a new copy (tl, from qa on #188):
    // relinked, with the kind and the confirmation time unchanged. While a copy exists: once.
    const relinking =
      current.status === 'confirmed' &&
      current.confirmationKind === 'page' &&
      current.confirmationActivityId === null;
    if (current.status === 'confirmed' && current.confirmationKind !== 'user' && !relinking) {
      return { row: current, recorded: false };
    }
    if (relinking)
      return { row: await relinkPage(tx, ctx, current, input, caller), recorded: true };
    const upgrading = current.status === 'confirmed';
    if (current.status === 'handed_off') {
      throw new HttpError(
        409,
        'not_submitted',
        'Say you submitted this application in Opportun first, then record its confirmation page.',
        { submissionId: id, status: current.status },
      );
    }
    if (!upgrading && !(AWAITING as readonly string[]).includes(current.status)) {
      throw notNow(current, 'confirmed');
    }
    const now = Date.now();
    const entry = await pageEntry(tx, ctx, current.opportunityId, input);
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({
        status: 'confirmed',
        // A confirmation the user marked keeps its time: the page backs that confirmation.
        confirmedAt: upgrading ? (current.confirmedAt ?? now) : now,
        confirmationKind: 'page',
        confirmationActivityId: entry.id,
        updatedAt: now,
      })
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, current.status)))
      .returning();
    // Unreachable while every writer takes the attempt's lock; kept as a guard.
    if (updated === undefined) throw notNow(await getRow(tx, ctx, id), 'confirmed');
    // The follow-up's "Check whether…" step has its answer (#148's rule), as for an email.
    if (current.followupNextStepId !== null) {
      await tx
        .update(nextSteps)
        .set({ doneAt: now, updatedAt: now })
        .where(
          and(
            eq(nextSteps.id, current.followupNextStepId),
            eq(nextSteps.userId, ctx.userId),
            isNull(nextSteps.doneAt),
          ),
        )
        .run();
    }
    await audit(tx, 'submission.confirmed', {
      userId: ctx.userId,
      ip: caller.ip,
      detail: {
        submissionId: id,
        opportunityId: current.opportunityId,
        from: current.status,
        kind: 'page',
        deviceTokenId: caller.tokenId,
        host,
        ...(upgrading ? { upgradedFrom: 'user' } : {}),
      },
    });
    return { row: updated, recorded: true };
  });
}

/** Why the extension's lookup names no attempt to record a page for (tl on #121). */
export type ConfirmableMiss =
  'no_matching_attempt' | 'several_matching' | 'needs_submitted_first' | 'already_recorded';

export type ConfirmableResult =
  | { kind: 'found'; row: SubmissionRow; opportunityTitle: string; companyName: string }
  | { kind: 'none'; reason: ConfirmableMiss };

/**
 * Which of the caller's applications the page in this tab could confirm, for the extension's
 * "Record confirmation page" (tl's ruling on #121). It decides nothing: confirmFromPage checks
 * everything again under the attempt's lock.
 *
 * Among the attempts whose site and job the page may be (confirmationPageVerdict):
 * - any handed-off one makes it needs_submitted_first, naming none (tl on
 *   https://github.com/bgoleno/opportun/pull/199): this page may be that application's thank-you
 *   page, so an older submitted one must not take it. The user says "I submitted it" in
 *   Opportun; a device never does;
 * - else the recordable ones: submitted, unknown, confirmed by the user's word, or confirmed by a
 *   page whose copy was deleted. Exactly one is found; more than one is several_matching;
 * - else a page confirmation whose copy exists is already_recorded;
 * - everything else (email confirmations, reviewed, refused, cancelled and the rest) is
 *   no_matching_attempt.
 * A miss is a reason code only, and a match only its id, title and company (sec and tl on
 * #199): a leaked token learns as little as it can from probing which boards match.
 */
export async function confirmableForPage(
  db: Db,
  ctx: UserCtx,
  pageUrl: string,
): Promise<ConfirmableResult> {
  const rows = await db
    .select({
      row: applicationSubmissions,
      opportunityTitle: opportunities.title,
      companyName: companies.name,
    })
    .from(applicationSubmissions)
    .innerJoin(opportunities, eq(opportunities.id, applicationSubmissions.opportunityId))
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(
      and(
        eq(applicationSubmissions.userId, ctx.userId),
        inArray(applicationSubmissions.status, ['handed_off', 'submitted', 'unknown', 'confirmed']),
      ),
    )
    .all();
  const matching = rows.filter((r) => confirmationPageVerdict(pageUrl, r.row) === 'ok');
  if (matching.some(({ row }) => row.status === 'handed_off')) {
    return { kind: 'none', reason: 'needs_submitted_first' };
  }
  const recordable = matching.filter(({ row }) =>
    row.status === 'confirmed'
      ? row.confirmationKind === 'user' ||
        (row.confirmationKind === 'page' && row.confirmationActivityId === null)
      : true,
  );
  const [only] = recordable;
  if (recordable.length === 1 && only !== undefined) return { kind: 'found', ...only };
  if (recordable.length > 1) return { kind: 'none', reason: 'several_matching' };
  const recorded = matching.some(
    ({ row }) =>
      row.status === 'confirmed' &&
      row.confirmationKind === 'page' &&
      row.confirmationActivityId !== null,
  );
  return { kind: 'none', reason: recorded ? 'already_recorded' : 'no_matching_attempt' };
}

/**
 * "Not this application": an email confirmation undone (#119 criterion 5). Only an attempt an
 * email confirmed; it returns to `submitted` with its confirmation fields cleared. The message
 * is untouched: a confirmation never linked it (confirmFromEmail), so nothing else remains.
 */
export async function unlinkConfirmation(db: Db, ctx: UserCtx, id: string): Promise<Submission> {
  await getRow(db, ctx, id); // another user's id is a 404 and takes no lock
  const row = await withTransaction(db, async (tx) => {
    await lockScope(tx, submissionScope(id));
    const current = await getRow(tx, ctx, id);
    if (current.status !== 'confirmed' || current.confirmationKind !== 'email') {
      throw new HttpError(
        409,
        'not_email_confirmed',
        'Only an application confirmed by an email can be unlinked from it.',
        { submissionId: id, status: current.status },
      );
    }
    const now = Date.now();
    const [updated] = await tx
      .update(applicationSubmissions)
      .set({
        status: 'submitted',
        confirmedAt: null,
        confirmationKind: null,
        confirmationCommId: null,
        confirmationBasis: null,
        updatedAt: now,
      })
      .where(and(owned(ctx, id), eq(applicationSubmissions.status, 'confirmed')))
      .returning();
    if (updated === undefined) throw notNow(await getRow(tx, ctx, id), 'submitted');
    await audit(tx, 'submission.confirmation_unlinked', {
      userId: ctx.userId,
      detail: {
        submissionId: id,
        opportunityId: current.opportunityId,
        communicationId: current.confirmationCommId,
      },
    });
    return updated;
  });
  return await detailView(db, ctx, row);
}

/** The recorded confirmation page (#121), while a page is the confirmation and still exists. */
async function confirmationPage(
  exec: Exec,
  ctx: UserCtx,
  row: SubmissionRow,
): Promise<Submission['confirmationPage']> {
  if (row.confirmationKind !== 'page' || row.confirmationActivityId === null) return null;
  const entry = await exec
    .select({
      id: activities.id,
      externalUrl: activities.externalUrl,
      occurredAt: activities.occurredAt,
      bodyMd: activities.bodyMd,
    })
    .from(activities)
    .where(and(eq(activities.userId, ctx.userId), eq(activities.id, row.confirmationActivityId)))
    .get();
  if (entry === undefined) return null;
  return {
    activityId: entry.id,
    url: entry.externalUrl,
    host: entry.externalUrl === null ? null : hostOf(entry.externalUrl),
    recordedAt: entry.occurredAt,
    text: entry.bodyMd,
  };
}

/**
 * GET /submissions/:id's view: the attempt, and for an email confirmation what its evidence card
 * shows (subject, the sender's address without its display name, when, which signals).
 */
export async function detailView(
  exec: Exec,
  ctx: UserCtx,
  row: SubmissionRow,
): Promise<Submission> {
  const base = { ...view(row), confirmationPage: await confirmationPage(exec, ctx, row) };
  if (row.confirmationKind !== 'email' || row.confirmationCommId === null) {
    return { ...base, confirmationEmail: null };
  }
  const message = await exec
    .select({
      id: communications.id,
      subject: communications.subject,
      from: communications.from,
      sentAt: communications.sentAt,
    })
    .from(communications)
    .where(
      and(eq(communications.userId, ctx.userId), eq(communications.id, row.confirmationCommId)),
    )
    .get();
  if (message === undefined) return { ...base, confirmationEmail: null };
  return {
    ...base,
    confirmationEmail: {
      communicationId: message.id,
      subject: message.subject,
      fromAddress: senderAddress(message.from),
      sentAt: message.sentAt,
      signals: emailBasis(row.confirmationBasis)?.signals ?? [],
    },
  };
}
