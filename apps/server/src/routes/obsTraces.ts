// The AI trace dashboard's API (FR-T7; design.md 14.7, 14.12;
// https://github.com/bgoleno/opportun/issues/347). It reads the local store the span store
// keeps (obs_traces, obs_spans) and nothing else, so it works with export off.
//
// - Every query is scoped to the caller, an admin included: a trace is always one user's (14.7),
//   and nobody sees another user's (tl on #347). The span filters are scoped too, so a filter
//   can never match, or reveal, another user's span.
// - Filter values are bound, never interpolated, and each is shape-checked by the schema first.
// - No content is shown, because none is stored (14.7). A span's attributes are shown only for
//   keys the catalog lists (obs/catalog.ts), less every `id` and `ip` key: a row id tells the
//   reader nothing, and the catalog is the rule for what may be kept at all (14.8), so a row
//   written by an older catalog or around the gate still shows nothing outside it.
// - Where content does live, the view links to it: a chat trace to its tailoring session, by
//   the caller's own session row, and a span to its prompt by task key and version (14.5's
//   gen_ai.prompt.name and gen_ai.prompt.version), never by the prompt's row id (tl on #347).
// - Not built here: resolving a company id to its name. No catalogued attribute carries a
//   company id yet; the slice that first catalogs one adds the lookup here, scoped to the
//   caller (tl on #347).
import { TASK_KEYS } from '@opportun/ai';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  OBS_SPAN_KINDS,
  OBS_SPAN_STATUSES,
  obsSpans,
  obsTraces,
  tailoringSessions,
} from '../db/schema';
import { notFound } from '../lib/errors';
import { ATTRIBUTE_TYPES } from '../obs/catalog';
import { readCollect } from '../obs/config';
import { requireUser } from '../repos/base';

/** The most spans one trace keeps (14.11): the waterfall never needs more. */
export const MAX_TRACE_SPANS = 2000;

// The shapes the store's columns hold (14.8): a task key or `key_check`, a model id, a provider
// id. A filter value of any other shape matches nothing anyway, so it is refused up front.
const TASK = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);
const MODEL = z
  .string()
  .regex(/^[A-Za-z0-9._:-]+(\/[A-Za-z0-9._:-]+)?$/)
  .max(128);
const PROVIDER = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const ROW_ID = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const TIME = z.coerce.number().int().min(0);
/** The list's cursor: the last trace's start and id, so a tie on the start breaks by id. */
const CURSOR = /^(\d{1,16})\.([0-9a-f]{32})$/;

