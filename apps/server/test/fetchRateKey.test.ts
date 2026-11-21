// The user's rate key reaches safeFetch (https://github.com/bgoleno/opportun/issues/617): a job that
// belongs to a user, and a request a user makes, fetch under that user's key, so the per-host bucket
// shares a vendor host between users. safeFetch's own fairness is tested in safeFetch.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerJob, requireService, unregisterJob } from '../src/jobs/registry';
import { enqueue } from '../src/jobs/runner';
import type { SafeFetchOptions } from '../src/lib/safeFetch';
import { useApi } from './api';

const boot = useApi();
const KIND = 'test.rate_key_fetch';

afterEach(() => unregisterJob(KIND));

/** A sourceFetch that records the options of every call, then refuses it. */
function recording() {
  const seen: SafeFetchOptions[] = [];
  const fetch = async (_url: string, opts: SafeFetchOptions): Promise<never> => {
    seen.push(opts);
    throw new Error('no network in this test');
  };
  return { seen, fetch };
}

describe('the rate key a fetch is made under (#617)', () => {
  it("a user's job fetches under that user's key, and a job of no user under none", async () => {
    const { app, a } = await boot();
    const rec = recording();
    app.jobs.services.sourceFetch = rec.fetch as never;
    registerJob({
      kind: KIND,
      payloadSchema: z.object({}),
      maxAttempts: 1,
      run: async (_db, _payload, ctx) => {
        await requireService(ctx, 'sourceFetch')('https://boards-api.greenhouse.io/v1/x', {
          allowHosts: ['boards-api.greenhouse.io'],
        }).catch(() => undefined);
      },
    });
    await enqueue(app.db, KIND, {}, { userId: a.userId });
    await enqueue(app.db, KIND, {});
    await app.jobs.drain();
    expect(rec.seen.map((o) => o.rateKey).sort()).toEqual([a.userId, undefined].sort());
  });

  it("a user's request fetches under that user's key", async () => {
    const { app, a } = await boot();
    const rec = recording();
    app.jobs.services.sourceFetch = rec.fetch as never;
    await a.request({
      method: 'POST',
      url: '/api/v1/capture',
      payload: { url: 'https://jobs.example.com/posting/1' },
    });
    expect(rec.seen.length).toBeGreaterThan(0);
    expect(rec.seen.every((o) => o.rateKey === a.userId)).toBe(true);
  });
});
