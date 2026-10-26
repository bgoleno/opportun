// Discovery engine (Task 5): sanitized ingestion, dedupe, source status with retry backoff, and
// per-source schedule rows.
import { NormalizedPostingSchema, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import {
  discoveryResults,
  discoveryRuns,
  discoverySources,
  dismissalFeedback,
  jobs,
  settings,
} from '../src/db/schema';
import {
  DISCOVERY_RUN_KIND,
  MULTI_POSTED_PREFIX,
  sourceScheduleName,
} from '../src/jobs/discoveryRun';
import { enqueue, materializeSchedules, runDueJobs } from '../src/jobs/runner';
import { sanitizePosting } from '../src/lib/postingSanitize';
import {
  createSource,
  deleteSource,
  getSourceRow,
  listResults,
  updateSource,
} from '../src/repos/discovery';
import { countPendingFromCompany } from '../src/lib/deniedCompanies';
import { createCompany } from '../src/repos/companies';
import { createOpportunity, transitionOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 50, offset: 0 };

afterEach(() => resetSources());

const P1: NormalizedPosting = {
  company: 'Initech',
  title: 'Staff Platform Engineer',
  descriptionMd: '<p>Build the <b>platform</b>.</p><script>alert("x")</script>',
  postingUrl: 'https://boards.example.com/initech/1',
  location: 'Austin, TX',
  externalId: 'gh-1',
};
const P2: NormalizedPosting = {
  company: 'Initech',
  title: 'Product Manager',
  descriptionMd: 'Own the roadmap.',
  postingUrl: 'javascript:alert(1)',
  location: 'Remote',
  externalId: 'gh-2',
};

/** A fake adapter: yields `postings` with numbered cursors; `fail` throws after the first. */
function fakeSource(
  kind: DiscoverySource['kind'],
  state: { postings: NormalizedPosting[]; fail?: string | null; cursors?: unknown[] },
): DiscoverySource {
  return {
    kind,
    async *fetchPostings(_sctx, _config, cursor) {
      state.cursors?.push(cursor);
      let i = 0;
      for (const posting of state.postings) {
        i += 1;
        yield { posting, nextCursor: { page: i } };
        if (state.fail != null) throw new Error(state.fail);
      }
    },
  };
}

async function runSource(app: FastifyInstance, c: TestClient, sourceId: string): Promise<string> {
  const id = await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId }, { userId: c.userId });
  await app.jobs.drain();
  return id;
}

async function jobOf(app: FastifyInstance, id: string) {
  return (await app.db.select().from(jobs).where(eq(jobs.id, id)).get())!;
}

async function runsOf(app: FastifyInstance, sourceId: string) {
  return await app.db
    .select()
    .from(discoveryRuns)
    .where(eq(discoveryRuns.sourceId, sourceId))
    .all();
}

