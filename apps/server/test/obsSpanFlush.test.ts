// The span flush writes the same rows whatever its chunking (https://github.com/bgoleno/opportun/issues/375,
// criterion 3). A fixed batch: two users, a workflow with its calls and a provider request, a lone
// call, a trace that a second flush adds to, and a span for another user inside a user's trace
// (dropped). EXPECTED is what the flush wrote at main 5dd98ff, one statement per row in one
// transaction; the chunked, multi-row flush must write exactly the same.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { obsSpans, obsTraces } from '../src/db/schema';
import { flushBatch, type Pending, TRACE_SPAN_CAP } from '../src/obs/spanStore';
import { useApi } from './api';

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];

const T = 1_790_000_000_000;
const TRACE_A = 'a0000000000000000000000000000001';
const TRACE_B = 'b0000000000000000000000000000002';
const TRACE_C = 'c0000000000000000000000000000003';

function span(
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
  name: string,
  kind: string,
  startOffset: number,
  durationMs: number,
  attributes: Record<string, unknown>,
  status: 'ok' | 'error' = 'ok',
) {
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind,
    startMs: T + startOffset + 0.25,
    durationMs,
    status,
    attributes,
  } as Pending['span'];
}

const chat = (
  task: string,
  model: string,
  provider: string,
  input: number,
  output: number,
  cost: number,
  user: string,
) => ({
  'gen_ai.operation.name': 'chat',
  'opportun.ai.task': task,
  'gen_ai.request.model': model,
  'opportun.ai.provider': provider,
  'opportun.ai.feature': 'matching',
  'gen_ai.usage.input_tokens': input,
  'gen_ai.usage.output_tokens': output,
  'opportun.gen_ai.usage.cost': cost,
  'user.id': user,
});

/** The fixed batch, for users a and b, and a second flush for trace B. */
export function batches(a: string, b: string): Pending[][] {
  const first: Pending[] = [
    {
      span: span(TRACE_A, '1000000000000001', null, 'invoke_workflow capture', 'internal', 0, 900, {
        'gen_ai.operation.name': 'invoke_workflow',
        'gen_ai.agent.name': 'capture',
        'user.id': a,
      }),
      userId: a,
      traceUserId: a,
      origin: '/api/v1/capture',
      root: true,
    },
    {
      span: span(
        TRACE_A,
        '1000000000000002',
        '1000000000000001',
        'chat claude-sonnet-5-5',
        'client',
        10,
        300,
        chat('resume.match', 'claude-sonnet-5-5', 'anthropic', 100, 20, 0.0012, a),
      ),
      userId: a,
      traceUserId: a,
      origin: undefined,
      root: false,
    },
    {
      span: span(TRACE_A, '1000000000000003', '1000000000000002', 'POST', 'client', 12, 280, {
        'http.request.method': 'POST',
        'opportun.outbound.target': 'anthropic',
        'http.response.status_code': 200,
      }),
      userId: a,
      traceUserId: a,
      origin: undefined,
      root: false,
    },
    {
      span: span(
        TRACE_A,
        '1000000000000004',
        '1000000000000001',
        'chat gpt-5-mini',
        'client',
        400,
        200,
        chat('capture.extract', 'gpt-5-mini', 'openai', 50, 10, 0.0004, a),
        'error',
      ),
      userId: a,
      traceUserId: a,
      origin: undefined,
      root: false,
    },
    {
      span: span(
        TRACE_B,
        '2000000000000001',
        null,
        'chat claude-haiku-5-5',
        'client',
        50,
        120,
        chat('comms.classify', 'claude-haiku-5-5', 'anthropic', 30, 5, 0.0001, b),
      ),
      userId: b,
      traceUserId: b,
      origin: 'job comms.classify',
      root: false,
    },
    // A span for b inside a's trace C: dropped, not mixed in.
    {
      span: span(
        TRACE_C,
        '3000000000000001',
        null,
        'invoke_workflow mail_sync',
        'internal',
        70,
        50,
        {
          'gen_ai.operation.name': 'invoke_workflow',
          'gen_ai.agent.name': 'mail_sync',
          'user.id': a,
        },
      ),
      userId: a,
      traceUserId: a,
      origin: undefined,
      root: true,
    },
    {
      span: span(TRACE_C, '3000000000000002', '3000000000000001', 'GET', 'client', 80, 10, {
        'http.request.method': 'GET',
      }),
      userId: b,
      traceUserId: a,
      origin: undefined,
      root: false,
    },
  ];
  const second: Pending[] = [
    {
      span: span(
        TRACE_B,
        '2000000000000002',
        '2000000000000001',
        'chat claude-haiku-5-5',
        'client',
        2_000,
        140,
        chat('comms.classify', 'claude-haiku-5-5', 'anthropic', 40, 6, 0.0002, b),
      ),
      userId: b,
      traceUserId: b,
      origin: undefined,
      root: false,
    },
  ];
  return [first, second];
}

