// A capture and a board run that find one posting at the same moment leave one row for it
// (https://github.com/bgoleno/opportun/issues/268, point 3). qa showed it on a real server: real
// extension captures aimed at the moment a run stored the posting left the capture's accepted row
// and the board's pending card, in 3 of 12. A run under its ingest lock had nothing to stop a
// capture, which looked, then wrote, outside it. Each order is built here with a race point, and a
// real run of a real source. The provider is mocked and every posting is made up.
import { runStructured } from '@opportun/ai';
import { newId, type NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSource, resetSources } from '../src/adapters/discoverySource';
import { onSlowTransaction } from '../src/db/gate';
import { discoveryResults, discoveryRuns, jobs, opportunities } from '../src/db/schema';
import { drainWaitingResults } from '../src/jobs/discoveryRankWaiting';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob } from '../src/jobs/runner';
import { resolveCapture } from '../src/lib/captureResolve';
import type { UserCtx } from '../src/repos/base';
import { createCompany } from '../src/repos/companies';
import { createSource, getResult, setRankDeferred } from '../src/repos/discovery';
import { getOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import { sqliteOnly } from './db';
import type { TestClient } from './isolation';
import { heldApart, pauseAt, settledOrWaiting } from './race';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const JOB = { company: 'Initech', title: 'Platform Engineer', location: 'Example City, EX' };
const BOARD_TEXT = 'Own the platform, as the board has it.';
const CAPTURE_TEXT = 'Own the platform, as the page has it.';

/** Past its first run, so the posting is not held for Rank these. */
async function boardWithThePosting(app: FastifyInstance, c: TestClient): Promise<string> {
  const posting: NormalizedPosting = {
    ...JOB,
    descriptionMd: BOARD_TEXT,
    postingUrl: 'https://boards.example.com/initech/1',
    externalId: 'gh-1',
  };
  registerSource({
    kind: 'ats_lever',
    async *fetchPostings() {
      yield { posting, nextCursor: null };
    },
  });
  const source = await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: 'initech' },
    roleTargetId: null,
  });
  const at = Date.now() - 86_400_000;
  await app.db
    .insert(discoveryRuns)
    .values({
      id: newId(),
      userId: c.userId,
      sourceId: source.id,
      startedAt: at,
      finishedAt: at,
      stats: null,
      error: null,
    })
    .run();
  return source.id;
}

async function runBoard(app: FastifyInstance, c: TestClient, sourceId: string): Promise<void> {
  await enqueue(
    app.db,
    DISCOVERY_RUN_KIND,
    { sourceId },
    { dedupeKey: `${DISCOVERY_RUN_KIND}:${sourceId}`, userId: c.userId },
  );
  await runNextJob(app.db, { services: app.jobs.services });
}

const capture = (app: FastifyInstance, c: TestClient, over: Partial<NormalizedPosting> = {}) =>
  resolveCapture(app.db, ctxOf(c), {
    posting: {
      ...JOB,
      descriptionMd: CAPTURE_TEXT,
      postingUrl: 'https://www.indeed.com/viewjob?jk=abc123def456',
      externalId: 'abc123def456',
      ...over,
    },
    captureText: CAPTURE_TEXT,
    siteId: 'indeed',
  });

const rowsOf = (app: FastifyInstance, c: TestClient) =>
  app.db
    .select({
      id: discoveryResults.id,
      disposition: discoveryResults.disposition,
      opportunityId: discoveryResults.opportunityId,
      posting: discoveryResults.posting,
    })
    .from(discoveryResults)
    .where(eq(discoveryResults.userId, c.userId))
    .all();

const opportunitiesOf = (app: FastifyInstance, c: TestClient) =>
  app.db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(eq(opportunities.userId, c.userId))
    .all();

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
});
afterEach(() => resetSources());

