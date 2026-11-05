// Company industry tags (https://github.com/bgoleno/opportun/issues/220, #190 N4b): candidates with
// no tag yet get a NAICS 2022 code from cheap calls of about 20 at a time. A tag is created once
// and kept: the write applies only to a company not yet tagged or tried, so a correction the user
// makes, even during a call, is never overwritten.
//
// A candidate is what the Companies tab offers the user to follow: a suggestion, or a company they
// know someone at. A followed or denied one is already decided. The recommendations page (#222)
// reads these tags.
//
// What each call sends: for each company its name, its domain and up to 10 job titles from postings
// already stored from its board, and the static table. Network company names do go to the provider
// (the owner's decision 3 on #190). No contact, note or other company field is read, so none can be
// sent, and no board is fetched for this. The calls count against the discovery budget.
import {
  AiUnavailableError,
  CompanyTagsOutputSchema,
  renderPrompt,
  runStructured,
} from '@opportun/ai';
import { isNaicsCode, NAICS_2022_INDUSTRY_GROUPS } from '@opportun/core';
import { and, asc, desc, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { jsonText } from '../db/dialect';
import {
  companies,
  discoveryResults,
  discoveryRuns,
  discoverySources,
  networkContacts,
} from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { line } from '../lib/promptText';
import type { UserCtx } from '../repos/base';
import { discoveryBudgetHasRoom } from '../repos/discoveryBudget';
import { getActivePrompt } from '../repos/prompts';
import type { JobHandler } from './registry';
import { enqueue } from './runner';

export const COMPANY_TAGS_KIND = 'discovery.company_tags';
export const COMPANY_TAGS_SWEEP_KIND = 'discovery.company_tags_sweep';
/** Nightly, just after the title variants sweep, and before the morning's discovery runs. */
export const COMPANY_TAGS_SWEEP_CRON = '45 5 * * *';

/** Companies in one call: about what the proposal costed, and a short answer to get right. */
export const COMPANY_TAGS_BATCH = 20;
const MAX_TITLES = 10;
/** Stored postings looked through to find 10 different titles. */
const TITLES_LOOKED_AT = 50;
/** A night's most for one user. The budget normally stops it far sooner. */
const MAX_COMPANIES_PER_RUN = 2000;

const NAICS_TABLE_TEXT = NAICS_2022_INDUSTRY_GROUPS.map((g) => `${g.code} ${g.title}`).join('\n');

/** The candidates not yet tagged or tried. With no user, whoever's they are (the sweep's list). */
function untaggedCandidates(db: Db, userId?: string) {
  return and(
    userId === undefined ? undefined : eq(companies.userId, userId),
    isNull(companies.industryAt),
    inArray(companies.status, ['none', 'suggested']),
    or(
      eq(companies.status, 'suggested'),
      exists(
        db
          .select({ one: sql`1` })
          .from(networkContacts)
          .where(
            and(
              eq(networkContacts.currentCompanyId, companies.id),
              eq(networkContacts.userId, companies.userId),
            ),
          ),
      ),
    ),
  );
}

/** Up to 10 different job titles from postings stored from this company's own board, newest first. */
async function storedTitles(db: Db, ctx: UserCtx, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ title: jsonText(discoveryResults.posting, 'title') })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .innerJoin(discoverySources, eq(discoverySources.id, discoveryRuns.sourceId))
    .where(and(eq(discoveryResults.userId, ctx.userId), eq(discoverySources.companyId, companyId)))
    .orderBy(desc(discoveryResults.createdAt), desc(discoveryResults.id))
    .limit(TITLES_LOOKED_AT)
    .all();
  const titles = new Set<string>();
  for (const { title } of rows) {
    const clean = line(title ?? '', 120);
    if (clean !== '') titles.add(clean);
    if (titles.size === MAX_TITLES) break;
  }
  return [...titles];
}

interface Candidate {
  id: string;
  name: string;
  domain: string | null;
}

