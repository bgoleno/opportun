// The seed CLI runs outside the server, where no job handler is registered (#827, qa on #820): a
// rank-batch cleanup it queues must still get its handler's attempts and a validated payload.
// The modules are loaded afresh here (vi.resetModules): the test helpers load the whole app, whose
// jobs/index registers every handler, and the CLI loads none of that. What is checked is what
// enqueue reads (lib/jobHandlerLookup's queuedHandlerOf): the attempts it stores, and the schema
// it parses the payload with.
import { resolvePolicy } from '@opportun/ai';
import { describe, expect, it, vi } from 'vitest';

const KIND = 'discovery.rank_batch_cleanup';

describe('the seed CLI registers the rank-batch cleanup handler (#827)', () => {
  it("a cleanup it queues has the handler's attempts, and a bad payload is refused", async () => {
    vi.resetModules();
    const { queuedHandlerOf } = await import('../src/lib/jobHandlerLookup');
    await import('../src/jobs/registry');
    // Nothing of the server's: only what the CLI registers below.
    expect(queuedHandlerOf(KIND)).toBeUndefined();
    // Importing the CLI module registers what it queues; its entry runs only from the command line.
    await import('../src/cli/seedDemo');
    const queued = queuedHandlerOf(KIND);
    expect(queued?.maxAttempts).toBe(6);
    expect(() =>
      queued!.payloadSchema.parse({
        userId: 'some-user',
        policy: resolvePolicy('discovery.rank', undefined),
        providerBatchId: 'msgbatch_x',
        refs: [],
        cancel: true,
      }),
    ).not.toThrow();
    expect(() => queued!.payloadSchema.parse({ userId: '' })).toThrow();
  });
});
