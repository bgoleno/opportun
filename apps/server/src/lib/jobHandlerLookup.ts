// The slot through which enqueue (lib/jobQueue.ts) finds a kind's handler
// (https://github.com/bgoleno/opportun/issues/788). jobs/registry.ts fills it as it loads, since
// lib/ does not import jobs/. A leaf module, importing nothing, on purpose: it has always finished
// loading before the registry or the queue runs a line, whichever of them loads first, so the
// handover can never reach it mid-initialisation (tl on #788). Keep it free of imports.

/** What enqueue needs of a kind's handler: its payload schema and its attempts. */
export interface QueuedKind {
  payloadSchema: { parse(value: unknown): unknown };
  maxAttempts: number;
}

/**
 * Until jobs/registry.ts has loaded this answers undefined, and that is the true answer, not a gap
 * to fill with a throw: a handler is registered only through jobs/registry.ts, so before the
 * handover no kind has one, and enqueue treats every kind as unregistered (its payload as given,
 * DEFAULT_MAX_ATTEMPTS), exactly as an empty registry did when enqueue lived in jobs/runner.ts.
 */
let lookup: (kind: string) => QueuedKind | undefined = () => undefined;

/** Called by jobs/registry.ts as it loads, with its getJobHandler. */
export function provideHandlerLookup(source: (kind: string) => QueuedKind | undefined): void {
  lookup = source;
}

/** The handler of `kind`, or undefined while it has none. */
export function queuedHandlerOf(kind: string): QueuedKind | undefined {
  return lookup(kind);
}
