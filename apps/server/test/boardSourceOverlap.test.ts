// Two detections of one company at once register its board once
// (https://github.com/bgoleno/opportun/issues/268, point 2). posting.reconcile detects a board inline,
// outside the company.ats_detect job's key, so two opportunities at one company, or a reconcile and
// a detection job, can get there together. discovery_sources has no unique index, and the check
// is a read then a create. Every request goes through the real safeFetch logic over a scripted
// network, and nothing here reaches the internet.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { resetSources, type SourceContext } from '../src/adapters/discoverySource';
import { onSlowTransaction } from '../src/db/gate';
import { companies, settings } from '../src/db/schema';
import { detectAts, syncFollowedCompany } from '../src/jobs/atsDetect';
import { createSafeFetch } from '../src/lib/safeFetch';
import type { UserCtx } from '../src/repos/base';
import { createCompany, getCompany } from '../src/repos/companies';
import { listSources, sourceScheduleName } from '../src/repos/discovery';
import { useApi } from './api';
import { sqliteOnly } from './db';
import type { TestClient } from './isolation';
import { pauseAt, settledOrWaiting } from './race';

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
afterEach(() => resetSources());

const POINT = 'atsDetect.board_source.locked';
const LEVER_HIT = 'https://api.lever.co/v0/postings/initech?mode=json&limit=1';
const LEVER_JOBS = '[{"id":"abc-1","text":"Staff Platform Engineer"}]';

const sctx: SourceContext = {
  fetch: createSafeFetch({
    now: () => 0,
    sleep: async () => undefined,
    resolve: async () => ['93.184.216.34'],
    request: async (target) => {
      const hit = target.url.href === LEVER_HIT;
      return {
        status: hit ? 200 : 404,
        headers: {},
        body: (async function* () {
          yield Buffer.from(hit ? LEVER_JOBS : '{}');
        })(),
      };
    },
  }),
  log: {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
  } as unknown as SourceContext['log'],
};

const followed = (app: FastifyInstance, ctx: UserCtx, name = 'Initech') =>
  createCompany(app.db, ctx, { name, status: 'followed' });

const sourcesOf = async (app: FastifyInstance, ctx: UserCtx) =>
  (await listSources(app.db, ctx, { limit: 50, offset: 0 })).items;

describe('two detections of one company at once', () => {
  it('one that has looked keeps the other from creating a source until it has written', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    onSlowTransaction(() => undefined);
    const company = await followed(app, ctx);
    const pause = pauseAt(POINT);

    const first = detectAts(app.db, ctx, company.id, sctx);
    await pause.reached;
    const second = detectAts(app.db, ctx, company.id, sctx);
    const seen = await settledOrWaiting(app, second, pause);
    pause.release();
    const [one, other] = await Promise.all([first, second]);

    const sources = await sourcesOf(app, ctx);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: 'ats_lever', companyId: company.id, enabled: true });
    expect(one).toMatchObject({ status: 'found', sourceId: sources[0]?.id });
    expect(other).toMatchObject({ status: 'found', sourceId: sources[0]?.id });
    expect(seen).toBe('waiting');
  });

  it('with nothing held, side by side, there is one source', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await followed(app, ctx);
    await Promise.all([
      detectAts(app.db, ctx, company.id, sctx),
      detectAts(app.db, ctx, company.id, sctx),
      detectAts(app.db, ctx, company.id, sctx),
    ]);
    expect(await sourcesOf(app, ctx)).toHaveLength(1);
  });

  it('a follow at the same moment as a detection makes one source too', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    onSlowTransaction(() => undefined);
    const created = await followed(app, ctx);
    await app.db
      .update(companies)
      .set({ atsKind: 'ats_lever', atsRef: 'initech' })
      .where(eq(companies.id, created.id))
      .run();
    const company = await getCompany(app.db, ctx, created.id);
    const pause = pauseAt(POINT);

    const first = detectAts(app.db, ctx, company.id, sctx);
    await pause.reached;
    const second = syncFollowedCompany(app.db, ctx, company);
    const seen = await settledOrWaiting(app, second, pause);
    pause.release();
    await Promise.all([first, second]);

    expect(await sourcesOf(app, ctx)).toHaveLength(1);
    expect(seen).toBe('waiting');
  });

  it('the one source has one schedule, and the second detection leaves it alone', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await followed(app, ctx);
    const first = await detectAts(app.db, ctx, company.id, sctx);
    const second = await detectAts(app.db, ctx, company.id, sctx);
    expect(second).toMatchObject({ status: 'found' });
    expect((second as { sourceId: string }).sourceId).toBe(
      (first as { sourceId: string }).sourceId,
    );
    const [source] = await sourcesOf(app, ctx);
    const schedule = await app.db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, `schedule:${sourceScheduleName(source?.id as string)}`))
      .all();
    expect(schedule).toHaveLength(1);
  });

  // On SQLite every write waits at the one gate, so only Postgres can say whose lock this is.
  it.runIf(!sqliteOnly)('another company is not held back', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    onSlowTransaction(() => undefined);
    const company = await followed(app, ctx);
    const otherCompany = await followed(app, ctx, 'Initech Two');
    const otherSctx = sctx;
    const pause = pauseAt(POINT);

    const first = detectAts(app.db, ctx, company.id, sctx);
    await pause.reached;
    const second = detectAts(app.db, ctx, otherCompany.id, otherSctx);
    const seen = await settledOrWaiting(app, second, pause);
    pause.release();
    await Promise.all([first, second]);

    // It reaches the same point and is not parked there.
    expect(seen).toBe('arrived');
  });
});
