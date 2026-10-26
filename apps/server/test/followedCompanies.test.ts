// Followed-company polling (Task 15, FR-D5). Following a company makes sure its detected ATS
// board is a discovery source, enabled on the user's default cron; unfollowing disables it. The
// default cron is a per-user setting (PATCH /settings/discovery) and changing it moves every
// company source still on the old default to the new one.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { SourceContext } from '../src/adapters/discoverySource';
import { companies, jobs, settings } from '../src/db/schema';
import { ATS_DETECT_KIND, DEFAULT_DISCOVERY_CRON, detectAts } from '../src/jobs/atsDetect';
import { createCompany } from '../src/repos/companies';
import { createSource, listSources, sourceScheduleName } from '../src/repos/discovery';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 50, offset: 0 };

/** A company whose board detection already found lever:<org>. */
async function detected(app: FastifyInstance, c: TestClient, name: string, org: string) {
  const company = await createCompany(app.db, ctxOf(c), { name });
  await app.db
    .update(companies)
    .set({ atsKind: 'ats_lever', atsRef: org, atsVerifiedAt: Date.now() })
    .where(eq(companies.id, company.id))
    .run();
  return company;
}

const patch = (c: TestClient, id: string, payload: Record<string, unknown>) =>
  c.request({ method: 'PATCH', url: `/api/v1/companies/${id}`, payload });

async function schedule(app: FastifyInstance, sourceId: string) {
  return await app.db
    .select()
    .from(settings)
    .where(eq(settings.key, `schedule:${sourceScheduleName(sourceId)}`))
    .get();
}

const sources = async (app: FastifyInstance, c: TestClient) =>
  (await listSources(app.db, ctxOf(c), PAGE)).items;

