// The test helpers of https://github.com/bgoleno/opportun/issues/615: runQueuedJob runs the job a
// test queued and nothing else, and holdInstanceSchedules keeps the boot-seeded schedules from
// being claimed in place of a test's own job.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jobs } from '../src/db/schema';
import { registerJob } from '../src/jobs/registry';
import { enqueue, readSchedules, runNextJob, SCHEDULE_PREFIX } from '../src/jobs/runner';
import { useApi } from './api';
import { holdInstanceSchedules, runQueuedJob } from './runQueuedJob';

const boot = useApi();
const KIND = 'test.run_queued_job';
const LONG_AGO = Date.UTC(2020, 0, 1);

const ran: string[] = [];
registerJob({
  kind: KIND,
  payloadSchema: z.object({ name: z.string() }),
  maxAttempts: 1,
  run: async (_db, payload) => {
    ran.push(payload.name);
  },
});

const row = async (app: Awaited<ReturnType<typeof boot>>['app'], id: string) =>
  (await app.db.select().from(jobs).where(eq(jobs.id, id)).get())!;

describe('#615: runQueuedJob', () => {
  it('runs its own job though another is due first, and puts the other back as it was', async () => {
    const { app } = await boot();
    ran.length = 0;
    const earlier = await enqueue(app.db, KIND, { name: 'earlier' }, { runAt: LONG_AGO });
    const mine = await enqueue(app.db, KIND, { name: 'mine' });
    await runQueuedJob(app, mine);
    expect(ran).toEqual(['mine']);
    expect(await row(app, earlier)).toMatchObject({ status: 'pending', runAt: LONG_AGO });
    expect((await row(app, mine)).status).toBe('done');
  });

  it('throws when its job is not due, and runs nothing', async () => {
    const { app } = await boot();
    ran.length = 0;
    const other = await enqueue(app.db, KIND, { name: 'other' }, { runAt: LONG_AGO });
    const later = await enqueue(app.db, KIND, { name: 'later' }, { runAt: Date.now() + 3_600_000 });
    await expect(runQueuedJob(app, later)).rejects.toThrow(/did not run/);
    expect(ran).toEqual([]);
    expect(await row(app, other)).toMatchObject({ status: 'pending', runAt: LONG_AGO });
  });
});

describe('#615: holdInstanceSchedules', () => {
  it("parks a seeded schedule's due occurrence, and leaves the test's own jobs alone", async () => {
    const { app } = await boot();
    ran.length = 0;
    const seeded = (await readSchedules(app.db)).find((s) => s.userId === null);
    expect(seeded).toBeDefined();
    // A seeded schedule's occurrence that has come due, as on the real clock at its cron.
    const due = await enqueue(
      app.db,
      KIND,
      { name: 'seeded' },
      { runAt: LONG_AGO, dedupeKey: `${SCHEDULE_PREFIX}${seeded!.kind}` },
    );
    const mine = await enqueue(app.db, KIND, { name: 'mine' });
    await holdInstanceSchedules(app);
    await runNextJob(app.db, { services: app.jobs.services });
    expect(ran).toEqual(['mine']);
    expect((await row(app, due)).status).toBe('pending');
    expect((await row(app, mine)).status).toBe('done');
  });
});
