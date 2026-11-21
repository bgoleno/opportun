// Referral suggestions (FR-C3). The candidate set is deterministic and built first: the caller's
// contacts at the opportunity's company, then those whose history names it. The referral.rationale
// task only ranks that set: contacts and opportunity are fenced (*_untrusted), the model must echo
// contact ids, and any id it returns that was not sent is dropped. When AI is unavailable the
// deterministic set comes back unranked (the manual path).
//
// The ranking is kept (#590, the owner's approval of 2026-11-20): keyed on a hash of everything the
// model is sent, so re-opening the tab with nothing changed reuses it with no model call, and a
// change to any input (a contact, the opportunity, its company, the prompt, the model) is a new key
// and a fresh ranking, with nothing to invalidate. Re-rank (?refresh=true) forces one.
import { createHash } from 'node:crypto';
import {
  AiUnavailableError,
  type AiDeps,
  ReferralOutputSchema as AiReferralOutputSchema,
  renderPrompt,
  runStructured,
} from '@opportun/ai';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { companies, networkContacts, referralRankings, SCHEMA_DIALECT } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import type { UserCtx } from '../repos/base';
import { companyKey, sameCompany } from '../repos/communications';
import { readHistory, type ContactHistoryEntry, type ContactRow } from '../repos/contacts';
import { getOpportunity, type OpportunityView } from '../repos/opportunities';
import { getActivePrompt } from '../repos/prompts';
import { newId } from '@opportun/core';
import { IdParams } from './common';

export const REFERRAL_TASK = 'referral.rationale';
/** {ranked: [{contactId, rank, rationale}]} (at most 20); defined once in @opportun/ai. */
export const ReferralOutputSchema = AiReferralOutputSchema;
type ReferralOutput = z.infer<typeof ReferralOutputSchema>;

/** The most candidates one request considers (and sends to the model). */
export const MAX_CANDIDATES = 50;
const MAX_DESCRIPTION_CHARS = 4000;

const RELATIONS = ['current', 'former'] as const;
type Relation = (typeof RELATIONS)[number];

const CandidateSchema = z.object({
  contactId: z.string(),
  name: z.string(),
  linkedinUrl: z.string().nullable(),
  relation: z.enum(RELATIONS),
  currentCompanyName: z.string().nullable(),
  /** The contact's title at the opportunity's company, when their history records it. */
  title: z.string().nullable(),
  strength: z.number().int().nullable(),
  rank: z.number().int().nullable(),
  rationale: z.string().nullable(),
});
type Candidate = z.infer<typeof CandidateSchema>;

const CandidatesSchema = z.object({
  items: z.array(CandidateSchema),
  total: z.number().int(),
  /** True when the model ranked the set; false on the manual path. */
  ranked: z.boolean(),
  /** Why the set is unranked (no_key, budget_exceeded, provider_error, ...), else null. */
  aiUnavailable: z.string().nullable(),
  /** When the ranking shown was made (#590): kept ones keep their time. Null when unranked. */
  rankedAt: z.number().int().nullable(),
});
type Candidates = z.infer<typeof CandidatesSchema>;

const CandidatesQuery = z.object({
  /** rank=false skips the model and returns the deterministic set. */
  rank: z.enum(['true', 'false']).default('true'),
  /** refresh=true makes a fresh ranking (Re-rank, #590) and keeps it in place of the old one. */
  refresh: z.enum(['true', 'false']).default('false'),
});

function companiesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase() || sameCompany(a, b);
}

interface Scored {
  row: ContactRow;
  history: ContactHistoryEntry[];
  relation: Relation;
  currentCompanyName: string | null;
  title: string | null;
}

