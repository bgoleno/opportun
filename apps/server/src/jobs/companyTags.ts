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
import { usersWithRejectedKey } from '../repos/discovery';
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
/**
 * Provider errors in a row that count as an outage. Any one can be about that batch alone (a gateway
 * refusing one company's name), so a run moves on after one, as the ranking drain does: otherwise
 * that batch would stop everything behind it, every night, with nothing to say so.
 */
const OUTAGE_AFTER_ERRORS = 3;

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
    const answered = codes.get(`c${i + 1}`);
    if (answered === undefined) continue;
    // A model can say "NAICS 5132", "5132 Software Publishers" or "NAICS 2022 5132". Trying is for
    // good, so a right code in a wordy answer must not be lost: the first whole 4-digit number that
    // is in the table, so a year before it is passed over and can never become a tag.
    const code = answered.match(/(?<!\d)\d{4}(?!\d)/g)?.find(isNaicsCode) ?? '';
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
  /** Calls that gave nothing to store: those companies are asked about the next night. */
  failed: number;
  /** Why it stopped early; what is left is asked about the next night. */
  stopped:
    | 'budget_exceeded'
    | 'no_key'
    | 'key_rejected'
    | 'provider_error'
    | 'invalid_output'
    | 'no_prompt'
    | 'shutdown'
    | null;
}

/** Tags the caller's candidates, a batch at a time, until they or the budget run out. */
export async function tagCompanies(
  db: Db,
  ctx: UserCtx,
  opts: { stopping?: () => boolean } = {},
): Promise<CompanyTagsRun> {
  const run: CompanyTagsRun = { tagged: 0, calls: 0, failed: 0, stopped: null };
  let errorsInARow = 0;
  const prompt = await getActivePrompt(db, ctx, COMPANY_TAGS_KIND);
  if (prompt === undefined) return { ...run, stopped: 'no_prompt' };
  const candidates = await db
    .select({ id: companies.id, name: companies.name, domain: companies.domain })
    .from(companies)
    .where(untaggedCandidates(db, ctx.userId))
    .orderBy(asc(companies.createdAt), asc(companies.id))
    .limit(MAX_COMPANIES_PER_RUN)
    .all();
  /** One call. Null if it worked, or why not: what the callers below decide on. */
  const ask = async (batch: readonly Candidate[]): Promise<AiUnavailableError | null> => {
    run.calls += 1;
    try {
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
      return null;
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) throw err;
      run.failed += 1;
      return err;
    }
  };

  /** Why not to make another call, if there is a reason. Spend reaches the ledger when a call ends,
   *  and these go one at a time, so a run passes the budget by one call at most. */
  const stopBefore = async (): Promise<CompanyTagsRun['stopped']> => {
    if (opts.stopping?.() === true) return 'shutdown';
    return (await discoveryBudgetHasRoom(db, ctx)) ? null : 'budget_exceeded';
  };

  /** Why this failure ends the run, if it does: true of every call behind it too. */
  const stopAfter = (err: AiUnavailableError): CompanyTagsRun['stopped'] => {
    if (err.keyRejected) return 'key_rejected';
    return err.reason === 'no_key' || err.reason === 'budget_exceeded' ? err.reason : null;
  };

  /**
   * A call that holds one company alone: only a usable answer ends a run of errors, and any other
   * failure counts towards it, an unusable answer included. An answer that cannot be used is a failed
   * call for cost, whatever the reason: a model that never answers usably must cost 4 calls a night
   * (the batch, then three alone), not every call the budget allows (qa and tl on
   * https://github.com/bgoleno/opportun/pull/284).
   */
  const askAlone = async (company: Candidate): Promise<CompanyTagsRun['stopped']> => {
    const err = await ask([company]);
    if (err === null) {
      errorsInARow = 0;
      return null;
    }
    const stop = stopAfter(err);
    if (stop !== null) return stop;
    errorsInARow += 1;
    return errorsInARow >= OUTAGE_AFTER_ERRORS ? err.reason : null;
  };

  for (let at = 0; at < candidates.length; at += COMPANY_TAGS_BATCH) {
    const batch = candidates.slice(at, at + COMPANY_TAGS_BATCH);
    const before = await stopBefore();
    if (before !== null) return { ...run, stopped: before };
    if (batch.length === 1) {
      const stop = await askAlone(batch[0] as Candidate);
      if (stop !== null) return { ...run, stopped: stop };
      continue;
    }
    const err = await ask(batch);
    if (err === null) {
      errorsInARow = 0;
      continue;
    }
    const stop = stopAfter(err);
    if (stop !== null) return { ...run, stopped: stop };
    // A failed batch neither counts nor ends a run of errors: only the single calls below do.
    // Refused, or answered badly, perhaps because of one name in it (company names and titles are
    // untrusted text in the prompt). The list starts from the same place each night, so this batch
    // would re-form every night and its other companies would never be tagged: ask each alone.
    // The batch itself does not count towards an outage, and each single call does, so a real outage
    // stops after 4 calls. One that fails alone is not marked as tried: marking is for good, and a
    // passing error such as a rate limit must not do that to a healthy company.
    for (const company of batch) {
      const beforeOne = await stopBefore();
      if (beforeOne !== null) return { ...run, stopped: beforeOne };
      const stopOne = await askAlone(company);
      if (stopOne !== null) return { ...run, stopped: stopOne };
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
  // A key the provider has refused would only send 20 names to be refused again each night.
  const rejected = await usersWithRejectedKey(db);
  let queued = 0;
  for (const { userId } of owners) {
    if (rejected.has(userId)) continue;
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
