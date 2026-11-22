// The state obs/index shares with obs/tracing and what tracing loads (the span store, the span
// rebuild): whether collection is on, the suppression of telemetry about telemetry, the exporter
// slots, which spans the store keeps, and how a dropped span is counted
// (https://github.com/bgoleno/opportun/issues/803).
//
// obs/index loads obs/tracing lazily (14.3), and tracing read these from obs/index, which made
// the two an import cycle. They live here instead, and this module has no runtime import from obs/
// (its imports from obs/index are types only, erased at build time), so it is a leaf: anything in
// obs/ can import it. obs/index re-exports the same functions and the same objects, not copies, so
// there is one collecting flag, one suppression context and one set of slots
// (test/obsState.test.ts).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DropReason } from './catalog';
import type { LogExportSink, MetricExportSink, SpanExportSink } from './index';

let collecting = false;

/** Whether collection is on: the one check every entry point makes first. */
export function isCollecting(): boolean {
  return collecting;
}

/** obs/index's setCollecting only: the switch itself, with its timers and sinks, stays there. */
export function setCollectingFlag(on: boolean): void {
  collecting = on;
}

/** Telemetry about telemetry is suppressed (14.6): the store's writes run inside this. */
const suppressed = new AsyncLocalStorage<true>();

export function runSuppressed<T>(fn: () => T): T {
  return suppressed.run(true, fn);
}

/** True inside the store's own writes, which the database and outbound wrappers skip. */
export function isSuppressed(): boolean {
  return suppressed.getStore() === true;
}

export interface Sinks {
  metrics?: MetricExportSink;
  spans?: SpanExportSink;
  logs?: LogExportSink;
}

/** The exporter slots (FR-T2), which obs/index attaches and detaches. */
export const sinks: Sinks = {};

/** The span slot's exporter, which obs/tracing.ts hands each rebuilt span to (FR-T4 part 2). */
export function spanExportSink(): SpanExportSink | undefined {
  return sinks.spans;
}

let keptCheck: (spanId: string) => boolean = () => false;

/** obs/tracing's span store tells workflow continuations which spans it kept. */
export function setKeptCheck(check: (spanId: string) => boolean): void {
  keptCheck = check;
}

export function isKept(spanId: string): boolean {
  return keptCheck(spanId);
}

// Until obs/index fills it at its load, a dropped span is not counted: nothing records before
// obs/index has loaded, as recording is its own.
let spanDropCounter: (reason: DropReason) => void = () => undefined;

/** Called by obs/index at its load: how a dropped span is counted (opportun.obs.dropped). */
export function provideSpanDropCounter(counter: (reason: DropReason) => void): void {
  spanDropCounter = counter;
}

/** Counts a span the gate or a buffer dropped (opportun.obs.dropped). */
export function countSpanDrop(reason: DropReason): void {
  spanDropCounter(reason);
}
