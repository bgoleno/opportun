// Discovery repositories (Task 4): sources, runs and results, each scoped to its owner, plus the
// adapter registry's override semantics.
import type { NormalizedPosting } from '@opportun/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSource,
  hasSource,
  registerBuiltinSource,
  registerSource,
  resetSources,
  SOURCE_CONFIG_SCHEMAS,
  UnknownSourceError,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { DEFAULT_DISCOVERY_CRON, ATS_REVERIFY_CRON } from '../src/jobs/atsDetect';
import { COMPANY_SUGGEST_CRON } from '../src/jobs/companySuggest';
import { BACKUP_CRON } from '../src/jobs/backup';
import { DISCOVERY_REFINE_CRON } from '../src/jobs/refineDiscoveryPrompt';
import { userCronProblem } from '../src/jobs/runner';
import { HttpError } from '../src/lib/errors';
import {
  createRun,
  createSource,
  deleteSource,
  finishRun,
  getResult,
  getSourceRow,
  insertResult,
  listResults,
  listRuns,
  listSources,
  setDisposition,
  updateSource,
} from '../src/repos/discovery';
import { createRoleTarget } from '../src/repos/profile';
import { createCompany } from '../src/repos/companies';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 50, offset: 0 };

const posting: NormalizedPosting = {
  company: 'Initech',
  title: 'Staff Platform Engineer',
  descriptionMd: 'Build things.',
  postingUrl: 'https://boards.example.com/initech/1',
  location: 'Austin, TX',
  externalId: '1',
};

async function expectStatus(fn: () => unknown, status: number, code?: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(status);
    if (code !== undefined) expect((err as HttpError).code).toBe(code);
    return;
  }
  throw new Error(`expected HttpError ${status}`);
}

