// Tailoring sessions (FR-R4, R5, R8): one transcript per resume tailoring conversation. The
// transcript is rewritten in a transaction per change, so turns are never lost to a race
// between an append and a streaming update.
import { newId } from '@opportun/core';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { resumeRules, tailoringSessions, type TranscriptTurn } from '../db/schema';
import { HttpError, notFound } from '../lib/errors';
import type { Db, Exec, UserCtx } from './base';
import { getResume } from './resumes';
import { withTransaction } from '../db/client';

export type SessionRow = typeof tailoringSessions.$inferSelect;
export type { TranscriptTurn };

async function load(exec: Exec, ctx: UserCtx, id: string): Promise<SessionRow> {
  const row = await exec
    .select()
    .from(tailoringSessions)
    .where(and(eq(tailoringSessions.userId, ctx.userId), eq(tailoringSessions.id, id)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

export async function getSession(db: Db, ctx: UserCtx, id: string): Promise<SessionRow> {
  return await load(db, ctx, id);
}

/** The resume's open (not completed) session, created when there is none. */
export async function openSession(db: Db, ctx: UserCtx, resumeId: string): Promise<SessionRow> {
  await getResume(db, ctx, resumeId);
  return await withTransaction(db, async (tx) => {
    const open = await tx
      .select()
      .from(tailoringSessions)
      .where(
        and(
          eq(tailoringSessions.userId, ctx.userId),
          eq(tailoringSessions.resumeId, resumeId),
          isNull(tailoringSessions.acceptedAt),
        ),
      )
      .orderBy(desc(tailoringSessions.createdAt), desc(tailoringSessions.id))
      .get();
    if (open !== undefined) return open;
    const now = Date.now();
    return await tx
      .insert(tailoringSessions)
      .values({
        id: newId(),
        userId: ctx.userId,
        resumeId,
        taskRunIds: [],
        transcript: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
}

async function rewrite(
  db: Db,
  ctx: UserCtx,
  id: string,
  change: (
    row: SessionRow,
  ) => Partial<Pick<SessionRow, 'transcript' | 'taskRunIds' | 'acceptedAt'>>,
): Promise<SessionRow> {
  return await withTransaction(db, async (tx) => {
    const row = await load(tx, ctx, id);
    return await tx
      .update(tailoringSessions)
      .set({ ...change(row), updatedAt: Date.now() })
      .where(and(eq(tailoringSessions.userId, ctx.userId), eq(tailoringSessions.id, id)))
      .returning()
      .get();
  });
}

/** Appends a turn; returns its index in the transcript. */
export async function appendTurn(
  db: Db,
  ctx: UserCtx,
  id: string,
  turn: TranscriptTurn,
): Promise<number> {
  let index = -1;
  await rewrite(db, ctx, id, (row) => {
    index = row.transcript.length;
    return { transcript: [...row.transcript, turn] };
  });
  return index;
}

export async function replaceTurn(
  db: Db,
  ctx: UserCtx,
  id: string,
  index: number,
  turn: TranscriptTurn,
): Promise<void> {
  await rewrite(db, ctx, id, (row) => ({
    transcript: row.transcript.map((t, i) => (i === index ? turn : t)),
  }));
}

export async function addTaskRunId(db: Db, ctx: UserCtx, id: string, runId: string): Promise<void> {
  await rewrite(db, ctx, id, (row) => ({ taskRunIds: [...row.taskRunIds, runId] }));
}

/** Marks the session accepted. 409 when it already was. */
export async function completeSession(db: Db, ctx: UserCtx, id: string): Promise<SessionRow> {
  return await rewrite(db, ctx, id, (row) => {
    if (row.acceptedAt !== null) throw new HttpError(409, 'session_closed');
    return { acceptedAt: Date.now() };
  });
}

/** The caller's active resume rules, in their order: read fresh for every AI call. */
export async function activeResumeRules(db: Db, ctx: UserCtx): Promise<string[]> {
  return (
    await db
      .select({ ruleText: resumeRules.ruleText })
      .from(resumeRules)
      .where(and(eq(resumeRules.userId, ctx.userId), eq(resumeRules.active, true)))
      .orderBy(asc(resumeRules.sortOrder), asc(resumeRules.createdAt), asc(resumeRules.id))
      .all()
  ).map((r) => r.ruleText);
}

// ---------------------------------------------------------------------------
// Suggestions: the model ends a reply that proposes changes with one fenced json block,
// {"edits": [{"find", "replace", "rationale"}]} (the resume.tailor seed prompt asks for it).

export const SuggestedEditSchema = z.object({
  find: z.string().min(1).max(5000),
  replace: z.string().max(5000),
  rationale: z.string().max(2000).optional(),
});
const SuggestionBlockSchema = z.object({ edits: z.array(SuggestedEditSchema).max(50) });
export type SuggestedEdit = z.infer<typeof SuggestedEditSchema>;

const FENCED_JSON = /```json[^\S\n]*\n([\s\S]*?)\n?```/g;

/**
 * The reply split into prose and its validated edits. Only the last fenced json block counts;
 * a block that does not parse or validate yields no edits and stays in the prose.
 */
export function parseSuggestions(text: string): { prose: string; edits: SuggestedEdit[] } {
  const blocks = [...text.matchAll(FENCED_JSON)];
  const last = blocks.at(-1);
  if (last === undefined) return { prose: text.trim(), edits: [] };
  let json: unknown;
  try {
    json = JSON.parse(last[1] as string);
  } catch {
    return { prose: text.trim(), edits: [] };
  }
  const parsed = SuggestionBlockSchema.safeParse(json);
  if (!parsed.success) return { prose: text.trim(), edits: [] };
  const prose = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  return { prose, edits: parsed.data.edits };
}