const ListQuery = z.object({
  task: TASK.optional(),
  model: MODEL.optional(),
  provider: PROVIDER.optional(),
  status: z.enum(OBS_SPAN_STATUSES).optional(),
  from: TIME.optional(),
  to: TIME.optional(),
  conversation: ROW_ID.optional(),
  cursor: z.string().regex(CURSOR).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const TraceParams = z.object({ traceId: z.string().regex(/^[0-9a-f]{32}$/) });

const TraceView = z.object({
  traceId: z.string(),
  startedAt: z.number(),
  durationMs: z.number(),
  origin: z.string(),
  workflow: z.string().nullable(),
  feature: z.string().nullable(),
  conversationId: z.string().nullable(),
  tasks: z.array(z.string()),
  models: z.array(z.string()),
  providers: z.array(z.string()),
  inputTokens: z.number(),
  outputTokens: z.number(),
  estCostUsd: z.number(),
  spanCount: z.number(),
  errorCount: z.number(),
  status: z.enum(OBS_SPAN_STATUSES),
  truncated: z.boolean(),
});
type TraceViewT = z.infer<typeof TraceView>;

const AttrValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const SpanView = z.object({
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  name: z.string(),
  kind: z.enum(OBS_SPAN_KINDS),
  startedAt: z.number(),
  durationMs: z.number(),
  status: z.enum(OBS_SPAN_STATUSES),
  errorType: z.string().nullable(),
  task: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  attributes: z.record(z.string(), AttrValue),
  prompt: z.object({ name: z.string(), version: z.number().int().nullable() }).nullable(),
});

const ListView = z.object({
  /** Whether collection is on now. Traces collected earlier are listed either way (14.1). */
  collect: z.boolean(),
  items: z.array(TraceView),
  next: z.string().nullable(),
});

const FiltersView = z.object({
  tasks: z.array(z.string()),
  models: z.array(z.string()),
  providers: z.array(z.string()),
});

const DetailView = z.object({
  trace: TraceView,
  spans: z.array(SpanView),
  /** The caller's own tailoring session the chat trace belongs to, or null. */
  conversation: z.object({ id: z.string(), resumeId: z.string() }).nullable(),
});

type TraceRow = typeof obsTraces.$inferSelect;
type SpanRow = typeof obsSpans.$inferSelect;

function toTraceView(t: TraceRow): TraceViewT {
  return {
    traceId: t.traceId,
    startedAt: t.startedAt,
    durationMs: t.durationMs,
    origin: t.origin,
    workflow: t.workflow,
    feature: t.feature,
    conversationId: t.conversationId,
    tasks: t.tasks,
    models: t.models,
    providers: t.providers,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    estCostUsd: t.estCost,
    spanCount: t.spanCount,
    errorCount: t.errorCount,
    status: t.status,
    truncated: t.truncated,
  };
}

/** A stored value of a type the view can show; anything else (an object, null) is not shown. */
function isShowable(v: unknown): v is z.infer<typeof AttrValue> {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** The attributes a reader sees: catalogued keys only, less row ids and addresses. */
export function shownAttributes(
  stored: Record<string, unknown>,
): Record<string, z.infer<typeof AttrValue>> {
  const out: Record<string, z.infer<typeof AttrValue>> = {};
  for (const [key, value] of Object.entries(stored)) {
    const type = ATTRIBUTE_TYPES.get(key);
    if (type === undefined || type.kind === 'id' || type.kind === 'ip') continue;
    if (isShowable(value)) out[key] = value;
  }
  return out;
}

const TASK_KEY_SET: ReadonlySet<string> = new Set(TASK_KEYS);

/**
 * The prompt a span used, from gen_ai.prompt.name (the task key) and gen_ai.prompt.version
 * (14.5). Checked here, not taken on trust: a name that is not a task key is no prompt, and a
 * version that is not a whole number is left out.
 */
function promptOf(
  stored: Record<string, unknown>,
): { name: string; version: number | null } | null {
  const name = stored['gen_ai.prompt.name'];
  if (typeof name !== 'string' || !TASK_KEY_SET.has(name)) return null;
  const v = stored['gen_ai.prompt.version'];
  const version = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  return { name, version };
}

function toSpanView(s: SpanRow): z.infer<typeof SpanView> {
  return {
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    name: s.name,
    kind: s.kind,
    startedAt: s.startedAt,
    durationMs: s.durationMs,
    status: s.status,
    errorType: s.errorType,
    task: s.task,
    model: s.model,
    provider: s.provider,
    attributes: shownAttributes(s.attributes),
    prompt: promptOf(s.attributes),
  };
}

const sortedDistinct = (values: (string | null)[]): string[] =>
  [...new Set(values.filter((v): v is string => v !== null))].sort();

export async function obsTraceRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  /** The ids of the caller's traces that have a span matching `cond` (14.7: through obs_spans). */
  const tracesWithSpan = (userId: string, cond: SQL) =>
    db
      .select({ traceId: obsSpans.traceId })
      .from(obsSpans)
      .where(and(eq(obsSpans.userId, userId), cond));

  api.get(
    '/obs/traces',
    { schema: { querystring: ListQuery, response: { 200: ListView } } },
    async (req) => {
      const { userId } = requireUser(req);
      const q = req.query;
      const conds: (SQL | undefined)[] = [eq(obsTraces.userId, userId)];
      if (q.task !== undefined)
        conds.push(inArray(obsTraces.traceId, tracesWithSpan(userId, eq(obsSpans.task, q.task))));
      if (q.model !== undefined)
        conds.push(inArray(obsTraces.traceId, tracesWithSpan(userId, eq(obsSpans.model, q.model))));
      if (q.provider !== undefined) {
        conds.push(
          inArray(obsTraces.traceId, tracesWithSpan(userId, eq(obsSpans.provider, q.provider))),
        );
      }
      if (q.status !== undefined) conds.push(eq(obsTraces.status, q.status));
      if (q.from !== undefined) conds.push(gte(obsTraces.startedAt, q.from));
      if (q.to !== undefined) conds.push(lte(obsTraces.startedAt, q.to));
      if (q.conversation !== undefined) conds.push(eq(obsTraces.conversationId, q.conversation));
      if (q.cursor !== undefined) {
        const [, at = '0', id = ''] = CURSOR.exec(q.cursor) ?? [];
        const startedAt = Number(at);
        conds.push(
          or(
            lt(obsTraces.startedAt, startedAt),
            and(eq(obsTraces.startedAt, startedAt), lt(obsTraces.traceId, id)),
          ),
        );
      }
      // One more than the page, to know whether there is a next one.
      const rows = await db
        .select()
        .from(obsTraces)
        .where(and(...conds))
        .orderBy(desc(obsTraces.startedAt), desc(obsTraces.traceId))
        .limit(q.limit + 1)
        .all();
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        collect: await readCollect(db),
        items: page.map(toTraceView),
        next:
          rows.length > q.limit && last !== undefined ? `${last.startedAt}.${last.traceId}` : null,
      };
    },
  );

  api.get('/obs/traces/filters', { schema: { response: { 200: FiltersView } } }, async (req) => {
    const { userId } = requireUser(req);
    const rows = await db
      .selectDistinct({ task: obsSpans.task, model: obsSpans.model, provider: obsSpans.provider })
      .from(obsSpans)
      .where(
        and(
          eq(obsSpans.userId, userId),
          or(isNotNull(obsSpans.task), isNotNull(obsSpans.model), isNotNull(obsSpans.provider)),
        ),
      )
      .all();
    return {
      tasks: sortedDistinct(rows.map((r) => r.task)),
      models: sortedDistinct(rows.map((r) => r.model)),
      providers: sortedDistinct(rows.map((r) => r.provider)),
    };
  });

  api.get(
    '/obs/traces/:traceId',
    { schema: { params: TraceParams, response: { 200: DetailView } } },
    async (req) => {
      const { userId } = requireUser(req);
      const { traceId } = req.params;
      const trace = await db
        .select()
        .from(obsTraces)
        .where(and(eq(obsTraces.traceId, traceId), eq(obsTraces.userId, userId)))
        .get();
      if (trace === undefined) throw notFound();
      const spans = await db
        .select()
        .from(obsSpans)
        .where(and(eq(obsSpans.traceId, traceId), eq(obsSpans.userId, userId)))
        .orderBy(asc(obsSpans.startedAt), asc(obsSpans.spanId))
        .limit(MAX_TRACE_SPANS)
        .all();
      // The session is looked up as the caller's own: a conversation id that is not theirs, or
      // whose session is gone, links nowhere.
      const session =
        trace.conversationId === null
          ? undefined
          : await db
              .select({ id: tailoringSessions.id, resumeId: tailoringSessions.resumeId })
              .from(tailoringSessions)
              .where(
                and(
                  eq(tailoringSessions.id, trace.conversationId),
                  eq(tailoringSessions.userId, userId),
                ),
              )
              .get();
      return {
        trace: toTraceView(trace),
        spans: spans.map(toSpanView),
        conversation: session ?? null,
      };
    },
  );
}
