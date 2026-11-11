// The span entry points FR-T3's wrappers use (design.md 14.2, 14.3, 14.6;
// https://github.com/bgoleno/opportun/issues/343): obs.startSpan() for a span a hook opens and
// another hook ends (the HTTP plugin), obs.span() with an explicit parent and kind (the job
// runner continuing jobs.trace_context), and the traceparent a job row carries.
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { contextFromTraceparent, obs, setCollecting } from '../src/obs';
import { SPANS } from '../src/obs/catalog';
import { useApi } from './api';
import { useInMemoryTracing } from './otelProvider';

const boot = useApi();
const exporter = useInMemoryTracing();

afterEach(async () => {
  await setCollecting(false);
});

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';

describe('the catalog has the server and job spans (#343)', () => {
  it('names them from checked values, and lets a job span be a consumer', () => {
    expect(SPANS['http.server']).toMatchObject({
      template: '{http.request.method} {http.route}',
      kind: 'server',
    });
    expect(SPANS.job).toMatchObject({ template: 'job {opportun.job.kind}', kind: 'internal' });
    expect(SPANS.job.kinds).toEqual(['internal', 'consumer']);
  });
});

describe('obs.startSpan (#343)', () => {
  it('opens a span a later call ends, with its context to run the rest of the request in', async () => {
    await boot();
    await setCollecting(true);
    const s = obs.startSpan('http.server', {
      'http.request.method': 'GET',
      'http.route': '/api/v1/opportunities/:id',
    });
    expect(trace.getSpan(s.context)?.isRecording()).toBe(true);
    // The context is what a later hook enters: a child started in it is the span's child.
    await context.with(s.context, () =>
      obs.span('http.client', { 'http.request.method': 'GET' }, async () => undefined),
    );
    s.set({ 'http.response.status_code': 200 });
    s.end();
    const spans = exporter.getFinishedSpans();
    const server = spans.find((x) => x.kind === SpanKind.SERVER);
    const client = spans.find((x) => x.kind === SpanKind.CLIENT);
    expect(server?.name).toBe('GET /api/v1/opportunities/:id');
    expect(server?.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/api/v1/opportunities/:id',
      'http.response.status_code': 200,
    });
    expect(client?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
  });

  it('is a no-op with collection off: nothing records, and the context is the current one', async () => {
    await boot();
    const s = obs.startSpan('http.server', { 'http.request.method': 'GET', 'http.route': '/x' });
    expect(trace.getSpan(s.context)).toBeUndefined();
    s.fail('TypeError');
    s.end();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('ends once: a second end is ignored', async () => {
    await boot();
    await setCollecting(true);
    const s = obs.startSpan('http.server', { 'http.request.method': 'GET', 'http.route': '/x' });
    s.end();
    s.end();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
});

describe('obs.span with a parent and a kind (#343)', () => {
  it('continues a stored traceparent as a consumer child', async () => {
    await boot();
    await setCollecting(true);
    const parent = contextFromTraceparent(`00-${TRACE}-${SPAN}-01`);
    expect(parent).toBeDefined();
    await obs.span('job', { 'opportun.job.kind': '_OTHER' }, async () => undefined, {
      parent,
      kind: 'consumer',
    });
    const [job] = exporter.getFinishedSpans();
    expect(job?.name).toBe('job _OTHER');
    expect(job?.kind).toBe(SpanKind.CONSUMER);
    expect(job?.spanContext().traceId).toBe(TRACE);
    expect(job?.parentSpanContext?.spanId).toBe(SPAN);
  });

  it('starts a new trace without a parent, as the catalog kind; a kind the catalog does not allow is ignored', async () => {
    await boot();
    await setCollecting(true);
    await obs.span('job', { 'opportun.job.kind': '_OTHER' }, async () => undefined, {
      kind: 'server',
    });
    const [job] = exporter.getFinishedSpans();
    expect(job?.kind).toBe(SpanKind.INTERNAL);
    expect(job?.parentSpanContext).toBeUndefined();
  });

  it('keeps an error type the callee set when the error is then rethrown', async () => {
    await boot();
    await setCollecting(true);
    const err = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    await expect(
      obs.span('http.client', { 'http.request.method': 'GET' }, async (s) => {
        s.fail('ECONNREFUSED');
        throw err;
      }),
    ).rejects.toBe(err);
    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('ECONNREFUSED');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('contextFromTraceparent (#343)', () => {
  it('reads a W3C traceparent, and refuses anything else', () => {
    expect(
      trace.getSpanContext(contextFromTraceparent(`00-${TRACE}-${SPAN}-01`) ?? context.active()),
    ).toMatchObject({
      traceId: TRACE,
      spanId: SPAN,
      traceFlags: 1,
      isRemote: true,
    });
    for (const bad of [
      null,
      '',
      `01-${TRACE}-${SPAN}-01`,
      `00-${'0'.repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${'0'.repeat(16)}-01`,
      `00-${TRACE.toUpperCase()}-${SPAN}-01`,
      `00-${TRACE}-${SPAN}-01-extra`,
    ]) {
      expect(contextFromTraceparent(bad), String(bad)).toBeUndefined();
    }
  });
});
