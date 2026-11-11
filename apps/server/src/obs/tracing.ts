// The tracer provider (design.md 14.3, 14.7, 14.8; https://github.com/bgoleno/opportun/issues/344,
// FR-T4 part 2). obs/index.ts loads this file the first time collection turns on, so with
// collection off, the default, the SDK packages are never loaded and no provider is registered:
// a span made through the OpenTelemetry API, by packages/ai or anyone, records nothing (14.11).
//
// Once loaded it stays registered for the life of the process (the API takes one global
// provider), and its sampler records nothing while collection is off again, or inside the
// store's own writes (runSuppressed: telemetry about telemetry is suppressed, 14.6).
//
// Two processors, both of which rebuild a span from the catalog instead of passing it on (14.8):
// - the local store (obs/spanStore.ts), which keeps Gen AI spans and what is under them;
// - the export slot, which hands FR-T2's exporter a rebuilt span without its local-only keys,
//   with a model named only when the price table lists it.
// A span that matches no catalogued name and kind is dropped whole and counted, wherever it
// comes from. Nothing crosses the process boundary: no propagator is registered (14.6).
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  SamplingDecision,
  TracerProvider,
  type Sampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { Db } from '../db/client';
import { isCollecting, isSuppressed, spanExportSink } from './index';
import { guarded, rebuildSpan } from './spanRebuild';
import { SpanStore } from './spanStore';

/** Hands each finished span, rebuilt for export, to FR-T2's exporter while one is attached. */
const exportProcessor: SpanProcessor = {
  onStart: () => undefined,
  onEnd: (span) => {
    const sink = spanExportSink();
    if (sink === undefined) return;
    guarded(() => {
      const rebuilt = rebuildSpan(span, 'export');
      if (rebuilt !== undefined) sink.export(rebuilt);
    });
  },
  forceFlush: async () => undefined,
  shutdown: async () => undefined,
};

/** Records while collection is on, outside the store's own writes; nothing otherwise. */
const collectSampler: Sampler = {
  shouldSample: () => ({
    decision:
      isCollecting() && !isSuppressed()
        ? SamplingDecision.RECORD_AND_SAMPLED
        : SamplingDecision.NOT_RECORD,
  }),
  toString: () => 'OpportunCollectSampler',
};

export const store = new SpanStore();
let registered = false;

/**
 * Called by obs/index.ts when collection turns on: registers the provider once, and binds the
 * span store to this run's database.
 */
export async function startTracing(db: Db, now: () => number): Promise<void> {
  if (!registered) {
    registered = true;
    // False when a context manager is already registered (a test's own): that one is kept.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const provider = new TracerProvider({
      sampler: collectSampler,
      spanProcessors: [store.processor, exportProcessor],
    });
    trace.setGlobalTracerProvider(provider);
  }
  store.start(db, now);
}

/** Called when collection turns off: what waits unflushed is dropped (nothing may be written). */
export function stopTracing(): void {
  store.stop();
}

/** Writes what waits now (the stop path and tests). */
export async function flushSpans(): Promise<void> {
  await store.flush();
}
