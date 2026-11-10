// AI company suggestions (FR-D8). Weekly, for each user, the company.suggest task proposes
// companies worth following, from the user's role targets, the companies already in their
// pipeline (name and status), the titles they recently accepted or dismissed, and the companies
// they denied. Names and titles are third-party data, so the pipeline and the denied list are
// rendered as *_untrusted (fenced by renderPrompt).
//
// v2 (https://github.com/bgoleno/opportun/issues/221, #190 N5a): the prompt also gets the user's
// confirmed industry profile (code, title, tier, reason) and the names of the companies where the
// user knows someone, most contacted first and at most 500 (decision 3 on #190: always, with no
// setting). Names only: no contact, count or other field is read, so none can be sent. Each
// suggestion comes back with a code and a tier; one whose code is not in the confirmed profile is
// dropped. The code is kept as the company's tag, so the nightly tagging does not ask about it.
//
// A suggestion becomes a company row with status 'suggested' and its rationale; nothing is
// followed until the user accepts it (routes/companySuggestions.ts). A name that matches any
// company the user already has, whatever its status, is skipped (normalized compare), so a
// denied company is never suggested again and a pending suggestion is not duplicated. Each new
// suggestion then gets one board probe (jobs/companyBoardProbe.ts), with no AI call.
import { AiUnavailableError, renderPrompt, runStructured, SuggestOutputSchema } from '@opportun/ai';
import { isNaicsCode, naicsTitle, newId, type NaicsTier } from '@opportun/core';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/client';
import { companies, discoveryResults, networkContacts, users } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { withMatchKey } from '../repos/companies';
import type { UserCtx } from '../repos/base';
import { discoveryBudgetHasRoom } from '../repos/discoveryBudget';
import { confirmedIndustryRows } from '../repos/industryProfile';
import { getActivePrompt } from '../repos/prompts';
import { startOfUtcDay } from '../repos/taskRuns';
import { line } from '../lib/promptText';
import { roleTargetsText } from './classify';
import { enqueueBoardProbe } from './companyBoardProbe';
import type { JobHandler } from './registry';
import { enqueue } from './runner';

export const COMPANY_SUGGEST_KIND = 'company.suggest'; // per user via the job's user_id
/** Weekly, Tuesday 08:00. */
export const COMPANY_SUGGEST_CRON = '0 8 * * 2';

const MAX_PIPELINE_COMPANIES = 200;
const MAX_RECENT_TITLES = 50;
const MAX_DENIED = 500;
/** Network company names sent, the most contacted first (#221 criterion 3). */
export const MAX_NETWORK_COMPANIES = 500;
const MAX_RATIONALE_CHARS = 500;

// ---------------------------------------------------------------------------
// Names

/** Trailing words that do not tell two companies apart ("Initech, Inc." is "Initech"). */
const CORPORATE_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'plc',
  'ag',
  'sa',
]);

/**
 * The comparison form of a company name: accents folded, lowercase, '&' read as 'and',
 * punctuation and spacing dropped, a leading "the" and trailing corporate suffixes removed.
 */
export function normalizeCompanyName(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
  const whole = words.join('');
  while (words.length > 1 && CORPORATE_SUFFIXES.has(words.at(-1) ?? '')) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words.join('') || whole;
}

/** A stored name: no control characters, single spaces. */
function cleanName(name: string): string {
  return name
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DOMAIN_LABEL = /^[a-z0-9-]{1,63}$/;
const domainLabelOk = (l: string): boolean =>
  DOMAIN_LABEL.test(l) && !l.startsWith('-') && !l.endsWith('-');

/** The model's domain guess when it is a plausible hostname ("www." and any scheme dropped). */
export function cleanDomainGuess(guess: string | null | undefined): string | null {
  if (guess == null) return null;
  const host = guess
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  if (host.length < 4 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(domainLabelOk)) return null;
  return /^[a-z]{2,63}$/.test(labels.at(-1) ?? '') ? host : null;
}

// ---------------------------------------------------------------------------
// Prompt context

/** Companies the user tracks (not denied), with status, and recently decided titles. */
export async function pipelineText(db: Db, ctx: UserCtx): Promise<string> {
  const tracked = await db
    .select({ name: companies.name, status: companies.status })
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), ne(companies.status, 'denied')))
    .orderBy(desc(companies.updatedAt), companies.id)
    .limit(MAX_PIPELINE_COMPANIES)
    .all();
  const decided = await db
    .select({ posting: discoveryResults.posting, disposition: discoveryResults.disposition })
    .from(discoveryResults)
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        inArray(discoveryResults.disposition, ['accepted', 'dismissed']),
      ),
    )
    .orderBy(desc(discoveryResults.updatedAt), discoveryResults.id)
    .limit(MAX_RECENT_TITLES)
    .all();
  const out = ['Companies in the pipeline:'];
  out.push(
    ...(tracked.length === 0
      ? ['(none)']
      : tracked.map((c) => `- ${line(c.name, 200)} (${c.status})`)),
  );
  out.push('', 'Recently accepted or dismissed job titles:');
  const titles = decided.map((r) => {
    const title = typeof r.posting.title === 'string' ? r.posting.title : '';
    const company = typeof r.posting.company === 'string' ? r.posting.company : '';
    return `- ${r.disposition}: ${line(title)} at ${line(company, 200)}`;
  });
  out.push(...(titles.length === 0 ? ['(none)'] : titles));
  return out.join('\n');
}