describe('sanitizePosting (Review Focus 1)', () => {
  it('strips scripts and markup, truncates an 80k description, and removes control chars', () => {
    const hostile = {
      company: 'Ini\u0000tech <img src=x onerror=alert(1)>',
      title: 'Staff\u0007 Engineer\u202e\u200f <script>alert(1)</script>',
      descriptionMd:
        '<script>steal(document.cookie)</script><style>p{}</style><h2>About</h2>' +
        '<p>Fish &amp; chips &lt;b&gt;bold&lt;/b&gt; &#x41;&#66;\u0000\u001b</p><ul><li>One</li>' +
        '<li>Two</li></ul><!-- hidden --><iframe src="https://evil.example"></iframe>' +
        'x'.repeat(80_000),
      postingUrl: 'javascript:alert(document.domain)',
      location: 'Austin\r\nTX',
      compNote: '<a href="https://x.example">$200k</a>',
      externalId: '42',
    } as NormalizedPosting;
    const clean = sanitizePosting(hostile);
    expect(clean.company).toBe('Initech');
    expect(clean.title).toBe('Staff Engineer');
    expect(clean.location).toBe('Austin TX');
    expect(clean.compNote).toBe('$200k');
    expect(clean.postingUrl).toBeNull();
    const d = clean.descriptionMd!;
    expect(d.length).toBe(50_000);
    expect(d).not.toMatch(/script|steal|style|iframe|hidden|<|>/i);
    expect(d).toMatch(/^About\n\nFish & chips bold AB\n\n- One\n- Two\nx/);
    const controls = [...d].filter((ch) => {
      const code = ch.charCodeAt(0);
      return (code < 0x20 && ch !== '\n' && ch !== '\t') || code === 0x7f;
    });
    expect(controls).toEqual([]);
    expect(NormalizedPostingSchema.safeParse(clean).success).toBe(true);
  });

  it('drops a postedAt outside the Date range and keeps one inside it', () => {
    const base = { company: 'A', title: 'B' };
    expect(sanitizePosting({ ...base, postedAt: 9e15 }).postedAt).toBeNull();
    expect(sanitizePosting({ ...base, postedAt: -9e15 }).postedAt).toBeNull();
    expect(sanitizePosting({ ...base, postedAt: 8.64e15 }).postedAt).toBe(8.64e15);
    expect(sanitizePosting({ ...base, postedAt: 1_760_000_000_000 }).postedAt).toBe(
      1_760_000_000_000,
    );
  });

  it('keeps http(s) links and drops data:, relative and credentialed ones', () => {
    const base = { company: 'A', title: 'B' };
    expect(sanitizePosting({ ...base, postingUrl: 'https://jobs.example.com/1' }).postingUrl).toBe(
      'https://jobs.example.com/1',
    );
    for (const bad of [
      'data:text/html,<script>alert(1)</script>',
      '/jobs/1',
      'https://user:pw@jobs.example.com/1',
      `https://jobs.example.com/${'a'.repeat(2100)}`,
    ]) {
      expect(sanitizePosting({ ...base, postingUrl: bad }).postingUrl, bad).toBeNull();
    }
  });

  it('stays fast on hostile markup', () => {
    const nasty = `${'<script>'.repeat(20_000)}${'< '.repeat(50_000)}<${' '.repeat(100_000)}`;
    const started = Date.now();
    sanitizePosting({ company: 'A', title: 'B', descriptionMd: nasty });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('discovery.run job', () => {
  it('inserts sanitized results, saves the cursor and records stats', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const state = { postings: [P1, P2], cursors: [] as unknown[] };
    registerSource(fakeSource('ats_greenhouse', state));
    const src = await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'initech' },
    });

    const jobId = await runSource(app, a, src.id);
    expect((await jobOf(app, jobId)).status).toBe('done');
    const results = (await listResults(app.db, ctx, { ...PAGE, sort: 'createdAt' })).items;
    expect(results).toHaveLength(2);
    const first = results.find((r) => r.posting.externalId === 'gh-1')!;
    expect(first.posting.descriptionMd).toBe('Build the platform.');
    expect(first.resolution).toBe('full');
    expect(first.dedupeKey).toBe('initech|platform engineer|austin tx');
    expect(results.find((r) => r.posting.externalId === 'gh-2')!.posting.postingUrl).toBeNull();

    const [run] = await runsOf(app, src.id);
    expect(run!.stats).toEqual({
      fetched: 2,
      inserted: 2,
      duplicates: 0,
      invalid: 0,
      suppressed: 0,
    });
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.error).toBeNull();
    const after = await getSourceRow(app.db, ctx, src.id);
    expect(after.status).toBe('ok');
    expect(after.lastRunAt).not.toBeNull();
    expect(after.config).toEqual({ org: 'initech', cursor: { page: 2 } });

    // The next run resumes from the saved cursor and counts the same postings as duplicates.
    await runSource(app, a, src.id);
    expect(state.cursors).toEqual([null, { page: 2 }]);
    expect((await runsOf(app, src.id)).map((r) => r.stats)).toContainEqual({
      fetched: 2,
      inserted: 0,
      duplicates: 2,
      invalid: 0,
      suppressed: 0,
    });
  });

  it("suppresses a posting from a company denied via the source's own companyId (issue #199)", async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const denied = await createCompany(app.db, ctx, { name: 'Initech', status: 'denied' });
    registerSource(fakeSource('ats_greenhouse', { postings: [P1, P2] }));
    const src = await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'initech' },
      companyId: denied.id,
    });

    await runSource(app, a, src.id);
    const pending = await listResults(app.db, ctx, { ...PAGE, disposition: 'pending' });
    expect(pending.items).toHaveLength(0);
    const dismissed = (await listResults(app.db, ctx, { ...PAGE, disposition: 'dismissed' })).items;
    expect(dismissed).toHaveLength(2);
    const [run] = await runsOf(app, src.id);
    expect(run!.stats).toEqual({
      fetched: 2,
      inserted: 0,
      duplicates: 0,
      invalid: 0,
      suppressed: 2,
    });
    const feedback = await app.db
      .select()
      .from(dismissalFeedback)
      .where(eq(dismissalFeedback.resultId, dismissed[0]!.id))
      .get();
    expect(feedback?.reason).toBe('denied_company');
    expect(feedback?.note).toBe('Initech');
  });

  it('suppresses a posting matched by fuzzy company name, for a source with no companyId of its own (issue #199)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, { name: 'Initech Corporation', status: 'denied' });
    registerSource(fakeSource('alert_email', { postings: [P1] }));
    const src = await createSource(app.db, ctx, { kind: 'alert_email', config: {} });

    await runSource(app, a, src.id);
    const pending = await listResults(app.db, ctx, { ...PAGE, disposition: 'pending' });
    expect(pending.items).toHaveLength(0);
    const dismissed = (await listResults(app.db, ctx, { ...PAGE, disposition: 'dismissed' })).items;
    expect(dismissed).toHaveLength(1);
  });

  it('does not suppress an unrelated company', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, { name: 'Oracle', status: 'denied' });
    registerSource(fakeSource('ats_greenhouse', { postings: [P1] }));
    const src = await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'initech' },
    });

    await runSource(app, a, src.id);
    const pending = await listResults(app.db, ctx, { ...PAGE, disposition: 'pending' });
    expect(pending.items).toHaveLength(1);
  });

  it('counts how many already-pending results match a company, for showing right after denying it (issue #199)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    // Two Initech postings land as pending (not yet denied); a third, unrelated company does
    // not count even though it is pending too.
    registerSource(fakeSource('ats_greenhouse', { postings: [P1, P2] }));
    const initech = await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'initech' },
    });
    registerSource(
      fakeSource('ats_lever', { postings: [{ ...P1, company: 'Globex', externalId: 'gl-1' }] }),
    );
    await createSource(app.db, ctx, { kind: 'ats_lever', config: { org: 'globex' } });
    await runSource(app, a, initech.id);
    const globexSrc = (await app.db.select().from(discoverySources).all()).find(
      (s) => s.kind === 'ats_lever',
    )!;
    await runSource(app, a, globexSrc.id);

    const company = await createCompany(app.db, ctx, { name: 'Initech', status: 'denied' });
    expect(await countPendingFromCompany(app.db, ctx, company)).toBe(2);
  });

  it('skips a posting that matches a live opportunity, but not a dismissed one', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createOpportunity(app.db, ctx, {
      companyName: 'Initech',
      title: 'Senior Staff Platform Engineer',
      location: 'Austin, TX',
      sourceKind: 'manual',
    });
    const dismissed = await createOpportunity(app.db, ctx, {
      companyName: 'Initech',
      title: 'Product Manager',
      location: 'Remote',
      sourceKind: 'manual',
    });
    await transitionOpportunity(app.db, ctx, dismissed.id, {
      to: 'dismissed',
      dismissedReason: 'other',
    });
    registerSource(fakeSource('ats_lever', { postings: [P1, P2] }));
    const src = await createSource(app.db, ctx, { kind: 'ats_lever', config: { org: 'initech' } });
    await runSource(app, a, src.id);
    const results = (await listResults(app.db, ctx, PAGE)).items;
    expect(results.map((r) => r.posting.title)).toEqual(['Product Manager']);
    expect((await runsOf(app, src.id))[0]!.stats).toMatchObject({ inserted: 1, duplicates: 1 });
  });

  it('never re-suggests a dismissed result', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    registerSource(fakeSource('ats_lever', { postings: [P1] }));
    const src = await createSource(app.db, ctx, { kind: 'ats_lever', config: { org: 'initech' } });
    await runSource(app, a, src.id);
    const [res] = (await listResults(app.db, ctx, PAGE)).items;
    await app.db
      .update(discoveryResults)
      .set({ disposition: 'dismissed' })
      .where(eq(discoveryResults.id, res!.id))
      .run();
    await runSource(app, a, src.id);
    expect((await listResults(app.db, ctx, PAGE)).total).toBe(1);
  });

  it('marks the later of two pending results from different sources as multi-posted (FR-O10)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    registerSource(fakeSource('ats_lever', { postings: [P1] }));
    registerSource(
      fakeSource('mcp', { postings: [{ ...P1, title: 'Sr. Staff Platform Engineer' }] }),
    );
    const lever = await createSource(app.db, ctx, {
      kind: 'ats_lever',
      config: { org: 'initech' },
    });
    const mcp = await createSource(app.db, ctx, {
      kind: 'mcp',
      config: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        tool: 'jobs',
        queryArgs: {},
        mapping: { company: 'company', title: 'title' },
        itemsPath: '',
      },
    });
    await runSource(app, a, lever.id);
    await runSource(app, a, mcp.id);
    const results = (await listResults(app.db, ctx, { ...PAGE, sort: 'createdAt' })).items;
    expect(results).toHaveLength(2);
    expect(results[0]!.aiRationale).toBeNull();
    expect(results[1]!.aiRationale).toBe(MULTI_POSTED_PREFIX);
    expect(results[1]!.sourceKind).toBe('mcp');
  });

  it('ignores a disabled or deleted source', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    registerSource(fakeSource('ats_lever', { postings: [P1] }));
    const src = await createSource(app.db, ctx, {
      kind: 'ats_lever',
      config: { org: 'initech' },
      enabled: false,
    });
    expect((await jobOf(app, await runSource(app, a, src.id))).status).toBe('done');
    await deleteSource(app.db, ctx, src.id);
    expect((await jobOf(app, await runSource(app, a, src.id))).status).toBe('done');
    expect((await listResults(app.db, ctx, PAGE)).total).toBe(0);
  });

  it('an adapter error marks the source error, retries with growing backoff, and success resets it (Review Focus 5)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const state: { postings: NormalizedPosting[]; fail: string | null } = {
      postings: [P1, P2],
      fail: `board unavailable ${'x'.repeat(400)}`,
    };
    registerSource(fakeSource('ats_ashby', state));
    const src = await createSource(app.db, ctx, { kind: 'ats_ashby', config: { org: 'initech' } });
    const jobId = await enqueue(
      app.db,
      DISCOVERY_RUN_KIND,
      { sourceId: src.id },
      { userId: a.userId },
    );
    const services = app.jobs.services;

    let now = Date.now();
    await runDueJobs(app.db, { now: () => now, services });
    let job = await jobOf(app, jobId);
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    const firstDelay = job.runAt - now;
    expect(firstDelay).toBeGreaterThanOrEqual(60_000);
    let source = await getSourceRow(app.db, ctx, src.id);
    expect(source.status).toBe('error');
    expect(source.statusDetail).toMatch(/^Error: board unavailable x+$/);
    expect(source.statusDetail!.length).toBe(300);
    const [failedRun] = await runsOf(app, src.id);
    expect(failedRun!.error).toMatch(/board unavailable/);
    expect(failedRun!.stats).toMatchObject({ fetched: 1, inserted: 1 });

    now = job.runAt;
    await runDueJobs(app.db, { now: () => now, services });
    job = await jobOf(app, jobId);
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(2);
    expect(job.runAt - now).toBeGreaterThan(firstDelay);

    state.fail = null;
    now = job.runAt;
    await runDueJobs(app.db, { now: () => now, services });
    expect((await jobOf(app, jobId)).status).toBe('done');
    source = await getSourceRow(app.db, ctx, src.id);
    expect(source.status).toBe('ok');
    expect(source.statusDetail).toBeNull();
    // The first posting was kept from the failed run; the retry added only the second.
    expect((await listResults(app.db, ctx, PAGE)).total).toBe(2);
  });

  it('an unregistered kind fails the run with a clear status', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const src = await createSource(app.db, ctx, { kind: 'alert_email', config: {} });
    const jobId = await runSource(app, a, src.id);
    expect((await jobOf(app, jobId)).lastError).toMatch(/no discovery source adapter/);
    expect(await getSourceRow(app.db, ctx, src.id)).toMatchObject({ status: 'error' });
  });
});

