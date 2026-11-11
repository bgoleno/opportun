// An in-memory tracer provider for tests (https://github.com/bgoleno/opportun/issues/343). The
// server registers no provider until FR-T4 part 2's obs/tracing.ts, so a test that needs to see
// the spans obs.span() and obs.startSpan() make registers this one: the SDK's TracerProvider
// with a SimpleSpanProcessor into an InMemorySpanExporter, and the AsyncLocalStorage context
// manager the design names (14.3). Test-only: the SDK packages are devDependencies.
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll } from 'vitest';

/** Registers the provider for the rest of the file; the spans each test made, then cleared. */
export function useInMemoryTracing(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const manager = new AsyncLocalStorageContextManager();
  beforeAll(() => {
    trace.disable();
    context.disable();
    context.setGlobalContextManager(manager.enable());
    trace.setGlobalTracerProvider(provider);
  });
  afterEach(() => exporter.reset());
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });
  return exporter;
}
