// Company homepage resolution (issue #239): the company name shown next to an opportunity links
// to its homepage once one is confidently known. companies.domain already existed in both schema
// twins but nothing wrote it for an opportunity-sourced company -- the only existing producer is
// the AI company.suggest flow, for companies that flow creates itself (jobs/companySuggest.ts).
//
// A wrong link is worse than no link (the issue's own framing), so a domain is only ever written
// once verified: the candidate must be fetched and must actually name the company on its own
// homepage. That is the same bar opportunityEnrich.ts already holds a candidate careers-page
// domain to, and this reuses its candidateDomains/senderDomain/pageNamesCompany/getPage directly
// rather than a second implementation that could quietly disagree about what counts as "the
// company's site". No AI or search lookup is used: a guess that fails verification is discarded,
// and the company stays unlinked rather than linked wrong.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ACTIVE_PIPELINE_STAGES } from '@opportun/core';
import type { Db } from '../db/client';
import { communications, companies, opportunities, settings, users } from '../db/schema';
import type { safeFetch } from '../lib/safeFetch';
import type { UserCtx } from '../repos/base';
import { candidateDomains, getPage, pageNamesCompany, senderDomain } from './opportunityEnrich';
import { requireService, type JobContext, type JobHandler } from './registry';
import { enqueue } from './runner';

export const COMPANY_DOMAIN_RESOLVE_KIND = 'company.domain_resolve'; // payload {companyId}
export const companyDomainResolveDedupeKey = (companyId: string): string =>
  `${COMPANY_DOMAIN_RESOLVE_KIND}:${companyId}`;

/** Queues resolution for one company, deduped so a flurry of stage moves costs one job. */
export async function enqueueCompanyDomainResolve(
  db: Db,
  userId: string,
  companyId: string,
): Promise<void> {
  await enqueue(
    db,
    COMPANY_DOMAIN_RESOLVE_KIND,
    { companyId },
    { dedupeKey: companyDomainResolveDedupeKey(companyId), userId },
  );
}

/**
 * The earliest outreach mail's From header among any opportunity of this company's (not one
 * particular opportunity's, since a company-level job may be triggered by any of several, or by
 * the backfill with none in particular). The same "oldest first" choice opportunityEnrich.ts's
 * own sourceFrom makes, for the same reason: the first recruiter contact is the one least likely
 * to be a later, unrelated thread.
 */
async function senderForCompany(db: Db, ctx: UserCtx, companyId: string): Promise<string | null> {
  return (
    (
      await db
        .select({ from: communications.from })
        .from(communications)
        .innerJoin(opportunities, eq(opportunities.id, communications.opportunityId))
        .where(and(eq(communications.userId, ctx.userId), eq(opportunities.companyId, companyId)))
        .orderBy(asc(communications.sentAt))
        .limit(1)
        .get()
    )?.from ?? null
  );
}

export type ResolveOutcome =
  | { outcome: 'resolved'; domain: string }
  | { outcome: 'already_resolved' }
  | { outcome: 'not_found' }
  | { outcome: 'unresolved' };

/** Tries each candidate domain in order, first verified hit wins; never overwrites a set domain. */
export async function resolveCompanyDomain(
  db: Db,
  ctx: UserCtx,
  fetch: typeof safeFetch,
  companyId: string,
): Promise<ResolveOutcome> {
  const company = await db
    .select({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
    .get();
  if (company === undefined) return { outcome: 'not_found' };
  if (company.domain !== null) return { outcome: 'already_resolved' };
  const sender = await senderForCompany(db, ctx, companyId);
  for (const domain of candidateDomains(company.name, senderDomain(sender ?? ''))) {
    const home = await getPage(fetch, `https://${domain}/`);
    if (home === null || !pageNamesCompany(home.html, company.name)) continue;
    await db
      .update(companies)
      .set({ domain, updatedAt: Date.now() })
      .where(and(eq(companies.userId, ctx.userId), eq(companies.id, companyId)))
      .run();
    return { outcome: 'resolved', domain };
  }
  return { outcome: 'unresolved' };
}

const PayloadSchema = z.object({ companyId: z.string().min(1).max(64) }).strict();

export const companyDomainResolveJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: COMPANY_DOMAIN_RESOLVE_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 2,
  async run(db, payload, ctx: JobContext) {
    if (ctx.userId === null) throw new Error(`${COMPANY_DOMAIN_RESOLVE_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    const fetch = requireService(ctx, 'sourceFetch');
    await ctx.setResult(await resolveCompanyDomain(db, user, fetch, payload.companyId));
  },
};

// ---------------------------------------------------------------------------
// One-shot backfill: a company already sitting in an active pipeline stage when this shipped
// gets resolved too, so an opportunity reported before this existed does not need to be moved
// again to pick one up. Bounded to companies actually in the pipeline today, not all of them --
// the companies a user has only discovered, not actioned, are not what the issue asked for and
// would make this a 1,154-row sweep instead of the handful actually in play. Same one-shot-
// per-deployment shape as companyMatchKeyRepair.ts: a settings marker row, queued once per user
// on boot; see enqueueRepairAlertLeadsOnce for why a fresh install with no users yet is skipped
// rather than marked done.

export const COMPANY_DOMAIN_BACKFILL_KIND = 'company.domain_resolve_backfill';
export const COMPANY_DOMAIN_BACKFILL_MARKER_KEY = 'company_domain_backfill:done';

export interface BackfillOutcome {
  companiesQueued: number;
}

/** Queues resolution for every company of this user's already in an active stage, domain-less. */
export async function backfillCompanyDomains(db: Db, ctx: UserCtx): Promise<BackfillOutcome> {
  const rows = await db
    .selectDistinct({ companyId: opportunities.companyId })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(
      and(
        eq(opportunities.userId, ctx.userId),
        isNull(companies.domain),
        inArray(opportunities.stage, ACTIVE_PIPELINE_STAGES),
      ),
    )
    .all();
  for (const { companyId } of rows) {
    await enqueueCompanyDomainResolve(db, ctx.userId, companyId);
  }
  return { companiesQueued: rows.length };
}

/** Queues the backfill for every user, once per deployment. */
export async function enqueueCompanyDomainBackfillOnce(db: Db): Promise<number> {
  const marker = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, COMPANY_DOMAIN_BACKFILL_MARKER_KEY))
    .get();
  if (marker !== undefined) return 0;
  const all = await db.select({ id: users.id }).from(users).all();
  if (all.length === 0) return 0;
  for (const { id } of all) {
    await enqueue(
      db,
      COMPANY_DOMAIN_BACKFILL_KIND,
      {},
      { dedupeKey: `${COMPANY_DOMAIN_BACKFILL_KIND}:${id}`, userId: id },
    );
  }
  await db
    .insert(settings)
    .values({
      key: COMPANY_DOMAIN_BACKFILL_MARKER_KEY,
      userId: null,
      value: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  return all.length;
}

const BackfillPayloadSchema = z.object({}).strict();

export const companyDomainBackfillJob: JobHandler<z.infer<typeof BackfillPayloadSchema>> = {
  kind: COMPANY_DOMAIN_BACKFILL_KIND,
  payloadSchema: BackfillPayloadSchema,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error(`${COMPANY_DOMAIN_BACKFILL_KIND} needs a user`);
    const outcome = await backfillCompanyDomains(db, { userId: ctx.userId, isAdmin: false });
    await ctx.setResult(outcome);
  },
};