describe('source schedules', () => {
  async function scheduleRow(app: FastifyInstance, sourceId: string) {
    return await app.db
      .select()
      .from(settings)
      .where(eq(settings.key, `schedule:${sourceScheduleName(sourceId)}`))
      .get();
  }

  it('syncs a schedule row on create, update, disable and delete', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const src = await createSource(app.db, ctx, {
      kind: 'ats_lever',
      config: { org: 'initech' },
      scheduleCron: '0 7 * * *',
    });
    expect(sourceScheduleName(src.id)).toBe(`discovery.run:${src.id}`);
    expect(await scheduleRow(app, src.id)).toMatchObject({
      userId: a.userId,
      value: {
        cron: '0 7 * * *',
        enabled: true,
        kind: DISCOVERY_RUN_KIND,
        payload: { sourceId: src.id },
      },
    });
    await materializeSchedules(app.db);
    const pending = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, DISCOVERY_RUN_KIND), eq(jobs.status, 'pending')))
      .all();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ userId: a.userId, payload: { sourceId: src.id } });

    await updateSource(app.db, ctx, src.id, { scheduleCron: '30 6 * * 1' });
    expect((await scheduleRow(app, src.id))!.value).toMatchObject({ cron: '30 6 * * 1' });

    await updateSource(app.db, ctx, src.id, { enabled: false });
    expect(await scheduleRow(app, src.id)).toBeUndefined();
    // Disabling also drops the pending occurrence.
    expect(
      await app.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, DISCOVERY_RUN_KIND), eq(jobs.status, 'pending')))
        .all(),
    ).toHaveLength(0);

    await updateSource(app.db, ctx, src.id, { enabled: true });
    expect(await scheduleRow(app, src.id)).toBeDefined();
    await updateSource(app.db, ctx, src.id, { scheduleCron: null });
    expect(await scheduleRow(app, src.id)).toBeUndefined();
    await updateSource(app.db, ctx, src.id, { scheduleCron: '0 7 * * *' });
    await deleteSource(app.db, ctx, src.id);
    expect(await scheduleRow(app, src.id)).toBeUndefined();
  });

  it('creates no schedule for a source without a cron or created disabled', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const plain = await createSource(app.db, ctx, { kind: 'manual', config: {} });
    const off = await createSource(app.db, ctx, {
      kind: 'ats_lever',
      config: { org: 'initech' },
      scheduleCron: '0 7 * * *',
      enabled: false,
    });
    expect(await scheduleRow(app, plain.id)).toBeUndefined();
    expect(await scheduleRow(app, off.id)).toBeUndefined();
  });
});