describe('following a company', () => {
  it("creates the detected board's source, enabled on the user's default cron", async () => {
    const { app, a } = await boot();
    const set = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/discovery',
      payload: { cron: '30 6 * * 1-5' },
    });
    expect(set.statusCode).toBe(200);
    const company = await detected(app, a, 'Initech', 'initech');
    expect(await sources(app, a)).toEqual([]);

    const res = await patch(a, company.id, { status: 'followed' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'followed',
      atsKind: 'ats_lever',
      atsRef: 'initech',
    });

    const [src] = await sources(app, a);
    expect(src).toMatchObject({
      kind: 'ats_lever',
      config: { org: 'initech' },
      enabled: true,
      scheduleCron: '30 6 * * 1-5',
      companyId: company.id,
    });
    expect((await schedule(app, src!.id))?.value).toMatchObject({
      cron: '30 6 * * 1-5',
      enabled: true,
    });
    expect((await schedule(app, src!.id))?.userId).toBe(a.userId);

    // Following again changes nothing.
    await patch(a, company.id, { status: 'followed' });
    expect(await sources(app, a)).toHaveLength(1);
  });

  it('re-enables an existing disabled source and gives an unscheduled one the default cron', async () => {
    const { app, a } = await boot();
    const company = await detected(app, a, 'Initech', 'initech');
    const src = await createSource(app.db, ctxOf(a), {
      kind: 'ats_lever',
      config: { org: 'initech' },
      enabled: false,
      companyId: company.id,
    });
    await patch(a, company.id, { status: 'followed' });
    const [after] = await sources(app, a);
    expect(after).toMatchObject({
      id: src.id,
      enabled: true,
      scheduleCron: DEFAULT_DISCOVERY_CRON,
    });
    expect((await schedule(app, src.id))?.value).toMatchObject({ cron: DEFAULT_DISCOVERY_CRON });
  });

  it('unfollowing disables the source and drops its schedule; following again restores it', async () => {
    const { app, a } = await boot();
    const company = await detected(app, a, 'Initech', 'initech');
    await patch(a, company.id, { status: 'followed' });
    const [src] = await sources(app, a);
    expect(await schedule(app, src!.id)).toBeDefined();

    const res = await patch(a, company.id, { status: 'none' });
    expect(res.statusCode).toBe(200);
    expect((await sources(app, a))[0]).toMatchObject({ id: src!.id, enabled: false });
    expect(await schedule(app, src!.id)).toBeUndefined();

    await patch(a, company.id, { status: 'followed' });
    expect((await sources(app, a))[0]).toMatchObject({ id: src!.id, enabled: true });
    expect(await schedule(app, src!.id)).toBeDefined();
  });

  it('following an undetected company queues detection; creating it followed does too', async () => {
    const { app, a } = await boot();
    const plain = await createCompany(app.db, ctxOf(a), { name: 'Initech' });
    await patch(a, plain.id, { status: 'followed' });
    const created = await a.request({
      method: 'POST',
      url: '/api/v1/companies',
      payload: { name: 'Globex', status: 'followed' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ atsDetectPending: true });
    const queued = await app.db
      .select({ payload: jobs.payload, userId: jobs.userId })
      .from(jobs)
      .where(eq(jobs.kind, ATS_DETECT_KIND))
      .all();
    expect(queued.map((j) => (j.payload as { companyId: string }).companyId).sort()).toEqual(
      [plain.id, created.json().id].sort(),
    );
    expect(queued.every((j) => j.userId === a.userId)).toBe(true);
    expect(await sources(app, a)).toEqual([]);
  });

  it('detection registers the board disabled for a company that is not followed, and following enables it', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const company = await createCompany(app.db, ctx, { name: 'Initech' });
    const fetch = (async (url: string) => ({
      status: url === 'https://api.lever.co/v0/postings/initech?mode=json&limit=1' ? 200 : 404,
      headers: new Headers(),
      // A board verifies only while it is serving a posting (atsDetect ATS_PROBES).
      body: Buffer.from(url.includes('lever') ? '[{"id":"a1","text":"Staff Engineer"}]' : '{}'),
    })) as unknown as SourceContext['fetch'];
    const log = { warn: () => undefined } as unknown as SourceContext['log'];
    expect(await detectAts(app.db, ctx, company.id, { fetch, log })).toMatchObject({
      status: 'found',
      kind: 'ats_lever',
    });
    const [src] = await sources(app, a);
    expect(src).toMatchObject({ enabled: false, scheduleCron: DEFAULT_DISCOVERY_CRON });
    expect(await schedule(app, src!.id)).toBeUndefined();

    await patch(a, company.id, { status: 'followed' });
    expect((await sources(app, a))[0]).toMatchObject({ id: src!.id, enabled: true });
    // Re-verification of a followed company keeps its source enabled.
    await detectAts(app.db, ctx, company.id, { fetch, log });
    expect(await sources(app, a)).toHaveLength(1);
    expect((await sources(app, a))[0]!.enabled).toBe(true);
  });

  it('accepting a suggestion follows it through the same path', async () => {
    const { app, a } = await boot();
    const company = await detected(app, a, 'Initech', 'initech');
    await app.db
      .update(companies)
      .set({ status: 'suggested' })
      .where(eq(companies.id, company.id))
      .run();
    const res = await a.request({ method: 'POST', url: `/api/v1/companies/${company.id}/accept` });
    expect(res.statusCode).toBe(200);
    expect((await sources(app, a))[0]).toMatchObject({ enabled: true, companyId: company.id });
  });

  it('GET /companies filters by status and carries the ATS fields', async () => {
    const { app, a } = await boot();
    const company = await detected(app, a, 'Initech', 'initech');
    await createCompany(app.db, ctxOf(a), { name: 'Globex' });
    await patch(a, company.id, { status: 'followed' });
    const res = await a.request({ method: 'GET', url: '/api/v1/companies?status=followed' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: company.id,
      status: 'followed',
      atsKind: 'ats_lever',
      atsRef: 'initech',
      atsDetectPending: false,
      needsCareersUrl: false,
    });
    expect(body.items[0].atsVerifiedAt).toBeGreaterThan(0);
  });

  let isoApp: FastifyInstance | undefined;
  assertIsolated({
    name: 'following a company',
    setup: (app) => {
      isoApp = app;
    },
    create: async (c) => (await detected(isoApp!, c, `Initech ${c.userId}`, 'initech')).id,
    read: (c, id) => patch(c, id, { status: 'followed' }),
  });

  it("another user's follow touches only their own sources", async () => {
    const { app, a, b } = await boot();
    const company = await detected(app, a, 'Initech', 'initech');
    expect((await patch(b, company.id, { status: 'followed' })).statusCode).toBe(404);
    expect(await sources(app, a)).toEqual([]);
    expect(await sources(app, b)).toEqual([]);
  });
});