/** A LIKE pattern for `word` anywhere: its %, _ and the escape character are literal. */
const containing = (word: string): string => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The SQL pre-filter on a contact's history (#590 criterion 3): true for every contact whose
 * history the JS matcher below can accept, so only those are read, and false for most others.
 *
 * Any company the matcher accepts shares the first word of the opportunity company's key: equal
 * keys, or one a whole-word prefix of the other (sameCompany), and a case-blind equal name gives an
 * equal key. words() folds accents and keeps a-z0-9 only, so in ASCII-only history that word is
 * a lowercase substring of the stored text; history holding any other character is kept whole, as
 * no ASCII pattern can rule it out. With no key (a name of suffixes only, "Inc"), only the equal
 * name can match, so the name itself is the pattern. tl's conditions on #590: the word is escaped,
 * and contactPrefilter.test.ts runs the matcher's own cases through it.
 */
function historyMayName(companyName: string): SQL {
  const first = companyKey(companyName).split(' ')[0] ?? '';
  const word = first !== '' ? first : companyName.trim().toLowerCase();
  const text =
    SCHEMA_DIALECT === 'postgres'
      ? sql`lower(${networkContacts.history}::text)`
      : sql`lower(${networkContacts.history})`;
  const notAscii =
    SCHEMA_DIALECT === 'postgres'
      ? sql`${networkContacts.history}::text ~ '[^ -~]'`
      : sql`${networkContacts.history} GLOB '*[^ -~]*'`;
  if (word === '') return notAscii;
  return sql`(${text} LIKE ${containing(word)} ESCAPE '\\' OR ${notAscii})`;
}

/** The contacts that can match `opp` (criterion 3): read with the pre-filter, not every one. */
export async function candidateContacts(
  db: Db,
  ctx: UserCtx,
  opp: OpportunityView,
  names: ReadonlyMap<string, string>,
): Promise<ContactRow[]> {
  const atCompany = [...names]
    .filter(([id, name]) => id === opp.companyId || companiesMatch(name, opp.companyName))
    .map(([id]) => id);
  return await db
    .select()
    .from(networkContacts)
    .where(
      and(
        eq(networkContacts.userId, ctx.userId),
        or(
          atCompany.length === 0 ? undefined : inArray(networkContacts.currentCompanyId, atCompany),
          historyMayName(opp.companyName),
        ),
      ),
    )
    .all();
}

/** The deterministic candidate set, in display order. */
export async function candidateSet(db: Db, ctx: UserCtx, opp: OpportunityView): Promise<Scored[]> {
  const names = new Map(
    (
      await db
        .select({ id: companies.id, name: companies.name })
        .from(companies)
        .where(eq(companies.userId, ctx.userId))
        .all()
    ).map((c) => [c.id, c.name]),
  );
  const out: Scored[] = [];
  for (const row of await candidateContacts(db, ctx, opp, names)) {
    const scored = scoreContact(row, names, opp);
    if (scored !== null) out.push(scored);
  }
  const order = (s: Scored) => (s.relation === 'current' ? 0 : 1);
  out.sort(
    (x, y) =>
      order(x) - order(y) ||
      (y.row.strength ?? 0) - (x.row.strength ?? 0) ||
      x.row.name.localeCompare(y.row.name) ||
      x.row.id.localeCompare(y.row.id),
  );
  return out.slice(0, MAX_CANDIDATES);
}

/** The matcher: whether `row` can refer for `opp`, current or former, and how (as before #590). */
export function scoreContact(
  row: ContactRow,
  names: ReadonlyMap<string, string>,
  opp: Pick<OpportunityView, 'companyId' | 'companyName'>,
): Scored | null {
  const current = row.currentCompanyId === null ? null : (names.get(row.currentCompanyId) ?? null);
  const history = readHistory(row.history);
  const atCompany = history.filter((h) => companiesMatch(h.company, opp.companyName));
  const isCurrent =
    row.currentCompanyId === opp.companyId ||
    (current !== null && companiesMatch(current, opp.companyName));
  if (!isCurrent && atCompany.length === 0) return null;
  return {
    row,
    history,
    relation: isCurrent ? 'current' : 'former',
    currentCompanyName: current,
    title: atCompany.at(-1)?.title ?? null,
  };
}