describe('a capture and a board run on one posting', () => {
  it('a capture that has looked keeps the run from storing the posting until it has written', async () => {
    const { app, a } = await boot();
    onSlowTransaction(() => undefined);
    const sourceId = await boardWithThePosting(app, a);
    const pause = pauseAt('captureResolve.matched.locked');

    const captured = capture(app, a);
    await pause.reached;
    const run = runBoard(app, a, sourceId);
    const seen = await settledOrWaiting(app, run, pause);
    pause.release();
    const { opportunityId } = await captured;
    await run;

    const rows = await rowsOf(app, a);
    expect(rows.map((r) => r.disposition)).toEqual(['accepted']);
    expect(rows[0]?.opportunityId).toBe(opportunityId);
    expect(rows[0]?.posting.descriptionMd).toBe(CAPTURE_TEXT);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
    expect(seen).toBe('waiting');
  });

  it('a run that has checked keeps the capture out, and the capture completes what it stored', async () => {
    const { app, a } = await boot();
    onSlowTransaction(() => undefined);
    const sourceId = await boardWithThePosting(app, a);
    const pause = pauseAt('discovery.ingest.locked');

    const run = runBoard(app, a, sourceId);
    await pause.reached;
    const captured = capture(app, a);
    const seen = await settledOrWaiting(app, captured, pause);
    pause.release();
    await run;
    const { opportunityId, resultId } = await captured;

    const rows = await rowsOf(app, a);
    expect(rows.map((r) => r.disposition)).toEqual(['accepted']);
    expect(rows[0]?.id).toBe(resultId);
    expect(rows[0]?.opportunityId).toBe(opportunityId);
    // The board's row, kept as the board has it: a capture fills what a lead lacks.
    expect(rows[0]?.posting.descriptionMd).toBe(BOARD_TEXT);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
    expect(seen).toBe('waiting');
  });

  it('two captures of one posting at once leave one row and one opportunity', async () => {
    const { app, a } = await boot();
    const [first, second] = await heldApart(
      app,
      'captureResolve.matched.locked',
      () => capture(app, a),
      () => capture(app, a),
    );
    expect(second.opportunityId).toBe(first.opportunityId);
    expect(second.resultId).toBe(first.resultId);
    expect(second.createdOpportunity).toBe(false);
    expect(await rowsOf(app, a)).toHaveLength(1);
    expect(await opportunitiesOf(app, a)).toHaveLength(1);
  });

  it('two captures both past the look move the stage once, and neither fails', async () => {
    const { app, a } = await boot();
    const [first, second] = await heldApart(
      app,
      'captureResolve.advance.locked',
      () => capture(app, a),
      () => capture(app, a),
    );
    expect(first.stageMovedTo).toBe('interested');
    expect(second.stageMovedTo).toBeNull();
    expect((await getOpportunity(app.db, ctxOf(a), first.opportunityId)).stage).toBe('interested');
  });

  describe('during a ranking call on the row', () => {
    /**
     * The board's row, waiting for budget, with a call for it parked at the provider. With `bare`
     * the stored posting has only the keys a row can lack (remote, compNote, postedAt left out): a
     * row stored by an older version or inserted directly, which sanitizePosting would not make today.
     */
    async function callInFlight(app: FastifyInstance, c: TestClient, bare = false) {
      const ctx = ctxOf(c);
      const sourceId = await boardWithThePosting(app, c);
      await runBoard(app, c, sourceId);
      await app.db.delete(jobs).run();
      const [row] = await rowsOf(app, c);
      const id = row?.id as string;
      if (bare && row !== undefined) {
        const { remote, compNote, postedAt, ...kept } = row.posting;
        void [remote, compNote, postedAt];
        await app.db
          .update(discoveryResults)
          .set({ posting: kept })
          .where(eq(discoveryResults.id, id))
          .run();
      }
      await setRankDeferred(app.db, ctx, id);
      let go!: () => void;
      const released = new Promise<void>((resolve) => (go = resolve));
      let began!: () => void;
      const started = new Promise<void>((resolve) => (began = resolve));
      vi.mocked(runStructured).mockImplementation(async () => {
        began();
        await released;
        return { score: 60, rationale: 'A fair match.', disqualifiers: [] } as never;
      });
      const drain = drainWaitingResults(app.db, ctx);
      await started;
      return { id, drain, release: () => go() };
    }

    it('a capture that keeps the text as it is does not throw the paid score away', async () => {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const { id, drain, release } = await callInFlight(app, a, true);

      const { resultId } = await capture(app, a);
      release();
      await drain;

      expect(resultId).toBe(id);
      const after = await getResult(app.db, ctx, id);
      expect(after.disposition).toBe('accepted');
      expect(after.posting.descriptionMd).toBe(BOARD_TEXT);
      expect(after.aiScore).toBe(60);
      expect(after.posting).not.toHaveProperty('remote');
      expect(after.posting).not.toHaveProperty('compNote');
    });

    it('a capture that adds what the row lacked is new text, so that score is refused', async () => {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const { id, drain, release } = await callInFlight(app, a);

      await capture(app, a, { compNote: '$150k-$180k' });
      release();
      await drain;

      const after = await getResult(app.db, ctx, id);
      expect(after.disposition).toBe('accepted');
      expect(after.posting.compNote).toBe('$150k-$180k');
      expect(after.aiScore).toBeNull();
    });
  });

  it('a capture after the run has finished completes the row, with no waiting', async () => {
    const { app, a } = await boot();
    const sourceId = await boardWithThePosting(app, a);
    await runBoard(app, a, sourceId);
    const { resultId } = await capture(app, a);
    const rows = await rowsOf(app, a);
    expect(rows.map((r) => r.disposition)).toEqual(['accepted']);
    expect(rows[0]?.id).toBe(resultId);
  });

  it('a run after the capture has finished stores nothing', async () => {
    const { app, a } = await boot();
    const sourceId = await boardWithThePosting(app, a);
    const { resultId } = await capture(app, a);
    await runBoard(app, a, sourceId);
    const rows = await rowsOf(app, a);
    expect(rows.map((r) => r.id)).toEqual([resultId]);
  });

  // Lock order (repos/submissionReview.ts): every advisory lock before any row write. The capture
  // writes the lead's row before createOpportunity reaches the company lookup, which takes the
  // user's lock, so a writer holding that lock and waiting on the row would close a cycle (40P01).
  // Pinned from the other end: a taker of the user's lock is held while the capture is only
  // parked after its look, before any write. On SQLite everything waits at the gate, so this is
  // Postgres only.
  it.runIf(!sqliteOnly)("a capture takes the user's lock before its first row write", async () => {
    const { app, a } = await boot();
    const sourceId = await boardWithThePosting(app, a);
    await runBoard(app, a, sourceId);
    const [first, second] = await heldApart(
      app,
      'captureResolve.matched.locked',
      () => capture(app, a),
      () => createCompany(app.db, ctxOf(a), { name: 'Unrelated Co', status: 'followed' }),
    );
    expect(first.createdOpportunity).toBe(true);
    expect(second.name).toBe('Unrelated Co');
  });

  // On SQLite every write waits at the one gate, so only Postgres can say whose lock this is.
  it.runIf(!sqliteOnly)("the lock is the user's: another user's capture goes ahead", async () => {
    const { app, a, b } = await boot();
    onSlowTransaction(() => undefined);
    const pause = pauseAt('captureResolve.matched.locked');
    const captured = capture(app, a);
    await pause.reached;
    const other = capture(app, b);
    const seen = await settledOrWaiting(app, other, pause);
    pause.release();
    await Promise.all([captured, other]);
    // The second caller reaches the same point and is not parked there.
    expect(seen).toBe('arrived');
    expect(await rowsOf(app, a)).toHaveLength(1);
    expect(await rowsOf(app, b)).toHaveLength(1);
  });
});