describe('discovery sources repo', () => {
  it('creates, lists, updates and deletes a source with per-kind config', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const src = await createSource(app.db, ctx, {
      kind: 'ats_lever',
      config: { org: 'initech' },
      scheduleCron: '0 7 * * *',
    });
    expect(src).toMatchObject({
      userId: a.userId,
      kind: 'ats_lever',
      config: { org: 'initech' },
      enabled: true,
      scheduleCron: '0 7 * * *',
      status: 'ok',
      statusDetail: null,
      roleTargetId: null,
      companyId: null,
    });
    expect(await listSources(app.db, ctx, PAGE)).toEqual({ items: [src], total: 1 });

    const updated = await updateSource(app.db, ctx, src.id, {
      enabled: false,
      config: { org: 'initech-labs' },
    });
    expect(updated).toMatchObject({ enabled: false, config: { org: 'initech-labs' } });
    await deleteSource(app.db, ctx, src.id);
    expect((await listSources(app.db, ctx, PAGE)).total).toBe(0);
  });

  it('validates config per kind, the cron expression and owned references', async () => {
    const { app, a, b } = await boot();
    const ctx = ctxOf(a);
    await expectStatus(
      async () =>
        await createSource(app.db, ctx, { kind: 'ats_greenhouse', config: { org: 'Bad Org!' } }),
      422,
      'invalid_config',
    );
    await expectStatus(
      async () => await createSource(app.db, ctx, { kind: 'manual', config: { surprise: true } }),
      422,
      'invalid_config',
    );
    await expectStatus(
      async () =>
        await createSource(app.db, ctx, {
          kind: 'ats_ashby',
          config: { org: 'initech' },
          scheduleCron: 'every tuesday',
        }),
      422,
      'invalid_cron',
    );
    const bTarget = await createRoleTarget(app.db, ctxOf(b), { name: 'B', titleFamily: 'PM' });
    const bCompany = await createCompany(app.db, ctxOf(b), { name: 'Globex' });
    await expectStatus(
      async () =>
        await createSource(app.db, ctx, {
          kind: 'manual',
          config: {},
          roleTargetId: bTarget.id,
        }),
      404,
    );
    await expectStatus(
      async () =>
        await createSource(app.db, ctx, { kind: 'manual', config: {}, companyId: bCompany.id }),
      404,
    );
    const aTarget = await createRoleTarget(app.db, ctx, { name: 'A', titleFamily: 'Eng' });
    const ok = await createSource(app.db, ctx, {
      kind: 'manual',
      config: {},
      roleTargetId: aTarget.id,
    });
    expect(ok.roleTargetId).toBe(aTarget.id);
  });

  it('enforces the cron granularity floor: five fields, at most hourly', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const make = async (scheduleCron: string) =>
      await createSource(app.db, ctx, {
        kind: 'ats_ashby',
        config: { org: 'initech' },
        scheduleCron,
      });
    for (const cron of ['* * * * *', '*/30 * * * *', '0,30 9 * * *', '0 * * * * *']) {
      let caught: unknown;
      try {
        await make(cron);
      } catch (err) {
        caught = err;
      }
      expect(caught, cron).toBeInstanceOf(HttpError);
      expect(caught as HttpError, cron).toMatchObject({ statusCode: 422, code: 'invalid_cron' });
      expect((caught as HttpError).details?.message, cron).toMatch(/hour|five fields/);
    }
    expect((await make('0 * * * *')).scheduleCron).toBe('0 * * * *');
    const src = await make('0 7 * * *');
    await expectStatus(
      async () => await updateSource(app.db, ctx, src.id, { scheduleCron: '* * * * *' }),
      422,
    );
    await expectStatus(
      async () => await updateSource(app.db, ctx, src.id, { scheduleCron: '0 0 7 * * *' }),
      422,
    );
  });

  it('userCronProblem: seconds field and sub-hour spacing refused; hourly and the defaults pass', () => {
    expect(userCronProblem('* * * * *')).toBe('must run at most once an hour');
    expect(userCronProblem('*/59 * * * *')).toBe('must run at most once an hour');
    expect(userCronProblem('0 0 7 * * *')).toMatch(/five fields.*seconds/);
    expect(userCronProblem('* * * * * *')).toMatch(/five fields/);
    expect(userCronProblem('every tuesday')).toBe('must be a valid cron expression');
    for (const ok of [
      '0 * * * *',
      '0 */2 * * *',
      DEFAULT_DISCOVERY_CRON,
      COMPANY_SUGGEST_CRON,
      ATS_REVERIFY_CRON,
      DISCOVERY_REFINE_CRON,
      BACKUP_CRON,
    ]) {
      expect(userCronProblem(ok), ok).toBeNull();
    }
  });

  it('isolates sources between users', async () => {
    const { app, a, b } = await boot();
    const src = await createSource(app.db, ctxOf(a), { kind: 'manual', config: {} });
    await expectStatus(async () => await getSourceRow(app.db, ctxOf(b), src.id), 404);
    await expectStatus(
      async () => await updateSource(app.db, ctxOf(b), src.id, { enabled: false }),
      404,
    );
    await expectStatus(async () => await deleteSource(app.db, ctxOf(b), src.id), 404);
    expect((await listSources(app.db, ctxOf(b), PAGE)).total).toBe(0);
    expect((await getSourceRow(app.db, ctxOf(a), src.id)).enabled).toBe(true);
  });
});