/** One value of fenced data on one line: control characters and runs of whitespace collapse. */
function flat(value: string, max = 200): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function contactLine(s: Scored): string {
  const parts = [`id: ${s.row.id}`, `name: ${flat(s.row.name)}`];
  const latest = s.history.at(-1);
  if (s.currentCompanyName !== null) {
    const title =
      latest !== undefined && companiesMatch(latest.company, s.currentCompanyName)
        ? latest.title
        : null;
    parts.push(`now: ${flat(s.currentCompanyName)}${title === null ? '' : `, ${flat(title)}`}`);
  }
  if (s.row.strength !== null) parts.push(`strength: ${s.row.strength}`);
  const past = s.history
    .filter(
      (h) => s.currentCompanyName === null || !companiesMatch(h.company, s.currentCompanyName),
    )
    .map((h) => {
      const when = [h.from, h.to].filter((x) => x !== null).join(' to ');
      const detail = [h.title, when === '' ? null : when].filter((x) => x !== null).join(', ');
      return `${flat(h.company)}${detail === '' ? '' : ` (${flat(detail)})`}`;
    });
  if (past.length > 0) parts.push(`history: ${past.join('; ')}`);
  return `- ${parts.join(' | ')}`;
}

function opportunityText(opp: OpportunityView): string {
  const lines = [`Company: ${flat(opp.companyName)}`, `Title: ${flat(opp.title, 300)}`];
  if (opp.location !== null) lines.push(`Location: ${flat(opp.location)}`);
  if (opp.descriptionMd !== null && opp.descriptionMd.trim() !== '') {
    const d = opp.descriptionMd.trim();
    lines.push(
      '',
      'Description:',
      d.length > MAX_DESCRIPTION_CHARS ? `${d.slice(0, MAX_DESCRIPTION_CHARS)}\n[truncated]` : d,
    );
  }
  return lines.join('\n');
}

/**
 * Keeps only entries naming a contact that was sent (first mention wins), in rank order, and
 * renumbers them 1..n.
 */
export function validateRanking(
  out: ReferralOutput,
  sent: ReadonlySet<string>,
): Map<string, { rank: number; rationale: string }> {
  const seen = new Set<string>();
  const kept = out.ranked
    .map((r, i) => ({ ...r, i }))
    .filter((r) => {
      if (!sent.has(r.contactId) || seen.has(r.contactId)) return false;
      seen.add(r.contactId);
      return true;
    })
    .sort((x, y) => x.rank - y.rank || x.i - y.i);
  return new Map(kept.map((r, i) => [r.contactId, { rank: i + 1, rationale: r.rationale.trim() }]));
}

function toCandidate(s: Scored, ranking?: { rank: number; rationale: string }): Candidate {
  return {
    contactId: s.row.id,
    name: s.row.name,
    linkedinUrl: s.row.linkedinUrl,
    relation: s.relation,
    currentCompanyName: s.currentCompanyName,
    title: s.title,
    strength: s.row.strength,
    rank: ranking?.rank ?? null,
    rationale: ranking?.rationale ?? null,
  };
}

type Ranking = { contactId: string; rank: number; rationale: string }[];

/**
 * Whether a model call would be allowed now, by the checks the call itself makes first (policy,
 * the task's budget, the key), without recording anything. A kept ranking is used only then: with
 * the key removed or the budget spent, the outcome is the unranked one, as before #590 (tl, AC4).
 */
async function callAllowed(deps: AiDeps): Promise<boolean> {
  const policy = await deps.policyFor(REFERRAL_TASK);
  if ((await deps.spentTodayUsd(REFERRAL_TASK)) >= deps.budget.perTaskDailyUsd) return false;
  try {
    await deps.getKey(policy.provider);
    return true;
  } catch {
    return false;
  }
}

/**
 * The kept ranking's key: a hash of everything the model is given, and of the policy it is given
 * to. Never the key, nor anything derived from it (tl on #590).
 */
async function inputHash(
  deps: AiDeps,
  call: { system: string; prompt: string; promptId: string },
): Promise<string> {
  const p = await deps.policyFor(REFERRAL_TASK);
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...call,
        provider: p.provider,
        model: p.model,
        baseUrl: p.baseUrl ?? null,
        temperature: p.temperature ?? null,
        maxOutputTokens: p.maxOutputTokens,
      }),
    )
    .digest('hex');
}