/** What main 5dd98ff wrote for these batches (one statement per row, one transaction). */
const EXPECTED = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'spanFlush375.json'), 'utf8'),
) as { traces: Record<string, unknown>[]; spans: Record<string, unknown>[] };

/**
 * Numbers to 6 significant digits: Postgres keeps a `real` column at single precision, so a sum
 * like a trace's cost reads back a few digits shorter there than on SQLite.
 */
function rounded<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v,
    ),
  ) as T;
}

/** The rows, sorted, with the user ids replaced so two apps' rows compare. */
export async function rows(app: App, a: string, b: string) {
  const users = (v: unknown) => (v === a ? 'USER_A' : v === b ? 'USER_B' : v);
  const fix = (r: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(r, (_k, v) => users(v))) as Record<string, unknown>;
  const traces = (await app.db.select().from(obsTraces).all())
    .map(fix)
    .sort((x, y) => String(x.traceId).localeCompare(String(y.traceId)));
  const spans = (await app.db.select().from(obsSpans).all())
    .map(fix)
    .sort((x, y) => String(x.spanId).localeCompare(String(y.spanId)));
  return { traces, spans };
}

const childId = (i: number) => `3${i.toString(16).padStart(15, '0')}`;

describe('the span flush writes the same rows (#375)', () => {
  it.each([1, 2, 3, 5, 25])('in chunks of %i, as main 5dd98ff wrote them', async (chunkSize) => {
    const { app, a, b } = await boot();
    const [first, second] = batches(a.userId, b.userId);
    await flushBatch(app.db, first!, T + 5_000, { chunkSize });
    await flushBatch(app.db, second!, T + 10_000, { chunkSize });
    expect(rounded(await rows(app, a.userId, b.userId))).toEqual(rounded(EXPECTED));
  });

  // A trace over its cap, its root ending last (the buffer holds it past its cap): written in one
  // transaction, the root is kept and the other spans fill the rest of the cap. In chunks, the root
  // comes in the last one, after the cap has filled, so the earlier chunks keep its room.
  it.each([25, TRACE_SPAN_CAP + 1])(
    'keeps a capped trace at its cap in chunks of %i',
    async (chunkSize) => {
      const { app, a, b } = await boot();
      const root = '2000000000000000';
      const capped: Pending[] = [];
      for (let i = 0; i < TRACE_SPAN_CAP; i++) {
        capped.push({
          span: span(TRACE_C, childId(i), root, 'GET', 'client', i, 1, {
            'http.request.method': 'GET',
          }),
          userId: a.userId,
          traceUserId: a.userId,
          origin: undefined,
          root: false,
        });
      }
      capped.push({
        span: span(TRACE_C, root, null, 'invoke_workflow discovery_run', 'internal', 0, 9_000, {
          'gen_ai.operation.name': 'invoke_workflow',
          'gen_ai.agent.name': 'discovery_run',
        }),
        userId: a.userId,
        traceUserId: a.userId,
        origin: 'job discovery.run',
        root: true,
      });
      await flushBatch(app.db, capped, T + 20_000, { chunkSize });
      const { traces, spans } = await rows(app, a.userId, b.userId);
      expect(spans).toHaveLength(TRACE_SPAN_CAP);
      expect(spans.some((s) => s.spanId === root)).toBe(true);
      // The spans kept are the root and the first to end, as in one transaction.
      expect(spans.some((s) => s.spanId === childId(TRACE_SPAN_CAP - 1))).toBe(false);
      expect(traces).toEqual([
        expect.objectContaining({
          spanCount: TRACE_SPAN_CAP,
          truncated: true,
          workflow: 'discovery_run',
        }),
      ]);
    },
  );
});