describe('discovery runs and results repo', () => {
  it('records a run, its results and dispositions', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const src = await createSource(app.db, ctx, { kind: 'ats_lever', config: { org: 'initech' } });
    const run = await createRun(app.db, ctx, { sourceId: src.id });
    expect(run).toMatchObject({ sourceId: src.id, finishedAt: null, error: null });
    const res = await insertResult(app.db, ctx, {
      runId: run.id,
      posting,
      dedupeKey: 'initech|platform engineer|austin tx',
      resolution: 'full',
    });
    expect(res).toMatchObject({
      posting,
      disposition: 'pending',
      aiScore: null,
      resolution: 'full',
      sourceId: src.id,
      sourceKind: 'ats_lever',
    });
    const finished = await finishRun(app.db, ctx, run.id, {
      stats: { fetched: 1, inserted: 1, duplicates: 0 },
    });
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.stats).toEqual({ fetched: 1, inserted: 1, duplicates: 0 });
    expect((await listRuns(app.db, ctx, src.id, PAGE)).items.map((r) => r.id)).toEqual([run.id]);

    expect((await listResults(app.db, ctx, { ...PAGE, disposition: 'pending' })).total).toBe(1);
    const dismissed = await setDisposition(app.db, ctx, res.id, 'dismissed');
    expect(dismissed.disposition).toBe('dismissed');
    expect((await listResults(app.db, ctx, { ...PAGE, disposition: 'pending' })).total).toBe(0);
    expect((await listResults(app.db, ctx, { ...PAGE, disposition: 'dismissed' })).total).toBe(1);
  });

  it('isolates runs and results between users', async () => {
    const { app, a, b } = await boot();
    const src = await createSource(app.db, ctxOf(a), { kind: 'manual', config: {} });
    const run = await createRun(app.db, ctxOf(a), { sourceId: src.id });
    const res = await insertResult(app.db, ctxOf(a), {
      runId: run.id,
      posting,
      dedupeKey: null,
      resolution: 'full',
    });
    // b can neither start a run on a's source, nor write into a's run, nor touch a's results.
    await expectStatus(async () => await createRun(app.db, ctxOf(b), { sourceId: src.id }), 404);
    await expectStatus(
      async () =>
        await insertResult(app.db, ctxOf(b), {
          runId: run.id,
          posting,
          dedupeKey: null,
          resolution: 'full',
        }),
      404,
    );
    await expectStatus(async () => await finishRun(app.db, ctxOf(b), run.id, { error: 'x' }), 404);
    await expectStatus(async () => await getResult(app.db, ctxOf(b), res.id), 404);
    await expectStatus(
      async () => await setDisposition(app.db, ctxOf(b), res.id, 'dismissed'),
      404,
    );
    expect((await listResults(app.db, ctxOf(b), PAGE)).total).toBe(0);
    expect((await listRuns(app.db, ctxOf(b), src.id, PAGE)).total).toBe(0);
    expect((await getResult(app.db, ctxOf(a), res.id)).disposition).toBe('pending');
  });
});

describe('discovery source registry', () => {
  afterEach(() => resetSources());

  const fake = (label: string): DiscoverySource => ({
    kind: 'ats_lever',
    async *fetchPostings() {
      yield { posting: { ...posting, title: label }, nextCursor: null };
    },
  });

  it('an override replaces a kind until reset, and the built-in comes back', () => {
    expect(() => getSource('manual')).toThrow(UnknownSourceError);
    registerBuiltinSource(fake('builtin'));
    registerSource(fake('override'));
    expect(hasSource('ats_lever')).toBe(true);
    expect(getSource('ats_lever')).not.toBe(undefined);
    const titleOf = async (src: DiscoverySource) => {
      for await (const item of src.fetchPostings({} as never, {}, null)) return item.posting.title;
      return undefined;
    };
    return (async () => {
      expect(await titleOf(getSource('ats_lever'))).toBe('override');
      registerSource(fake('second override'));
      expect(await titleOf(getSource('ats_lever'))).toBe('second override');
      resetSources();
      expect(await titleOf(getSource('ats_lever'))).toBe('builtin');
    })();
  });

  it('has a config schema for every kind', () => {
    expect(Object.keys(SOURCE_CONFIG_SCHEMAS).sort()).toEqual(
      [
        'alert_email',
        'ats_ashby',
        'ats_greenhouse',
        'ats_lever',
        'ats_workday',
        'extension',
        'manual',
        'mcp',
      ].sort(),
    );
  });
});