/** The batch as the prompt fences it. The ref is all the model sees of which row is which. */
async function batchText(db: Db, ctx: UserCtx, batch: readonly Candidate[]): Promise<string> {
  const blocks: string[] = [];
  for (const [i, company] of batch.entries()) {
    const lines = [`ref: c${i + 1}`, `name: ${line(company.name, 200)}`];
    if (company.domain !== null) lines.push(`domain: ${line(company.domain, 253)}`);
    const titles = await storedTitles(db, ctx, company.id);
    if (titles.length > 0) lines.push(`job titles: ${titles.join('; ')}`);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Stores what an answer says. A company named with a code from the table is tagged. One named with
 * anything else could not be placed: it is marked as tried with no code, so it does not cost a call
 * every night, and the user can still set one. One the answer left out is untouched, and is asked
 * about again the next night. Never over a tag or a correction made since the list was read.
 */
async function storeTags(
  db: Db,
  ctx: UserCtx,
  batch: readonly Candidate[],
  answer: z.infer<typeof CompanyTagsOutputSchema>,
): Promise<number> {
  const codes = new Map<string, string>();
  for (const row of answer.tags) {
    const ref = row.ref.trim();
    if (!codes.has(ref)) codes.set(ref, row.code.trim());
  }
  const now = Date.now();
  let tagged = 0;
  for (const [i, company] of batch.entries()) {
    const code = codes.get(`c${i + 1}`);
    if (code === undefined) continue;
    const known = isNaicsCode(code);
    // updatedAt stays: a tag is not the user's edit, and company.suggest lists by it.
    await db
      .update(companies)
      .set({
        naicsCode: known ? code : null,
        industrySource: known ? 'ai' : null,
        industryAt: now,
      })
      .where(
        and(
          eq(companies.id, company.id),
          eq(companies.userId, ctx.userId),
          isNull(companies.industryAt),
        ),
      )
      .run();
    if (known) tagged += 1;
  }
  return tagged;
}

export interface CompanyTagsRun {
  tagged: number;
  calls: number;
  /** Why it stopped early; what is left is asked about the next night. */
  stopped: 'budget_exceeded' | 'no_key' | 'provider_error' | 'no_prompt' | 'shutdown' | null;
}

/** Tags the caller's candidates, a batch at a time, until they or the budget run out. */
export async function tagCompanies(
  db: Db,
  ctx: UserCtx,
  opts: { stopping?: () => boolean } = {},
): Promise<CompanyTagsRun> {
  const run: CompanyTagsRun = { tagged: 0, calls: 0, stopped: null };
  const prompt = await getActivePrompt(db, ctx, COMPANY_TAGS_KIND);
  if (prompt === undefined) return { ...run, stopped: 'no_prompt' };
  const candidates = await db
    .select({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .where(untaggedCandidates(db, ctx.userId))
    .orderBy(asc(companies.createdAt), asc(companies.id))
    .limit(MAX_COMPANIES_PER_RUN)
    .all();
  for (let at = 0; at < candidates.length; at += COMPANY_TAGS_BATCH) {
    if (opts.stopping?.() === true) return { ...run, stopped: 'shutdown' };
    // Spend is on the ledger when a call ends, and these go one at a time, so a run passes the
    // budget by one call at most.
    if (!(await discoveryBudgetHasRoom(db, ctx))) return { ...run, stopped: 'budget_exceeded' };
    const batch = candidates.slice(at, at + COMPANY_TAGS_BATCH);
    try {
      run.calls += 1;
      const answer = await runStructured(await buildAiDeps(db, ctx), COMPANY_TAGS_KIND, {
        system: renderPrompt(prompt.body, {
          companies_untrusted: await batchText(db, ctx, batch),
          naics_table: NAICS_TABLE_TEXT,
        }),
        prompt: 'Tag each company and return the result.',
        schema: CompanyTagsOutputSchema,
        promptId: prompt.id,
      });
      run.tagged += await storeTags(db, ctx, batch, answer);
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) throw err;
      // This batch's answer was unusable: those behind it may be fine, and it is tried next night.
      if (err.reason === 'invalid_output') continue;
      // True of every batch behind it too.
      return { ...run, stopped: err.reason };
    }
  }
  return run;
}

/** Whether a call could get past the key check, so a night with no key records no failed call. */
async function hasKey(db: Db, ctx: UserCtx): Promise<boolean> {
  const deps = await buildAiDeps(db, ctx);
  const policy = await deps.policyFor(COMPANY_TAGS_KIND);
  try {
    await deps.getKey(policy.provider);
    return true;
  } catch {
    return false;
  }
}

/** Queues a run for each user with a candidate to tag, a key and room in the budget. */
export async function sweepCompanyTags(db: Db): Promise<number> {
  const owners = await db
    .selectDistinct({ userId: companies.userId })
    .from(companies)
    .where(untaggedCandidates(db))
    .all();
  let queued = 0;
  for (const { userId } of owners) {
    const ctx: UserCtx = { userId, isAdmin: false };
    if (!(await hasKey(db, ctx)) || !(await discoveryBudgetHasRoom(db, ctx))) continue;
    await enqueue(
      db,
      COMPANY_TAGS_KIND,
      {},
      { dedupeKey: `${COMPANY_TAGS_KIND}:${userId}`, userId },
    );
    queued += 1;
  }
  return queued;
}

export const companyTagsJob: JobHandler<Record<string, never>> = {
  kind: COMPANY_TAGS_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  // A failure ends the run and the next night's sweep asks again: a retry would only pay twice.
  maxAttempts: 1,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error(`${COMPANY_TAGS_KIND} needs a user`);
    await ctx.setResult(
      await tagCompanies(db, { userId: ctx.userId, isAdmin: false }, { stopping: ctx.stopping }),
    );
  },
};

export const companyTagsSweepJob: JobHandler<Record<string, never>> = {
  kind: COMPANY_TAGS_SWEEP_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    // Counts only: no company names leave the database this way.
    await ctx.setResult({ queued: await sweepCompanyTags(db) });
  },
};