export async function referralCandidates(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  opts: { rank: boolean; refresh?: boolean },
): Promise<Candidates> {
  const opp = await getOpportunity(db, ctx, opportunityId);
  const set = await candidateSet(db, ctx, opp);
  const unranked = (aiUnavailable: string | null): Candidates => ({
    items: set.map((s) => toCandidate(s)),
    total: set.length,
    ranked: false,
    aiUnavailable,
    rankedAt: null,
  });
  if (set.length === 0 || !opts.rank) return unranked(null);

  const prompt = await getActivePrompt(db, ctx, REFERRAL_TASK);
  if (prompt === undefined) return unranked('no_prompt');
  const call = {
    system: renderPrompt(prompt.body, {
      contacts_untrusted: set.map(contactLine).join('\n'),
      opportunity_untrusted: opportunityText(opp),
    }),
    prompt: 'Rank the contacts and return the result.',
    promptId: prompt.id,
  };
  const deps = await buildAiDeps(db, ctx);
  const sent = new Set(set.map((s) => s.row.id));
  const ranked = (ranking: Map<string, { rank: number; rationale: string }>, at: number) => {
    const first = set
      .filter((s) => ranking.has(s.row.id))
      .sort((x, y) => (ranking.get(x.row.id)?.rank ?? 0) - (ranking.get(y.row.id)?.rank ?? 0));
    const rest = set.filter((s) => !ranking.has(s.row.id));
    return {
      items: [
        ...first.map((s) => toCandidate(s, ranking.get(s.row.id))),
        ...rest.map((s) => toCandidate(s)),
      ],
      total: set.length,
      ranked: true,
      aiUnavailable: null,
      rankedAt: at,
    };
  };

  // Only when a call would be allowed: otherwise the call below says why, as before.
  const fingerprint = (await callAllowed(deps)) ? await inputHash(deps, call) : null;
  if (fingerprint !== null && opts.refresh !== true) {
    const kept = await db
      .select()
      .from(referralRankings)
      .where(
        and(
          eq(referralRankings.userId, ctx.userId),
          eq(referralRankings.opportunityId, opp.id),
          eq(referralRankings.inputHash, fingerprint),
        ),
      )
      .get();
    if (kept !== undefined) {
      // The same hash means the same set was sent; an id not in it is dropped all the same.
      const ranking = new Map(
        kept.ranking
          .filter((r) => sent.has(r.contactId))
          .map((r) => [r.contactId, { rank: r.rank, rationale: r.rationale }]),
      );
      return ranked(ranking, kept.rankedAt);
    }
  }

  let out: ReferralOutput;
  try {
    out = await runStructured(deps, REFERRAL_TASK, { ...call, schema: ReferralOutputSchema });
  } catch (err) {
    // No key, over budget, provider down or invalid output: the manual path. A kept ranking stays.
    if (err instanceof AiUnavailableError) return unranked(err.reason);
    throw err;
  }
  const ranking = validateRanking(out, sent);
  const now = Date.now();
  if (fingerprint !== null) {
    const rows: Ranking = [...ranking].map(([contactId, r]) => ({ contactId, ...r }));
    // One row per opportunity: a fresh ranking replaces the one before it (tl on #590).
    await db
      .insert(referralRankings)
      .values({
        id: newId(),
        userId: ctx.userId,
        opportunityId: opp.id,
        inputHash: fingerprint,
        ranking: rows,
        rankedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [referralRankings.userId, referralRankings.opportunityId],
        set: { inputHash: fingerprint, ranking: rows, rankedAt: now, updatedAt: now },
      })
      .run();
  }
  return ranked(ranking, now);
}

export async function referralRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/opportunities/:id/referral-candidates',
    {
      schema: {
        params: IdParams,
        querystring: CandidatesQuery,
        response: { 200: CandidatesSchema },
      },
    },
    async (req) =>
      referralCandidates(db, app.requireUser(req), req.params.id, {
        rank: req.query.rank === 'true',
        refresh: req.query.refresh === 'true',
      }),
  );
}