/** Every company the user denied (excluded forever). */
export async function deniedText(db: Db, ctx: UserCtx): Promise<string> {
  const rows = await db
    .select({ name: companies.name })
    .from(companies)
    .where(and(eq(companies.userId, ctx.userId), eq(companies.status, 'denied')))
    .orderBy(companies.name)
    .limit(MAX_DENIED)
    .all();
  return rows.length === 0 ? '(none)' : rows.map((r) => `- ${line(r.name, 200)}`).join('\n');
}

/**
 * The confirmed profile, one row a line: code, title, tier, and the reason when there is one. Only
 * a row the user confirmed counts. "(none)" when there is none yet.
 */
export async function industryProfileText(db: Db, ctx: UserCtx): Promise<string> {
  const rows = await confirmedIndustryRows(db, ctx);
  return rows.length === 0
    ? '(none)'
    : rows
        .map((r) => {
          const reason = r.reason === null ? '' : `: ${line(r.reason, 300)}`;
          return `- ${r.naicsCode} ${naicsTitle(r.naicsCode) ?? ''} (${r.tier})${reason}`.replace(
            /  +/g,
            ' ',
          );
        })
        .join('\n');
}

/**
 * The names of the companies where the user knows someone, the most contacted first, then by
 * name, at most MAX_NETWORK_COMPANIES. Names only: the contact count orders the list and goes no
 * further, and no contact's name, email, notes or other field is selected at all. A denied company
 * is left out (it is in the denied list).
 */
export async function networkCompaniesText(db: Db, ctx: UserCtx): Promise<string> {
  const rows = await db
    .select({ name: companies.name })
    .from(companies)
    .innerJoin(
      networkContacts,
      and(
        eq(networkContacts.currentCompanyId, companies.id),
        eq(networkContacts.userId, companies.userId),
      ),
    )
    .where(and(eq(companies.userId, ctx.userId), ne(companies.status, 'denied')))
    .groupBy(companies.id, companies.name)
    .orderBy(sql`count(${networkContacts.id}) desc`, companies.name, companies.id)
    .limit(MAX_NETWORK_COMPANIES)
    .all();
  return rows.length === 0 ? '(none)' : rows.map((r) => `- ${line(r.name, 200)}`).join('\n');
}

// ---------------------------------------------------------------------------
// The run

export type SuggestRun =
  | {
      status: 'suggested';
      created: number;
      /** Suggestions left out because their code is not in the confirmed profile. */
      dropped: number;
    }
  | { status: 'skipped'; reason: string };

