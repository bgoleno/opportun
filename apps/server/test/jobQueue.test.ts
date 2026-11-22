// The job queue as lib/ has it (https://github.com/bgoleno/opportun/issues/788): enqueue reads a
// kind's handler from the registry, which hands its lookup over as it loads, so a registered kind
// still has its payload checked by its schema and takes its own maxAttempts.
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jobs } from '../src/db/schema';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import { DEFAULT_MAX_ATTEMPTS, enqueue } from '../src/lib/jobQueue';
import { openTestDb } from './helpers';

const KIND = 'test.queue_788';

afterEach(() => {
  unregisterJob(KIND);
});

describe('enqueue from lib/jobQueue (#788)', () => {
  it("takes a registered kind's maxAttempts and parses its payload", async () => {
    registerJob({
      kind: KIND,
      payloadSchema: z.object({ n: z.number() }).strict(),
      maxAttempts: 2,
      run: async () => undefined,
    });
    const opened = await openTestDb();
    try {
      const id = await enqueue(opened.handle.db, KIND, { n: 1 });
      const row = await opened.handle.db.select().from(jobs).where(eq(jobs.id, id)).get();
      expect(row).toMatchObject({ kind: KIND, maxAttempts: 2, payload: { n: 1 } });
      // A payload the handler's schema refuses is never queued.
      await expect(enqueue(opened.handle.db, KIND, { n: 'one' })).rejects.toThrow();
      const rows = await opened.handle.db.select().from(jobs).where(eq(jobs.kind, KIND)).all();
      expect(rows).toHaveLength(1);
    } finally {
      await opened.close();
    }
  });

  it('queues an unregistered kind as it comes, with the default attempts', async () => {
    const opened = await openTestDb();
    try {
      const id = await enqueue(opened.handle.db, KIND, { anything: true });
      const row = await opened.handle.db.select().from(jobs).where(eq(jobs.id, id)).get();
      expect(row).toMatchObject({ maxAttempts: DEFAULT_MAX_ATTEMPTS, payload: { anything: true } });
    } finally {
      await opened.close();
    }
  });
});
