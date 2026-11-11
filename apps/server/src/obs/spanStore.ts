// The local span store (design.md 14.7, 14.11; https://github.com/bgoleno/opportun/issues/344,
// FR-T4 part 2): the span processor that writes kept spans to obs_spans, and keeps obs_traces up
// to date as they arrive.
//
// The keep rule. A span is kept when it is a Gen AI span (an inference span or a workflow span),
// when its parent was kept, or when its parent is remote. The last is how a job that continues a
// trace is kept: Opportun's only remote parent is jobs.trace_context (14.6: an incoming
// traceparent is ignored), which only the workflow continuations of 14.5 write, from inside a
// kept workflow span; the runner starts such a job's span with that remote parent (#343). A route
// or job that merely contains the first Gen AI span is not kept: its name is the trace's origin.
//
// Every kept trace has a user (14.7). A kept span takes it from the context it starts in (the
// user the request, the job or the workflow runs for), else from its own user.id, else from its
// kept parent. A kept span with no user anywhere is dropped and counted.
//
// Bounds (14.11): at most 2,000 spans wait between flushes, beyond which the newest are dropped
// and counted; a flush runs every 5 seconds or at 200 spans, in one transaction; a trace stops at
// 2,000 spans and is marked truncated. The writes run suppressed, so they make no telemetry.
import { ATTR, userInContext } from '@opportun/ai';
import { trace, type Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';
import { inArray } from 'drizzle-orm';
import { withTransaction, type Db, type Exec } from '../db/client';
import { obsSpans, obsTraces, users } from '../db/schema';
import { OTHER } from './catalog';
import { checkValue } from './gate';
import { isCollecting, runSuppressed, type GatedSpan } from './index';
import { countSpanDrop, guarded, rebuildSpan } from './spanRebuild';

export const SPAN_BUFFER_MAX = 2_000;
export const SPAN_FLUSH_AT = 200;
export const SPAN_FLUSH_INTERVAL_MS = 5_000;
/** A trace stops growing at this many spans and is marked truncated (14.11). */
export const TRACE_SPAN_CAP = 2_000;
/** How many started spans the keep rule remembers, so a late child still finds its parent. */
const KEPT_MEMORY = 10_000;

const GEN_AI_OPERATIONS = new Set(['chat', 'invoke_workflow']);

interface Kept {
  userId: string | undefined;
  /** The user of the kept subtree's first span: the trace's user, which every span must share. */
  traceUserId: string | undefined;
  /** Set on the first kept span of a subtree: what contained it (14.7). */
  origin: string | undefined;
  /** The first kept span of a subtree (a workflow span, a lone call, a continued job's span). */
  root: boolean;
}

interface Pending {
  span: GatedSpan;
  userId: string;
  traceUserId: string;
  origin: string | undefined;
  root: boolean;
}

/** What contained the first Gen AI span: a route template, or `job {kind}` (14.7). */
function originOf(parent: Span | undefined): string | undefined {
  // A parent that does not record (started before collection was on) has no name or attributes.
  const attributes = (parent as { attributes?: unknown } | undefined)?.attributes;
  const name = (parent as { name?: unknown } | undefined)?.name;
  const route =
    typeof attributes === 'object' && attributes !== null
      ? (attributes as Record<string, unknown>)['http.route']
      : undefined;
  // Through the gate's own type, so the origin is a route template or a job's span name only.
  if (typeof route === 'string' && checkValue({ kind: 'route' }, route) !== undefined) return route;
  return typeof name === 'string' && /^job [a-z0-9_.]{1,64}$/.test(name) ? name : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function union(a: readonly string[], b: Iterable<string>): string[] {
  return [...new Set([...a, ...b])].sort();
}

export class SpanStore {
  private db: Db | undefined;
  private now: () => number = Date.now;
  private timer: NodeJS.Timeout | undefined;
  private buffer: Pending[] = [];
  private readonly kept = new Map<string, Kept>();
  private flushing: Promise<void> = Promise.resolve();

  /** The processor registered on the provider (obs/tracing.ts). */
  readonly processor: SpanProcessor = {
    onStart: (span, parentContext) => guarded(() => this.onStart(span, parentContext)),
    onEnd: (span) => guarded(() => this.onEnd(span)),
    forceFlush: () => this.flush(),
    shutdown: async () => undefined,
  };

  start(db: Db, now: () => number): void {
    this.stop();
    this.db = db;
    this.now = now;
    this.timer = setInterval(() => {
      void this.flush().catch(() => undefined);
    }, SPAN_FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  /** Collection off: what waits is dropped, and nothing is written from then on. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.buffer = [];
    this.kept.clear();
    this.db = undefined;
  }

  /** Whether a started span is one the store keeps (obs/workflow.ts continuesTrace). */
  isKept(spanId: string): boolean {
    return this.db !== undefined && this.kept.has(spanId);
  }

  private remember(spanId: string, kept: Kept): void {
    if (this.kept.size >= KEPT_MEMORY) {
      const oldest = this.kept.keys().next().value;
      if (oldest !== undefined) this.kept.delete(oldest);
    }
    this.kept.set(spanId, kept);
  }

  private onStart(span: Span, parentContext: Context): void {
    if (!isCollecting() || this.db === undefined) return;
    const parent = trace.getSpanContext(parentContext);
    const keptParent = parent === undefined ? undefined : this.kept.get(parent.spanId);
    const genAi = GEN_AI_OPERATIONS.has(str(span.attributes[ATTR.operationName]) ?? '');
    const remote = parent?.isRemote === true;
    if (!genAi && keptParent === undefined && !remote) return;
    const userId =
      userInContext(parentContext) ?? str(span.attributes[ATTR.userId]) ?? keptParent?.userId;
    // The first kept span of a subtree names what contained it.
    const origin =
      keptParent === undefined && !remote
        ? originOf(trace.getSpan(parentContext) as Span | undefined)
        : undefined;
    const traceUserId = keptParent === undefined ? userId : keptParent.traceUserId;
    this.remember(span.spanContext().spanId, {
      userId,
      traceUserId,
      origin,
      root: keptParent === undefined,
    });
  }

  private onEnd(span: ReadableSpan): void {
    if (!isCollecting() || this.db === undefined) return;
    const kept = this.kept.get(span.spanContext().spanId);
    if (kept === undefined) return;
    const rebuilt = rebuildSpan(span, 'local');
    if (rebuilt === undefined) return;
    const userId = kept.userId ?? str(rebuilt.attributes[ATTR.userId]);
    const traceUserId = kept.traceUserId ?? userId;
    if (userId === undefined || traceUserId === undefined) {
      countSpanDrop('invalid_value');
      return;
    }
    if (this.buffer.length >= SPAN_BUFFER_MAX) {
      countSpanDrop('buffer_full');
      return;
    }
    this.buffer.push({ span: rebuilt, userId, traceUserId, origin: kept.origin, root: kept.root });
    if (this.buffer.length >= SPAN_FLUSH_AT) void this.flush().catch(() => undefined);
  }

  /** Writes what waits, after any flush already running. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(
      () => this.write(),
      () => this.write(),
    );
    return this.flushing;
  }

  private async write(): Promise<void> {
    const db = this.db;
    if (db === undefined || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await runSuppressed(() => withTransaction(db, (tx) => writeBatch(tx, batch, this.now())));
    } catch (err) {
      // A failed transaction loses its batch (nothing is retried into a backlog, 14.11): counted.
      for (let i = 0; i < batch.length; i++) countSpanDrop('buffer_full');
      throw err;
    }
  }
}

type TraceRow = typeof obsTraces.$inferInsert;

/** The figures one span adds to its trace's row. */
function addSpan(row: TraceRow, p: Pending): void {
  const a = p.span.attributes as Record<string, unknown>;
  const end = Math.max(row.startedAt + row.durationMs, p.span.startMs + p.span.durationMs);
  // started_at is whole milliseconds; the duration keeps the fraction.
  row.startedAt = Math.min(row.startedAt, Math.round(p.span.startMs));
  row.durationMs = end - row.startedAt;
  row.spanCount = (row.spanCount ?? 0) + 1;
  if (p.span.status === 'error') {
    row.errorCount = (row.errorCount ?? 0) + 1;
    row.status = 'error';
  }
  if (a[ATTR.operationName] === 'invoke_workflow') row.workflow ??= str(a[ATTR.agentName]) ?? null;
  row.feature ??= str(a[ATTR.aiFeature]) ?? null;
  row.conversationId ??= str(a[ATTR.conversationId]) ?? null;
  if (a[ATTR.operationName] === 'chat') {
    const task = str(a[ATTR.aiTask]);
    const model = str(a[ATTR.requestModel]);
    const provider = str(a[ATTR.aiProvider]);
    row.tasks = union(row.tasks ?? [], task === undefined ? [] : [task]);
    row.models = union(row.models ?? [], model === undefined ? [] : [model]);
    row.providers = union(row.providers ?? [], provider === undefined ? [] : [provider]);
    row.inputTokens = (row.inputTokens ?? 0) + num(a[ATTR.usageInputTokens]);
    row.outputTokens = (row.outputTokens ?? 0) + num(a[ATTR.usageOutputTokens]);
    row.estCost = (row.estCost ?? 0) + num(a[ATTR.usageCost]);
  }
  if (row.origin === OTHER && p.origin !== undefined) row.origin = p.origin;
}

async function writeBatch(tx: Exec, batch: Pending[], now: number): Promise<void> {
  // A user deleted since their span started takes its spans along (the rows cascade with it).
  const userIds = [...new Set(batch.flatMap((p) => [p.userId, p.traceUserId]))];
  const known = new Set(
    (await tx.select({ id: users.id }).from(users).where(inArray(users.id, userIds)).all()).map(
      (u) => u.id,
    ),
  );
  const byTrace = new Map<string, Pending[]>();
  for (const p of batch) {
    if (!known.has(p.userId) || !known.has(p.traceUserId)) continue;
    const list = byTrace.get(p.span.traceId) ?? [];
    list.push(p);
    byTrace.set(p.span.traceId, list);
  }
  if (byTrace.size === 0) return;
  const stored = new Map(
    (
      await tx
        .select()
        .from(obsTraces)
        .where(inArray(obsTraces.traceId, [...byTrace.keys()]))
        .all()
    ).map((r) => [r.traceId, r]),
  );

  for (const [traceId, pending] of byTrace) {
    const prior = stored.get(traceId);
    const first = pending[0]!;
    const row: TraceRow =
      prior === undefined
        ? {
            traceId,
            userId: first.traceUserId,
            startedAt: Math.round(first.span.startMs),
            durationMs: first.span.durationMs,
            origin: OTHER,
            workflow: null,
            feature: null,
            conversationId: null,
            tasks: [],
            models: [],
            providers: [],
            inputTokens: 0,
            outputTokens: 0,
            estCost: 0,
            spanCount: 0,
            errorCount: 0,
            status: 'ok',
            truncated: false,
            updatedAt: now,
          }
        : { ...prior, updatedAt: now };
    // One trace belongs to one user (14.6): a span claiming another is not added to it, but
    // dropped and counted (a span started for user b inside user a's workflow).
    const own = pending.filter((p) => p.userId === row.userId && p.traceUserId === row.userId);
    for (let i = own.length; i < pending.length; i++) countSpanDrop('invalid_value');
    // A subtree's root (the workflow span, which ends last) is kept whatever the cap, so a
    // truncated trace still has its root and its workflow name (tl on #366). The rest fill what
    // room the cap leaves, in the order they ended.
    const roots = own.filter((p) => p.root);
    const rest = own.filter((p) => !p.root);
    const room = Math.max(0, TRACE_SPAN_CAP - (row.spanCount ?? 0) - roots.length);
    const taken = [...roots, ...rest.slice(0, room)];
    if (taken.length < own.length) {
      row.truncated = true;
      for (let i = taken.length; i < own.length; i++) countSpanDrop('buffer_full');
    }
    for (const p of taken) addSpan(row, p);
    // Everything but the key: an upsert's set may not change the row's own id.
    const figures: Partial<TraceRow> = { ...row };
    delete figures.traceId;
    await tx
      .insert(obsTraces)
      .values(row)
      .onConflictDoUpdate({ target: obsTraces.traceId, set: figures })
      .run();
    for (const p of taken) {
      const a = p.span.attributes as Record<string, unknown>;
      const inference = a[ATTR.operationName] === 'chat';
      await tx
        .insert(obsSpans)
        .values({
          traceId,
          spanId: p.span.spanId,
          parentSpanId: p.span.parentSpanId,
          userId: p.userId,
          name: p.span.name,
          kind: p.span.kind as (typeof obsSpans.$inferInsert)['kind'],
          startedAt: Math.round(p.span.startMs),
          durationMs: p.span.durationMs,
          status: p.span.status,
          errorType: str(a['error.type']) ?? null,
          attributes: a,
          task: inference ? (str(a[ATTR.aiTask]) ?? null) : null,
          model: inference ? (str(a[ATTR.requestModel]) ?? null) : null,
          provider: inference ? (str(a[ATTR.aiProvider]) ?? null) : null,
        })
        .onConflictDoNothing()
        .run();
    }
  }
}