describe('discovery default cron setting', () => {
  it('defaults to 0 7 * * *, per user', async () => {
    const { a } = await boot();
    const res = await a.request({ method: 'GET', url: '/api/v1/settings/discovery' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cron: '0 7 * * *' });
  });

  it.each([
    'not a cron',
    '61 * * * *',
    '* * * * * * * *',
    'x'.repeat(101),
    '',
    // The granularity floor: every minute, half-hourly, and a six-field (seconds) expression.
    '* * * * *',
    '*/30 * * * *',
    '0 0 7 * * *',
  ])('rejects %j', async (cron) => {
    const { a } = await boot();
    const res = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/discovery',
      payload: { cron },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
    const get = await a.request({ method: 'GET', url: '/api/v1/settings/discovery' });
    expect(get.json()).toEqual({ cron: '0 7 * * *' });
  });

  it('accepts an hourly default and explains a sub-hour one', async () => {
    const { a } = await boot();
    const tooOften = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/discovery',
      payload: { cron: '* * * * *' },
    });
    expect(tooOften.statusCode).toBe(400);
    expect(tooOften.json().error.issues).toEqual([
      expect.objectContaining({ message: 'must run at most once an hour' }),
    ]);
    const hourly = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/discovery',
      payload: { cron: '0 * * * *' },
    });
    expect(hourly.statusCode).toBe(200);
    expect(hourly.json()).toEqual({ cron: '0 * * * *' });
  });

  it("re-syncs the user's company sources on the old default; custom crons and other users stay", async () => {
    const { app, a, b } = await boot();
    const followed = await detected(app, a, 'Initech', 'initech');
    await patch(a, followed.id, { status: 'followed' });
    const custom = await detected(app, a, 'Globex', 'globex');
    await patch(a, custom.id, { status: 'followed' });
    const customSrc = (await sources(app, a)).find((s) => s.companyId === custom.id)!;
    await a.request({
      method: 'PATCH',
      url: `/api/v1/discovery/sources/${customSrc.id}`,
      payload: { scheduleCron: '0 12 * * *' },
    });
    const unfollowed = await detected(app, a, 'Hooli', 'hooli');
    await patch(a, unfollowed.id, { status: 'followed' });
    await patch(a, unfollowed.id, { status: 'none' });
    const bCompany = await detected(app, b, 'Initech', 'initech');
    await patch(b, bCompany.id, { status: 'followed' });

    const res = await a.request({
      method: 'PATCH',
      url: '/api/v1/settings/discovery',
      payload: { cron: '15 9 * * 1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cron: '15 9 * * 1' });
    expect((await a.request({ method: 'GET', url: '/api/v1/settings/discovery' })).json()).toEqual({
      cron: '15 9 * * 1',
    });

    const byCompany = new Map((await sources(app, a)).map((s) => [s.companyId, s]));
    const followedSrc = byCompany.get(followed.id)!;
    expect(followedSrc.scheduleCron).toBe('15 9 * * 1');
    expect((await schedule(app, followedSrc.id))?.value).toMatchObject({ cron: '15 9 * * 1' });
    expect(byCompany.get(custom.id)!.scheduleCron).toBe('0 12 * * *');
    expect((await schedule(app, customSrc.id))?.value).toMatchObject({ cron: '0 12 * * *' });
    // A disabled source moves with the default (so a later follow uses it) but stays off.
    const hooliSrc = byCompany.get(unfollowed.id)!;
    expect(hooliSrc).toMatchObject({ enabled: false, scheduleCron: '15 9 * * 1' });
    expect(await schedule(app, hooliSrc.id)).toBeUndefined();

    // User b keeps the default, on their setting and their source.
    expect((await b.request({ method: 'GET', url: '/api/v1/settings/discovery' })).json()).toEqual({
      cron: DEFAULT_DISCOVERY_CRON,
    });
    expect((await sources(app, b))[0]!.scheduleCron).toBe(DEFAULT_DISCOVERY_CRON);
    const row = await app.db
      .select()
      .from(settings)
      .where(and(eq(settings.key, `discovery_default_cron:${a.userId}`)))
      .get();
    expect(row).toMatchObject({ userId: a.userId, value: '15 9 * * 1' });
  });

  it('requires a session and a CSRF token', async () => {
    const { app, a } = await boot();
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/settings/discovery' })).statusCode,
    ).toBe(401);
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings/discovery',
      payload: { cron: '0 8 * * *' },
      cookies: { opportun_session: a.session },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});
