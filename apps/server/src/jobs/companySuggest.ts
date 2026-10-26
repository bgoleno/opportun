// AI company suggestions (FR-D8). Weekly, for each user, the company.suggest task proposes
// companies worth following, from the user's role targets, the companies already in their
// pipeline (name and status), the titles they recently accepted or dismissed, and the companies
// they denied. Names and titles are third-party data, so the pipeline and the denied list are
// rendered as *_untrusted (fenced by renderPrompt).
//
// A suggestion becomes a company row with status 'suggested' and its rationale; nothing is
// followed until the user accepts it (routes/companySuggestions.ts). A name that matches any
// company the user already has, whatever its status, is skipped (normalized compare), so a
// denied company is never suggested again and a pending suggestion is not duplicated.
import { AiUnavailableError, renderPrompt, runStructured, SuggestOutputSchema } from '@opportun/ai';
import { newId } from '@opportun/core';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/client';
import { companies, discoveryResults, users } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { withMatchKey } from '../repos/companies';
import type { UserCtx } from '../repos/base';
import { getActivePrompt } from '../repos/prompts';
import { line } from '../lib/promptText';
import { roleTargetsText } from './classify';
import type { JobHandler } from './registry';
import { enqueue } from './runner';

export const COMPANY_SUGGEST_KIND = 'company.suggest'; // per user via the job's user_id
/** Weekly, Tuesday 08:00. */
export const COMPANY_SUGGEST_CRON = '0 8 * * 2';

const MAX_PIPELINE_COMPANIES = 200;
const MAX_RECENT_TITLES = 50;
const MAX_DENIED = 500;
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

// ---------------------------------------------------------------------------
// The run

export type SuggestRun =
  { status: 'suggested'; created: number } | { status: 'skipped'; reason: string };

/** Runs company.suggest for one user and stores new suggestions. */
export async function suggestCompanies(db: Db, ctx: UserCtx): Promise<SuggestRun> {
  const prompt = await getActivePrompt(db, ctx, COMPANY_SUGGEST_KIND);
  if (prompt === undefined) return { status: 'skipped', reason: 'no_prompt' };
  let out: z.infer<typeof SuggestOutputSchema>;
  try {
    out = await runStructured(await buildAiDeps(db, ctx), COMPANY_SUGGEST_KIND, {
      system: renderPrompt(prompt.body, {
        role_targets: await roleTargetsText(db, ctx),
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
  const created = await withTransaction(db, async (tx) => {
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
    let n = 0;
    for (const s of out.suggestions) {
      const name = cleanName(s.name);
      if (name.length === 0) continue;
      const key = normalizeCompanyName(name);
      if (key.length === 0 || known.has(key)) continue;
      known.add(key);
      const now = Date.now();
      await tx
        .insert(companies)
        .values({
          id: newId(),
          userId: ctx.userId,
          ...withMatchKey({ name }),
          domain: cleanDomainGuess(s.domainGuess),
          status: 'suggested',
          suggestionRationale: s.rationale.trim().slice(0, MAX_RATIONALE_CHARS) || null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      n += 1;
    }
    return n;
  });
  return { status: 'suggested', created };
}

export const companySuggestDedupeKey = (userId: string): string =>
  `${COMPANY_SUGGEST_KIND}:${userId}`;

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
    await ctx.setResult(await suggestCompanies(db, { userId: ctx.userId, isAdmin: false }));
  },
};
