// Suggest industries (https://github.com/bgoleno/opportun/issues/219, #190 N4a): one call over the
// base resume and the role targets. What goes in is decided here, and a test holds the request to
// it byte for byte: the resume's text, three fields of each active role target, and the static
// NAICS table. No contact, company or opportunity is read, so none can be sent. Resume text does go
// to the user's AI provider, as it does for resume.match, and only because the user asked.
import { IndustryProfileOutputSchema, renderPrompt, runStructured } from '@opportun/ai';
import { isNaicsCode, NAICS_2022_INDUSTRY_GROUPS } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../db/client';
import { roleTargets } from '../db/schema';
import type { UserCtx } from '../repos/base';
import { discoveryBudgetHasRoom } from '../repos/discoveryBudget';
import { replaceSuggestions, type IndustrySuggestion } from '../repos/industryProfile';
import { getActivePrompt } from '../repos/prompts';
import { buildAiDeps } from './ai';
import { HttpError } from './errors';
import { line } from './promptText';

const TASK = 'discovery.industry_profile';
/** A long CV is still far under this; it keeps one odd document from a very large call. */
const MAX_RESUME_CHARS = 60_000;
const MAX_SUGGESTIONS = 40;
const MAX_REASON_CHARS = 300;

const NAICS_TABLE_TEXT = NAICS_2022_INDUSTRY_GROUPS.map((g) => `${g.code} ${g.title}`).join('\n');

type TargetFields = Pick<
  typeof roleTargets.$inferSelect,
  'titleFamily' | 'industries' | 'keywords'
>;

/** Only these three fields of a role target: not its name, places, pay or anything else. */
function targetLine(t: TargetFields): string {
  const parts = [`title family: ${line(t.titleFamily)}`];
  if (t.industries.length > 0) {
    parts.push(`industries: ${t.industries.map((k) => line(k, 60)).join(', ')}`);
  }
  if (t.keywords.length > 0) {
    parts.push(`keywords: ${t.keywords.map((k) => line(k, 60)).join(', ')}`);
  }
  return `- ${parts.join('; ')}`;
}

/**
 * The rows worth storing from an answer: codes in the table, the first of any repeat, and a reason
 * as one bounded line. A row with no reason is dropped, since the reason is what the user judges.
 */
export function cleanSuggestions(
  answer: z.infer<typeof IndustryProfileOutputSchema>,
): IndustrySuggestion[] {
  const seen = new Set<string>();
  const out: IndustrySuggestion[] = [];
  for (const row of answer.industries) {
    const code = row.code.trim();
    const reason = line(row.reason, MAX_REASON_CHARS);
    if (!isNaicsCode(code) || seen.has(code) || reason === '') continue;
    seen.add(code);
    out.push({ code, tier: row.tier, source: row.source, reason });
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

const refused = (reason: string): HttpError =>
  new HttpError(503, 'ai_unavailable', undefined, { reason });

/**
 * Makes the one call and stores what comes back. `resumeText` is null with no base resume; it is
 * read only once the checks that need no call have passed. An answer with nothing usable leaves
 * the profile as it was. Throws AiUnavailableError as the router does, for the route to report.
 */
export async function suggestIndustries(
  db: Db,
  ctx: UserCtx,
  readResume: (() => Promise<string>) | null,
): Promise<{ suggested: number }> {
  const targets = await db
    .select({
      titleFamily: roleTargets.titleFamily,
      industries: roleTargets.industries,
      keywords: roleTargets.keywords,
    })
    .from(roleTargets)
    .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.active, true)))
    .all();
  if (readResume === null && targets.length === 0) {
    throw new HttpError(422, 'no_profile_input', 'Add a base resume or a role target first.');
  }
  // Over the budget nothing waits, unlike a posting: the user asked now, so they are told now.
  if (!(await discoveryBudgetHasRoom(db, ctx))) throw refused('budget_exceeded');
  const prompt = await getActivePrompt(db, ctx, TASK);
  if (prompt === undefined) throw refused('no_prompt');
  const resumeText = readResume === null ? '(no resume)' : await readResume();

  const answer = await runStructured(await buildAiDeps(db, ctx), TASK, {
    system: renderPrompt(prompt.body, {
      resume_untrusted: resumeText.slice(0, MAX_RESUME_CHARS),
      role_targets: targets.length === 0 ? '(none)' : targets.map(targetLine).join('\n'),
      naics_table: NAICS_TABLE_TEXT,
    }),
    prompt: 'Choose the industries and return the result.',
    schema: IndustryProfileOutputSchema,
    promptId: prompt.id,
  });
  const usable = cleanSuggestions(answer);
  if (usable.length === 0) return { suggested: 0 };
  return { suggested: await replaceSuggestions(db, ctx, usable) };
}
