// rebuildSpan (obs/spanRebuild.ts, design.md 14.8): two of its checks that no other test pinned
// (https://github.com/bgoleno/opportun/issues/373, sec's review of
// https://github.com/bgoleno/opportun/pull/366). A catalogued name is kept only with one of its
// catalogued kinds, and a template key with no checked value leaves its place in the name empty,
// never the text "undefined". The spans are built by hand, as a span processor receives them, so
// each case is exactly the shape it names.
import { SpanKind, SpanStatusCode, type HrTime } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { obs } from '../src/obs';
import { OTHER } from '../src/obs/catalog';
import { rebuildSpan } from '../src/obs/spanRebuild';

const T: HrTime = [1_790_000_000, 0];

function made(name: string, kind: SpanKind, attributes: Record<string, unknown>): ReadableSpan {
  return {
    name,
    kind,
    attributes,
    spanContext: () => ({
      traceId: 'a0000000000000000000000000000001',
      spanId: '1000000000000001',
      traceFlags: 1,
    }),
    parentSpanContext: undefined,
    startTime: T,
    endTime: [T[0], 5_000_000],
    duration: [0, 5_000_000],
    status: { code: SpanStatusCode.UNSET },
    events: [],
    links: [],
    resource: {},
    instrumentationScope: { name: 'test' },
    ended: true,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

/** The reasons rebuildSpan counted a span or a key as dropped (opportun.obs.dropped). */
function countDrops(): () => unknown[] {
  const record = vi.spyOn(obs, 'record');
  return () =>
    record.mock.calls
      .filter(([metric]) => metric === 'opportun.obs.dropped')
      .map(([, , attrs]) => (attrs as Record<string, unknown>)['opportun.obs.reason']);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const CHAT = {
  'gen_ai.operation.name': 'chat',
  'gen_ai.request.model': 'claude-haiku-5-5',
};

describe('rebuildSpan keeps a catalogued name only with its catalogued kind (#373)', () => {
  it.each(['local', 'export'] as const)('to the %s sink', (sink) => {
    // The control: the inference span with its own kind is kept, under its name.
    expect(rebuildSpan(made('chat claude-haiku-5-5', SpanKind.CLIENT, CHAT), sink)).toMatchObject({
      name: 'chat claude-haiku-5-5',
      kind: 'client',
    });
    // The same name and attributes with any other kind match no entry: dropped whole, counted.
    for (const kind of [SpanKind.SERVER, SpanKind.INTERNAL, SpanKind.PRODUCER, SpanKind.CONSUMER]) {
      const drops = countDrops();
      expect(rebuildSpan(made('chat claude-haiku-5-5', kind, CHAT), sink)).toBeUndefined();
      expect(drops()).toEqual(['unknown_key']);
      vi.restoreAllMocks();
    }
  });

  it("allows each of an entry's several kinds, and no other", () => {
    // OTHER: a job kind the check always takes, with no job registered in this file.
    const attrs = { 'opportun.job.kind': OTHER };
    const name = `job ${OTHER}`;
    // A job is internal, or a consumer when it continues a trace (14.2).
    expect(rebuildSpan(made(name, SpanKind.INTERNAL, attrs), 'local')).toMatchObject({
      name,
      kind: 'internal',
    });
    expect(rebuildSpan(made(name, SpanKind.CONSUMER, attrs), 'local')).toMatchObject({
      name,
      kind: 'consumer',
    });
    for (const kind of [SpanKind.SERVER, SpanKind.CLIENT, SpanKind.PRODUCER]) {
      expect(rebuildSpan(made(name, kind, attrs), 'local')).toBeUndefined();
    }
  });
});

describe('rebuildSpan leaves a dropped template key out of the name (#373)', () => {
  it('when the key is absent', () => {
    // A route span whose route did not pass the gate: its name has the method alone.
    const rebuilt = rebuildSpan(
      made('GET ', SpanKind.SERVER, { 'http.request.method': 'GET' }),
      'local',
    );
    expect(rebuilt).toMatchObject({ name: 'GET ', kind: 'server' });
    expect(rebuilt?.attributes).toEqual({ 'http.request.method': 'GET' });
  });

  it('when its value fails the check', () => {
    const drops = countDrops();
    const rebuilt = rebuildSpan(
      made('GET ', SpanKind.SERVER, {
        'http.request.method': 'GET',
        'http.route': 'not a route template',
      }),
      'local',
    );
    expect(rebuilt).toMatchObject({ name: 'GET ', kind: 'server' });
    expect(rebuilt?.name).not.toContain('undefined');
    expect(rebuilt?.attributes).toEqual({ 'http.request.method': 'GET' });
    expect(drops()).toContain('invalid_value');
  });
});