/** Runs company.suggest for one user and stores new suggestions. */
export async function suggestCompanies(db: Db, ctx: UserCtx): Promise<SuggestRun> {
  const prompt = await getActivePrompt(db, ctx, COMPANY_SUGGEST_KIND);
  if (prompt === undefined) return { status: 'skipped', reason: 'no_prompt' };
  // The suggestions are a discovery call: today's spend over the discovery budget leaves no room.
  if (!(await discoveryBudgetHasRoom(db, ctx)))
    return { status: 'skipped', reason: 'budget_exceeded' };
  let out: z.infer<typeof SuggestOutputSchema>;
  try {
    out = await runStructured(await buildAiDeps(db, ctx), COMPANY_SUGGEST_KIND, {
      system: renderPrompt(prompt.body, {
        role_targets: await roleTargetsText(db, ctx),
        industry_profile_untrusted: await industryProfileText(db, ctx),
        network_companies_untrusted: await networkCompaniesText(db, ctx),
        pipeline_untrusted: await pipelineText(db, ctx),
        denied_companies_untrusted: await deniedText(db, ctx),
      }),
      prompt: 'Suggest companies to follow and return the result.',
      schema: SuggestOutputSchema,
      promptId: prompt.id,
    });
  } catch (err) {
    if (err instanceof AiUnavailableError) return { status: 'skipped', reason: err.reason };
    throw err;
  }
  // The confirmed profile's tier for each code. With no confirmed row there is nothing to be
  // outside of: no suggestion is dropped, and the model's own code and tier are kept when the code
  // is in the table.
  const profile = new Map((await confirmedIndustryRows(db, ctx)).map((r) => [r.naicsCode, r.tier]));
  const { created, dropped, ids } = await withTransaction(db, async (tx) => {
    // Every name the user has, of any status: those are never suggested (again).
    const known = new Set(
      (
        await tx
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.userId, ctx.userId))
          .all()
      ).map((c) => normalizeCompanyName(c.name)),
    );
    const made: string[] = [];
    let skipped = 0;
    for (const s of out.suggestions) {
      const name = cleanName(s.name);
      if (name.length === 0) continue;
      const key = normalizeCompanyName(name);
      if (key.length === 0 || known.has(key)) continue;
      // A code is exactly a 4-digit code of the table. Within a confirmed profile it must also be
      // one of the user's rows, and its tier is theirs, not the model's.
      const code = s.code.trim();
      const tier: NaicsTier | undefined =
        profile.size > 0 ? profile.get(code) : isNaicsCode(code) ? s.tier : undefined;
      if (profile.size > 0 && tier === undefined) {
        skipped += 1;
        continue;
      }
      known.add(key);
      const id = newId();
      const now = Date.now();
      await tx
        .insert(companies)
        .values({
          id,
          userId: ctx.userId,
          ...withMatchKey({ name }),
          domain: cleanDomainGuess(s.domainGuess),
          status: 'suggested',
          suggestionRationale: s.rationale.trim().slice(0, MAX_RATIONALE_CHARS) || null,
          // The code is the company's tag, so the nightly tagging does not ask about it again.
          ...(tier === undefined
            ? {}
            : {
                naicsCode: code,
                industrySource: 'ai' as const,
                industryAt: now,
                suggestionTier: tier,
              }),
          createdAt: now,
          updatedAt: now,
        })
        .run();
      made.push(id);
    }
    return { created: made.length, dropped: skipped, ids: made };
  });
  // One probe of each new suggestion's board: public requests, no AI call, a job of its own.
  for (const id of ids) await enqueueBoardProbe(db, ctx, id);
  return { status: 'suggested', created, dropped };
}

export const companySuggestDedupeKey = (userId: string): string =>
  `${COMPANY_SUGGEST_KIND}:${userId}`;

const DAY_MS = 86_400_000;

/**
 * Queues the run again for the start of the next budget day, the same UTC day as the budget. Not the
 * next week: the hourly drain of postings waiting for the budget can spend each day's budget soon
 * after the day starts, so a weekly run could find no room every week and never run. The key names
 * the day it is for, so the run that is itself waiting can queue the one after it.
 */
async function runAgainNextBudgetDay(db: Db, ctx: UserCtx): Promise<void> {
  const next = startOfUtcDay(Date.now()) + DAY_MS;
  await enqueue(
    db,
    COMPANY_SUGGEST_KIND,
    {},
    {
      userId: ctx.userId,
      runAt: next,
      dedupeKey: `${COMPANY_SUGGEST_KIND}:day:${ctx.userId}:${next}`,
    },
  );
}

export const companySuggestJob: JobHandler<Record<string, never>> = {
  kind: COMPANY_SUGGEST_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) {
      // The weekly instance schedule: one job per user, each acting as that user.
      const ids = await db.select({ id: users.id }).from(users).all();
      for (const { id } of ids) {
        await enqueue(
          db,
          COMPANY_SUGGEST_KIND,
          {},
          { userId: id, dedupeKey: companySuggestDedupeKey(id) },
        );
      }
      await ctx.setResult({ queued: ids.length });
      return;
    }
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    const result = await suggestCompanies(db, user);
    await ctx.setResult(result);
    if (result.status === 'skipped' && result.reason === 'budget_exceeded') {
      await runAgainNextBudgetDay(db, user);
    }
  },
};
