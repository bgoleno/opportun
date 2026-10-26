// Referral suggestions (FR-C3). The candidate set is deterministic and built first: the caller's
// contacts at the opportunity's company, then those whose history names it. The referral.rationale
// task only ranks that set: contacts and opportunity are fenced (*_untrusted), the model must echo
// contact ids, and any id it returns that was not sent is dropped. When AI is unavailable the
// deterministic set comes back unranked (the manual path).
import {
  AiUnavailableError,
  ReferralOutputSchema as AiReferralOutputSchema,
  renderPrompt,
  runStructured,
} from '@opportun/ai';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { companies, contacts } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import type { UserCtx } from '../repos/base';
import { sameCompany } from '../repos/communications';
import { readHistory, type ContactHistoryEntry, type ContactRow } from '../repos/contacts';
import { getOpportunity, type OpportunityView } from '../repos/opportunities';
import { getActivePrompt } from '../repos/prompts';
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
  /** Why the set is unranked (no_key, over_budget, provider_error, ...), else null. */
  aiUnavailable: z.string().nullable(),
});
type Candidates = z.infer<typeof CandidatesSchema>;

const CandidatesQuery = z.object({
  /** rank=false skips the model and returns the deterministic set. */
  rank: z.enum(['true', 'false']).default('true'),
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
  for (const row of await db.select().from(contacts).where(eq(contacts.userId, ctx.userId)).all()) {
    const current =
      row.currentCompanyId === null ? null : (names.get(row.currentCompanyId) ?? null);
    const history = readHistory(row.history);
    const atCompany = history.filter((h) => companiesMatch(h.company, opp.companyName));
    const isCurrent =
      row.currentCompanyId === opp.companyId ||
      (current !== null && companiesMatch(current, opp.companyName));
    if (!isCurrent && atCompany.length === 0) continue;
    out.push({
      row,
      history,
      relation: isCurrent ? 'current' : 'former',
      currentCompanyName: current,
      title: atCompany.at(-1)?.title ?? null,
    });
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

export async function referralCandidates(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  opts: { rank: boolean },
): Promise<Candidates> {
  const opp = await getOpportunity(db, ctx, opportunityId);
  const set = await candidateSet(db, ctx, opp);
  const unranked = (aiUnavailable: string | null): Candidates => ({
    items: set.map((s) => toCandidate(s)),
    total: set.length,
    ranked: false,
    aiUnavailable,
  });
  if (set.length === 0 || !opts.rank) return unranked(null);

  const prompt = await getActivePrompt(db, ctx, REFERRAL_TASK);
  if (prompt === undefined) return unranked('no_prompt');
  let out: ReferralOutput;
  try {
    out = await runStructured(await buildAiDeps(db, ctx), REFERRAL_TASK, {
      system: renderPrompt(prompt.body, {
        contacts_untrusted: set.map(contactLine).join('\n'),
        opportunity_untrusted: opportunityText(opp),
      }),
      prompt: 'Rank the contacts and return the result.',
      schema: ReferralOutputSchema,
      promptId: prompt.id,
    });
  } catch (err) {
    // No key, over budget, provider down or invalid output: the manual path.
    if (err instanceof AiUnavailableError) return unranked(err.reason);
    throw err;
  }
  const ranking = validateRanking(out, new Set(set.map((s) => s.row.id)));
  const ranked = set
    .filter((s) => ranking.has(s.row.id))
    .sort((x, y) => (ranking.get(x.row.id)?.rank ?? 0) - (ranking.get(y.row.id)?.rank ?? 0));
  const rest = set.filter((s) => !ranking.has(s.row.id));
  return {
    items: [
      ...ranked.map((s) => toCandidate(s, ranking.get(s.row.id))),
      ...rest.map((s) => toCandidate(s)),
    ],
    total: set.length,
    ranked: true,
    aiUnavailable: null,
  };
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
      }),
  );
}
