// The registry and the queue loaded in either order (https://github.com/bgoleno/opportun/issues/788):
// jobs/registry.ts hands its handler lookup to lib/jobHandlerLookup.ts, a leaf, as it loads, and
// lib/jobQueue.ts reads it there. Each case starts from a fresh module graph and imports the two
// in its own order; either way a registered kind's handler is the one enqueue uses. The insert is
// captured by a fake executor (no dedupe key, so enqueue takes its plain insert).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Exec } from '../src/db/client';

const KIND = 'test.load_order_788';

function capture(): { exec: Exec; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const exec = {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        run: async () => {
          rows.push(row);
        },
      }),
    }),
  } as unknown as Exec;
  return { exec, rows };
}

async function enqueueRegistered(order: 'registry first' | 'queue first'): Promise<unknown[]> {
  const load = {
    registry: () => import('../src/jobs/registry'),
    queue: () => import('../src/lib/jobQueue'),
  };
  const [registry, queue] =
    order === 'registry first'
      ? [await load.registry(), await load.queue()]
      : await (async () => {
          const q = await load.queue();
          return [await load.registry(), q] as const;
        })();
  registry.registerJob({
    kind: KIND,
    payloadSchema: z.object({ n: z.number() }).strict(),
    maxAttempts: 2,
    run: async () => undefined,
  });
  try {
    const { exec, rows } = capture();
    await queue.enqueue(exec, KIND, { n: 1 });
    await expect(queue.enqueue(exec, KIND, { n: 'one' })).rejects.toThrow();
    return rows.map((r) => r.maxAttempts);
  } finally {
    registry.unregisterJob(KIND);
  }
}

describe('the registry and the queue, in either load order (#788)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('the registry first, then the queue', async () => {
    expect(await enqueueRegistered('registry first')).toEqual([2]);
  });

  it('the queue first, then the registry', async () => {
    expect(await enqueueRegistered('queue first')).toEqual([2]);
  });
});
