import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobs } from '../src/db/schema';
import { COMPANY_DOMAIN_RESOLVE_KIND } from '../src/jobs/companyDomainResolve';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';
import { queryAll, queryOne } from './db';

const boot = useApi();

afterEach(() => {
  vi.useRealTimers();
});

const OPP = {
  companyName: 'Initech',
  title: 'Principal PM, Widget Builder',
  descriptionMd: 'Own the widget builder roadmap.',
  postingUrl: 'https://jobs.example.com/123',
  sourceKind: 'manual',
  location: 'Remote, US',
  remote: true,
  compNote: '$250k base',
  priority: 1,
};

function createOpp(c: TestClient, extra: Record<string, unknown> = {}, query = '') {
  return c.request({
    method: 'POST',
    url: `/api/v1/opportunities${query}`,
    payload: { ...OPP, ...extra },
  });
}

function move(c: TestClient, id: string, body: Record<string, unknown>) {
  return c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/stage`, payload: body });
}

async function historyCount(app: FastifyInstance, opportunityId: string): Promise<number> {
  const row = (await queryOne(
    app,
    'SELECT count(*) AS n FROM stage_history WHERE opportunity_id = ?',
    opportunityId,
  )) as { n: number };
  return row.n;
}

describe('companies', () => {
  it('creates, lists with a name filter, patches and fetches', async () => {
    const { a } = await boot();
    const created = await a.request({
      method: 'POST',
      url: '/api/v1/companies',
      payload: { name: 'Initech', domain: 'initech.example', status: 'followed' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Initech', status: 'followed', userId: a.userId });
    await a.request({ method: 'POST', url: '/api/v1/companies', payload: { name: 'Acme' } });

    const list = await a.request({ method: 'GET', url: '/api/v1/companies?q=ini' });
    expect(list.json()).toMatchObject({ total: 1, items: [{ name: 'Initech' }] });
    const sorted = await a.request({ method: 'GET', url: '/api/v1/companies?sort=name' });
    expect(sorted.json().items.map((c: { name: string }) => c.name)).toEqual(['Acme', 'Initech']);

    const id = created.json().id;
    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/companies/${id}`,
      payload: { status: 'denied', notes: 'Not now' },
    });
    expect(patched.json()).toMatchObject({
      id,
      name: 'Initech',
      status: 'denied',
      notes: 'Not now',
    });
    const got = await a.request({ method: 'GET', url: `/api/v1/companies/${id}` });
    expect(got.json()).toEqual(patched.json());
  });

  it('returns 409 with the existing id for a case-insensitive duplicate name', async () => {
    const { a } = await boot();
    const first = await a.request({
      method: 'POST',
      url: '/api/v1/companies',
      payload: { name: 'Initech' },
    });
    const dup = await a.request({
      method: 'POST',
      url: '/api/v1/companies',
      payload: { name: '  initech ' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: { code: 'duplicate', existingId: first.json().id } });
  });

  it('rejects a non-http careers url', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/companies',
      payload: { name: 'X', careersUrl: 'javascript:alert(1)' },
    });
    expect(res.statusCode).toBe(400);
  });

  assertIsolated({
    name: 'companies (GET)',
    create: async (c) =>
      (
        await c.request({ method: 'POST', url: '/api/v1/companies', payload: { name: 'Co' } })
      ).json().id,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/companies/${id}` }),
  });
  assertIsolated({
    name: 'companies (PATCH)',
    create: async (c) =>
      (
        await c.request({ method: 'POST', url: '/api/v1/companies', payload: { name: 'Co' } })
      ).json().id,
    read: (c, id) =>
      c.request({ method: 'PATCH', url: `/api/v1/companies/${id}`, payload: { notes: 'x' } }),
  });
});

describe('opportunities', () => {
  it('creates (find-or-create company, stage discovered, initial history) and fetches', async () => {
    const { app, a } = await boot();
    const res = await createOpp(a);
    expect(res.statusCode).toBe(201);
    const opp = res.json();
    expect(opp).toMatchObject({
      title: OPP.title,
      descriptionMd: OPP.descriptionMd,
      postingUrl: OPP.postingUrl,
      sourceKind: 'manual',
      location: 'Remote, US',
      remote: true,
      priority: 1,
      stage: 'discovered',
      companyName: 'Initech',
      userId: a.userId,
    });
    expect(await historyCount(app, opp.id)).toBe(1);

    const got = await a.request({ method: 'GET', url: `/api/v1/opportunities/${opp.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual(opp);

    // The same company name (any case) reuses the company row.
    const second = await createOpp(a, { companyName: 'initech', title: 'Staff Engineer' });
    expect(second.json().companyId).toBe(opp.companyId);
    const companies = await a.request({ method: 'GET', url: '/api/v1/companies' });
    expect(companies.json().total).toBe(1);
  });

  it('defaults priority to 2 and rejects invalid bodies', async () => {
    const { a } = await boot();
    const minimal = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Acme', title: 'PM', sourceKind: 'import' },
    });
    expect(minimal.statusCode).toBe(201);
    expect(minimal.json()).toMatchObject({ priority: 2, descriptionMd: null, remote: null });

    expect((await createOpp(a, { sourceKind: 'telepathy' })).statusCode).toBe(400);
    expect((await createOpp(a, { title: '' })).statusCode).toBe(400);
    expect((await createOpp(a, { priority: 4 })).statusCode).toBe(400);
    expect((await createOpp(a, { postingUrl: 'javascript:alert(1)' })).statusCode).toBe(400);
  });

  it('rejects another user role target id with 404', async () => {
    const { a, b } = await boot();
    const rt = await b.request({
      method: 'POST',
      url: '/api/v1/role-targets',
      payload: { name: 'B target', titleFamily: 'PM' },
    });
    const res = await createOpp(a, { roleTargetId: rt.json().id });
    expect(res.statusCode).toBe(404);
    const own = await a.request({
      method: 'POST',
      url: '/api/v1/role-targets',
      payload: { name: 'A target', titleFamily: 'PM' },
    });
    const ok = await createOpp(a, { roleTargetId: own.json().id });
    expect(ok.json().roleTargetId).toBe(own.json().id);
  });

  it('advances a stage, returns the updated entity and writes history', async () => {
    const { app, a } = await boot();
    const opp = (await createOpp(a)).json();
    const res = await move(a, opp.id, { to: 'applied', note: 'via referral' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: opp.id, stage: 'applied', companyName: 'Initech' });
    expect(res.json().updatedAt).toBeGreaterThanOrEqual(opp.updatedAt);
    expect(await historyCount(app, opp.id)).toBe(2);
    const last = await queryOne(
      app,
      'SELECT from_stage, to_stage, note, user_id FROM stage_history WHERE opportunity_id = ? ORDER BY at DESC, id DESC LIMIT 1',
      opp.id,
    );
    expect(last).toEqual({
      from_stage: 'discovered',
      to_stage: 'applied',
      note: 'via referral',
      user_id: a.userId,
    });
  });

  it('Review Focus 1: closed -> applied without reopen returns 422 and writes no history', async () => {
    const { app, a } = await boot();
    const opp = (await createOpp(a)).json();
    expect((await move(a, opp.id, { to: 'applied' })).statusCode).toBe(200);
    const closed = await move(a, opp.id, { to: 'closed', closedReason: 'rejected' });
    expect(closed.json()).toMatchObject({ stage: 'closed', closedReason: 'rejected' });

    const before = await historyCount(app, opp.id);
    const res = await move(a, opp.id, { to: 'applied' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'invalid_transition',
      from: 'closed',
      to: 'applied',
    });
    expect(await historyCount(app, opp.id)).toBe(before);
    const got = await a.request({ method: 'GET', url: `/api/v1/opportunities/${opp.id}` });
    expect(got.json()).toMatchObject({ stage: 'closed', closedReason: 'rejected' });

    // An explicit reopen is the only way out of a terminal stage.
    const reopened = await move(a, opp.id, { to: 'applied', reopen: true, note: 'they came back' });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({ stage: 'applied', closedReason: null });
    expect(await historyCount(app, opp.id)).toBe(before + 1);
    const note = await queryOne(
      app,
      'SELECT note FROM stage_history WHERE opportunity_id = ? ORDER BY at DESC, id DESC',
      opp.id,
    );
    expect(note).toEqual({ note: 'reopened: they came back' });
  });

  it('rejects state machine violations with 422 and writes nothing', async () => {
    const { app, a } = await boot();
    const opp = (await createOpp(a)).json();
    await move(a, opp.id, { to: 'offer' });
    const before = await historyCount(app, opp.id);
    // Backward more than one step.
    const back = await move(a, opp.id, { to: 'interested' });
    expect(back.statusCode).toBe(422);
    expect(back.json().error).toMatchObject({ from: 'offer', to: 'interested' });
    // Self transition, and closed without a reason.
    expect((await move(a, opp.id, { to: 'offer' })).statusCode).toBe(422);
    expect((await move(a, opp.id, { to: 'closed' })).statusCode).toBe(422);
    // A malformed body is a 400 before anything runs.
    expect((await move(a, opp.id, { to: 'closed', closedReason: 'bored' })).statusCode).toBe(400);
    expect(await historyCount(app, opp.id)).toBe(before);
    const got = await a.request({ method: 'GET', url: `/api/v1/opportunities/${opp.id}` });
    expect(got.json().stage).toBe('offer');
    // One step back is allowed; reopen on a non-terminal move is ignored.
    expect((await move(a, opp.id, { to: 'in_process', reopen: true })).statusCode).toBe(200);
  });

  it('dismisses from discovered with a reason and persists dismissedReason', async () => {
    const { app, a } = await boot();
    const opp = (await createOpp(a)).json();
    const res = await move(a, opp.id, {
      to: 'dismissed',
      dismissedReason: 'seniority',
      note: 'too junior',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stage: 'dismissed', dismissedReason: 'seniority' });
    const got = await a.request({ method: 'GET', url: `/api/v1/opportunities/${opp.id}` });
    expect(got.json().dismissedReason).toBe('seniority');
    const feedback = await queryAll(
      app,
      'SELECT kind, reason, note, user_id FROM dismissal_feedback WHERE opportunity_id = ?',
      opp.id,
    );
    expect(feedback).toEqual([
      { kind: 'dismissal', reason: 'seniority', note: 'too junior', user_id: a.userId },
    ]);
  });

  it('returns 409 duplicate with the existing id, then 201 with ?force=true', async () => {
    const { app, a } = await boot();
    const first = (await createOpp(a)).json();
    // Same company, title (seniority prefix stripped) and location, different case.
    const dup = await createOpp(a, {
      companyName: 'INITECH',
      title: 'Senior Principal PM, Widget Builder',
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: { code: 'duplicate', existingId: first.id } });

    const forced = await createOpp(a, {}, '?force=true');
    expect(forced.statusCode).toBe(201);
    expect(forced.json().id).not.toBe(first.id);
    const keys = (await queryAll(
      app,
      'SELECT id, dedupe_key FROM opportunities WHERE user_id = ? ORDER BY id',
      a.userId,
    )) as { id: string; dedupe_key: string | null }[];
    expect(keys.find((k) => k.id === forced.json().id)?.dedupe_key).toBeNull();
    expect(keys.find((k) => k.id === first.id)?.dedupe_key).toBe(
      'initech|pm widget builder|remote us',
    );
    // force=false is the same as no force.
    expect((await createOpp(a, {}, '?force=false')).statusCode).toBe(409);
  });

  it('records which opportunity a forced create overrides, visible from both sides (#9)', async () => {
    const { a } = await boot();
    const first = (await createOpp(a)).json();
    const forced = (
      await createOpp(
        a,
        { companyName: 'INITECH', title: 'Senior Principal PM, Widget Builder' },
        '?force=true',
      )
    ).json();
    expect(forced.possibleDuplicates).toEqual([first.id]);

    const firstAfter = await a.request({ method: 'GET', url: `/api/v1/opportunities/${first.id}` });
    expect(firstAfter.json().possibleDuplicates).toEqual([forced.id]);

    const list = await a.request({ method: 'GET', url: '/api/v1/opportunities' });
    const byId = Object.fromEntries(
      list.json().items.map((o: { id: string; possibleDuplicates: string[] }) => [o.id, o]),
    );
    expect(byId[first.id].possibleDuplicates).toEqual([forced.id]);
    expect(byId[forced.id].possibleDuplicates).toEqual([first.id]);
  });

  it('clears the possible-duplicate pointer on both sides once the referenced row is deleted', async () => {
    const { a } = await boot();
    const first = (await createOpp(a)).json();
    const forced = (await createOpp(a, {}, '?force=true')).json();
    expect(forced.possibleDuplicates).toEqual([first.id]);

    const del = await a.request({ method: 'DELETE', url: `/api/v1/opportunities/${first.id}` });
    expect(del.statusCode).toBe(204);

    const forcedAfter = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${forced.id}`,
    });
    expect(forcedAfter.json().possibleDuplicates).toEqual([]);
  });

  it('dismisses a possible-duplicate pairing, persisted rather than client-side only', async () => {
    const { a } = await boot();
    const first = (await createOpp(a)).json();
    const forced = (await createOpp(a, {}, '?force=true')).json();

    const dismissed = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${forced.id}/dismiss-duplicate`,
      payload: { otherId: first.id },
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(dismissed.json().possibleDuplicates).toEqual([]);

    // Persisted: a fresh read of either side still shows it cleared.
    const firstAfter = await a.request({ method: 'GET', url: `/api/v1/opportunities/${first.id}` });
    expect(firstAfter.json().possibleDuplicates).toEqual([]);
    const forcedAfter = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${forced.id}`,
    });
    expect(forcedAfter.json().possibleDuplicates).toEqual([]);
  });

  it('merging the referenced opportunity away clears the pointer via the FK, not a special case', async () => {
    const { a } = await boot();
    const first = (await createOpp(a)).json();
    const forced = (await createOpp(a, {}, '?force=true')).json();
    expect(forced.possibleDuplicates).toEqual([first.id]);

    // Keep the forced row; merge away the one it names as its possible duplicate.
    const merged = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${forced.id}/merge`,
      payload: { otherId: first.id },
    });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json().possibleDuplicates).toEqual([]);
  });

  it('dismiss-duplicate 404s for an opportunity outside the pairing, or another user data', async () => {
    const { a, b } = await boot();
    await createOpp(a); // the original: forced below pairs against it, not against unrelated.
    const forced = (await createOpp(a, {}, '?force=true')).json();
    const unrelated = (await createOpp(a, { companyName: 'Acme', title: 'Staff Engineer' })).json();
    const bOpp = (await createOpp(b)).json();

    // otherId that is a real opportunity, just not paired with :id, is still a 404.
    const notPaired = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${forced.id}/dismiss-duplicate`,
      payload: { otherId: unrelated.id },
    });
    expect(notPaired.statusCode).toBe(404);

    const otherUsers = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${forced.id}/dismiss-duplicate`,
      payload: { otherId: bOpp.id },
    });
    expect(otherUsers.statusCode).toBe(404);
  });

  it('flags a confident near-miss on create with no force needed (#94)', async () => {
    const { a, app } = await boot();
    const first = (
      await createOpp(a, { companyName: 'Acme Robotics', title: 'Senior Product Manager' })
    ).json();
    // A corporate-suffix variant of the same company, same title: dedupeKey's own normalizer
    // does not strip "Inc.", so this does not 409 the way an exact-key force-create would.
    const second = await createOpp(a, {
      companyName: 'Acme Robotics, Inc.',
      title: 'Senior Product Manager',
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().possibleDuplicates).toEqual([first.id]);

    const firstAfter = await a.request({ method: 'GET', url: `/api/v1/opportunities/${first.id}` });
    expect(firstAfter.json().possibleDuplicates).toEqual([second.json().id]);

    const [row] = (await queryAll(
      app,
      'SELECT decision, decided_by FROM opportunity_dedupe_candidates WHERE user_id = ?',
      a.userId,
    )) as { decision: string; decided_by: string }[];
    expect(row).toEqual({ decision: 'confirmed', decided_by: 'heuristic' });
  });

  it('queues a mid-confidence near-miss as a pending candidate, not shown to the user (#94)', async () => {
    const { a, app } = await boot();
    await createOpp(a, { companyName: 'Acme Robotics', title: 'Senior Product Manager' });
    // Shares 2 of 3 title tokens ("product", "manager") with the first at the same company
    // after suffix stripping: above TITLE_MATCH_THRESHOLD (0.6), below the confident write
    // threshold, so this is a guess, not a known fact.
    const second = await createOpp(a, {
      companyName: 'Acme Robotics, Inc.',
      title: 'Product Manager II',
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().possibleDuplicates).toEqual([]);

    const [row] = (await queryAll(
      app,
      'SELECT decision, decided_by, score FROM opportunity_dedupe_candidates WHERE user_id = ?',
      a.userId,
    )) as { decision: string; decided_by: string | null; score: number }[];
    expect(row).toEqual({ decision: 'pending', decided_by: null, score: expect.closeTo(2 / 3, 5) });
  });

  it('records nothing for a same-company pair whose titles do not overlap enough (#94)', async () => {
    const { a, app } = await boot();
    await createOpp(a, { companyName: 'Acme Robotics', title: 'Senior Product Manager' });
    const second = await createOpp(a, {
      companyName: 'Acme Robotics, Inc.',
      title: 'Backend Software Engineer',
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().possibleDuplicates).toEqual([]);
    const rows = await queryAll(
      app,
      'SELECT id FROM opportunity_dedupe_candidates WHERE user_id = ?',
      a.userId,
    );
    expect(rows).toEqual([]);
  });

  it('never matches across genuinely different companies, however similar the title', async () => {
    const { a, app } = await boot();
    await createOpp(a, { companyName: 'Acme Robotics', title: 'Senior Product Manager' });
    const second = await createOpp(a, {
      companyName: 'Acme Systems',
      title: 'Senior Product Manager',
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().possibleDuplicates).toEqual([]);
    const rows = await queryAll(
      app,
      'SELECT id FROM opportunity_dedupe_candidates WHERE user_id = ?',
      a.userId,
    );
    expect(rows).toEqual([]);
  });

  it('excludes a dismissed-stage opportunity from the candidate pool', async () => {
    const { a, app } = await boot();
    const first = (
      await createOpp(a, { companyName: 'Acme Robotics', title: 'Senior Product Manager' })
    ).json();
    await move(a, first.id, { to: 'dismissed' });
    const second = await createOpp(a, {
      companyName: 'Acme Robotics, Inc.',
      title: 'Senior Product Manager',
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().possibleDuplicates).toEqual([]);
    const rows = await queryAll(
      app,
      'SELECT id FROM opportunity_dedupe_candidates WHERE user_id = ?',
      a.userId,
    );
    expect(rows).toEqual([]);
  });

  it('a dismissal stays rejected across a later edit that would otherwise re-propose it (#94)', async () => {
    const { a, app } = await boot();
    const first = (
      await createOpp(a, { companyName: 'Acme Robotics', title: 'Senior Product Manager' })
    ).json();
    const second = (
      await createOpp(a, {
        companyName: 'Acme Robotics, Inc.',
        title: 'Senior Product Manager',
      })
    ).json();
    expect(second.possibleDuplicates).toEqual([first.id]);

    const dismissed = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${second.id}/dismiss-duplicate`,
      payload: { otherId: first.id },
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(dismissed.json().possibleDuplicates).toEqual([]);

    // An edit that re-touches title re-runs the heuristic; the pair must stay rejected rather
    // than being re-flagged, which is exactly what #102's plain null-out could not guarantee.
    const edited = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${second.id}`,
      payload: { title: 'Senior Product Manager' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().possibleDuplicates).toEqual([]);

    const [row] = (await queryAll(
      app,
      'SELECT decision, decided_by FROM opportunity_dedupe_candidates WHERE user_id = ?',
      a.userId,
    )) as { decision: string; decided_by: string }[];
    expect(row).toEqual({ decision: 'rejected', decided_by: 'user' });
  });

  it('allows re-creating a dismissed opportunity, which takes over the dedupe key', async () => {
    const { a } = await boot();
    const first = (await createOpp(a)).json();
    await move(a, first.id, { to: 'dismissed' });
    // The dismissed row is not a duplicate.
    const again = await createOpp(a);
    expect(again.statusCode).toBe(201);
    // The live row now owns the key, so a further copy is a duplicate of it.
    const third = await createOpp(a);
    expect(third.statusCode).toBe(409);
    expect(third.json().error.existingId).toBe(again.json().id);
  });

  it('does not treat another user opportunity as a duplicate', async () => {
    const { a, b } = await boot();
    await createOpp(a);
    expect((await createOpp(b)).statusCode).toBe(201);
  });

  it('lists with stage, companyId and q filters, sort and paging', async () => {
    const { a } = await boot();
    // The default sort is -updatedAt with the id as tie-break. Writes that land in the same
    // millisecond (common on a fast machine) tie, and the newest UUIDv7 then sorts first, so
    // the clock is pinned (only Date is faked) and stepped explicitly between writes.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const tick = () => vi.setSystemTime(Date.now() + 1000);
    const one = (await createOpp(a)).json();
    tick();
    const two = (await createOpp(a, { companyName: 'Acme', title: 'Staff Engineer' })).json();
    tick();
    await createOpp(a, { companyName: 'Acme', title: 'Data Scientist', location: 'NYC' });
    tick();
    await move(a, two.id, { to: 'applied' });

    const all = await a.request({ method: 'GET', url: '/api/v1/opportunities' });
    expect(all.json().total).toBe(3);
    // Default sort is most recently updated first.
    expect(all.json().items[0].id).toBe(two.id);

    const applied = await a.request({ method: 'GET', url: '/api/v1/opportunities?stage=applied' });
    expect(applied.json()).toMatchObject({ total: 1, items: [{ id: two.id }] });

    const multi = await a.request({
      method: 'GET',
      url: '/api/v1/opportunities?stage=applied,discovered',
    });
    expect(multi.json().total).toBe(3);

    const byCompany = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities?companyId=${one.companyId}`,
    });
    expect(byCompany.json()).toMatchObject({ total: 1, items: [{ id: one.id }] });

    const q = await a.request({ method: 'GET', url: '/api/v1/opportunities?q=acme' });
    expect(q.json().total).toBe(2);
    const q2 = await a.request({ method: 'GET', url: '/api/v1/opportunities?q=widget%20builder' });
    expect(q2.json()).toMatchObject({ total: 1, items: [{ id: one.id }] });
    // LIKE wildcards in q are literal.
    const wild = await a.request({ method: 'GET', url: '/api/v1/opportunities?q=%25' });
    expect(wild.json().total).toBe(0);

    const sorted = await a.request({
      method: 'GET',
      url: '/api/v1/opportunities?sort=title&limit=2&offset=1',
    });
    expect(sorted.json().total).toBe(3);
    expect(sorted.json().items.map((o: { title: string }) => o.title)).toEqual([
      'Principal PM, Widget Builder',
      'Staff Engineer',
    ]);
    const byCompanyName = await a.request({
      method: 'GET',
      url: '/api/v1/opportunities?sort=-companyName&limit=1',
    });
    expect(byCompanyName.json().items[0].companyName).toBe('Initech');

    expect(
      (await a.request({ method: 'GET', url: '/api/v1/opportunities?stage=nope' })).statusCode,
    ).toBe(400);
  });

  it('patches editable fields, recomputes the dedupe key, and deletes', async () => {
    const { a } = await boot();
    const opp = (await createOpp(a)).json();
    const other = (await createOpp(a, { title: 'Staff Engineer' })).json();
    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${opp.id}`,
      payload: { priority: 3, stageDetail: 'onsite loop', compNote: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      priority: 3,
      stageDetail: 'onsite loop',
      compNote: null,
      stage: 'discovered',
    });
    // Renaming onto another live opportunity's key is a duplicate.
    const clash = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${opp.id}`,
      payload: { title: 'Staff Engineer' },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.existingId).toBe(other.id);
    // stage is not patchable; it only moves through /stage.
    const stage = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${opp.id}`,
      payload: { stage: 'offer' },
    });
    expect(stage.statusCode).toBe(400);

    const del = await a.request({ method: 'DELETE', url: `/api/v1/opportunities/${opp.id}` });
    expect(del.statusCode).toBe(204);
    const gone = await a.request({ method: 'GET', url: `/api/v1/opportunities/${opp.id}` });
    expect(gone.statusCode).toBe(404);
  });

  const createId = async (c: TestClient) => (await createOpp(c)).json().id as string;

  assertIsolated({
    name: 'opportunities (GET)',
    create: createId,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/opportunities/${id}` }),
  });
  assertIsolated({
    name: 'opportunities (stage)',
    create: createId,
    read: (c, id) => move(c, id, { to: 'interested' }),
  });
  assertIsolated({
    name: 'opportunities (PATCH)',
    create: createId,
    read: (c, id) =>
      c.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload: { priority: 3 } }),
  });
  assertIsolated({
    name: 'opportunities (DELETE)',
    create: createId,
    read: (c, id) => c.request({ method: 'DELETE', url: `/api/v1/opportunities/${id}` }),
  });

  it('never lists or filters into another user rows', async () => {
    const { a, b } = await boot();
    const opp = (await createOpp(a)).json();
    const list = await b.request({
      method: 'GET',
      url: `/api/v1/opportunities?companyId=${opp.companyId}`,
    });
    expect(list.json()).toEqual({ items: [], total: 0 });
  });
});

describe('descriptionIsUserWritten (issue #255)', () => {
  it('is true for a description typed in at creation, with no system fingerprint', async () => {
    const { a } = await boot();
    const opp = (await createOpp(a)).json();
    expect(opp.descriptionIsUserWritten).toBe(true);
  });

  it('is false once the system records its own fingerprint for the text', async () => {
    const { app, a } = await boot();
    const { descriptionFingerprint } = await import('../src/lib/postingFingerprint');
    const { updateOpportunity } = await import('../src/repos/opportunities');
    const opp = (await createOpp(a)).json();
    await updateOpportunity(app.db, { userId: a.userId, isAdmin: false }, opp.id, {
      descriptionFingerprint: descriptionFingerprint(opp.descriptionMd),
    });
    const got = await a.request({ method: 'GET', url: `/api/v1/opportunities/${opp.id}` });
    expect(got.json().descriptionIsUserWritten).toBe(false);
  });

  it('is false for no description at all: nothing has been written to protect', async () => {
    const { a } = await boot();
    const opp = (
      await a.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: { companyName: 'Acme', title: 'PM', sourceKind: 'import' },
      })
    ).json();
    expect(opp.descriptionIsUserWritten).toBe(false);
  });
});

describe('manual order (issue #240)', () => {
  it('assigns the first opportunity in a stage 0, then appends by 10, per user and per stage', async () => {
    const { a, b } = await boot();
    const first = (await createOpp(a)).json();
    expect(first.sortOrder).toBe(0);
    const second = (await createOpp(a, { title: 'Staff Engineer' })).json();
    expect(second.sortOrder).toBe(10);
    // Another user starting fresh is not appending onto a's rows.
    const otherUser = (await createOpp(b)).json();
    expect(otherUser.sortOrder).toBe(0);
  });

  it('patches sortOrder directly, for an in-stage drag reorder', async () => {
    const { a } = await boot();
    const opp = (await createOpp(a)).json();
    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${opp.id}`,
      payload: { sortOrder: 15 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ sortOrder: 15, stage: 'discovered' });
  });

  it('rejects a sortOrder outside the patchable range', async () => {
    const { a } = await boot();
    const opp = (await createOpp(a)).json();
    const res = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${opp.id}`,
      payload: { sortOrder: 2_000_000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('appends at the bottom of the destination stage on a stage change, ignoring the old value', async () => {
    const { a } = await boot();
    // A card already sitting in `interested`, so it has a real bottom to append past. The
    // PATCH happens after the move: a move itself always re-appends (see the resident's own
    // transition below), so patching first would just be overwritten by that same rule.
    const resident = (await createOpp(a, { title: 'Resident' })).json();
    await move(a, resident.id, { to: 'interested' });
    await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${resident.id}`,
      payload: { sortOrder: 40 },
    });

    const incoming = (await createOpp(a, { title: 'Incoming' })).json();
    await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${incoming.id}`,
      payload: { sortOrder: -500 },
    });
    const moved = await move(a, incoming.id, { to: 'interested' });
    expect(moved.json().sortOrder).toBeGreaterThan(40);
  });

  it('lists sorted by sortOrder', async () => {
    const { a } = await boot();
    const first = (await createOpp(a, { title: 'First' })).json();
    const second = (await createOpp(a, { title: 'Second' })).json();
    await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${first.id}`,
      payload: { sortOrder: 99 },
    });
    const list = await a.request({ method: 'GET', url: '/api/v1/opportunities?sort=sortOrder' });
    expect(list.json().items.map((o: { id: string }) => o.id)).toEqual([second.id, first.id]);
  });

  describe('batch reorder, one transaction per column (issue #240 follow-up)', () => {
    it('applies a whole column in one request', async () => {
      const { a } = await boot();
      const x = (await createOpp(a, { title: 'X' })).json();
      const y = (await createOpp(a, { title: 'Y' })).json();
      const z = (await createOpp(a, { title: 'Z' })).json();
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/opportunities/reorder',
        payload: {
          changes: [
            { id: z.id, sortOrder: 0 },
            { id: x.id, sortOrder: 10 },
            { id: y.id, sortOrder: 20 },
          ],
        },
      });
      expect(res.statusCode).toBe(204);
      const list = await a.request({ method: 'GET', url: '/api/v1/opportunities?sort=sortOrder' });
      expect(list.json().items.map((o: { id: string }) => o.id)).toEqual([z.id, x.id, y.id]);
    });

    it('renumbers a large tied column correctly and well within budget', async () => {
      const { a } = await boot();
      const ids: string[] = [];
      for (let i = 0; i < 150; i++) {
        ids.push((await createOpp(a, { title: `Card ${i}` })).json().id);
      }
      // All 150 start tied at sortOrder 0 (the exact live scenario this fixes): move the first
      // card to the back, which is reorderColumn's shape for touching nearly the whole column.
      const changes = [...ids.slice(1), ids[0]].map((id, i) => ({ id, sortOrder: i * 10 }));
      const started = Date.now();
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/opportunities/reorder',
        payload: { changes },
      });
      const elapsedMs = Date.now() - started;
      expect(res.statusCode).toBe(204);
      expect(elapsedMs).toBeLessThan(5000);
      const list = await a.request({
        method: 'GET',
        url: '/api/v1/opportunities?sort=sortOrder&limit=200',
      });
      expect(list.json().items.map((o: { id: string }) => o.id)).toEqual([...ids.slice(1), ids[0]]);
    });

    it('scopes every row to the caller: another user id in the batch is silently skipped', async () => {
      const { a, b } = await boot();
      const mine = (await createOpp(a)).json();
      const theirs = (await createOpp(b)).json();
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/opportunities/reorder',
        payload: {
          changes: [
            { id: mine.id, sortOrder: 50 },
            { id: theirs.id, sortOrder: 50 },
          ],
        },
      });
      expect(res.statusCode).toBe(204);
      const mineNow = await a.request({ method: 'GET', url: `/api/v1/opportunities/${mine.id}` });
      expect(mineNow.json().sortOrder).toBe(50);
      const theirsNow = await b.request({
        method: 'GET',
        url: `/api/v1/opportunities/${theirs.id}`,
      });
      expect(theirsNow.json().sortOrder).toBe(0);
    });

    it('rejects an empty batch, a sortOrder out of range, and a batch over the size cap', async () => {
      const { a } = await boot();
      const opp = (await createOpp(a)).json();
      expect(
        (
          await a.request({
            method: 'POST',
            url: '/api/v1/opportunities/reorder',
            payload: { changes: [] },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await a.request({
            method: 'POST',
            url: '/api/v1/opportunities/reorder',
            payload: { changes: [{ id: opp.id, sortOrder: 2_000_000 }] },
          })
        ).statusCode,
      ).toBe(400);
      const tooMany = Array.from({ length: 2001 }, (_, i) => ({ id: `x${i}`, sortOrder: i }));
      expect(
        (
          await a.request({
            method: 'POST',
            url: '/api/v1/opportunities/reorder',
            payload: { changes: tooMany },
          })
        ).statusCode,
      ).toBe(400);
    });
  });
});

describe('company domain resolution trigger (issue #239)', () => {
  async function resolveJobs(app: FastifyInstance) {
    return app.db.select().from(jobs).where(eq(jobs.kind, COMPANY_DOMAIN_RESOLVE_KIND)).all();
  }
  async function setDomain(c: TestClient, companyId: string, domain: string | null) {
    const res = await c.request({
      method: 'PATCH',
      url: `/api/v1/companies/${companyId}`,
      payload: { domain },
    });
    expect(res.statusCode).toBe(200);
  }

  it('entering an active pipeline stage queues resolution when the company has no domain', async () => {
    const { app, a } = await boot();
    const opp = (await createOpp(a)).json();

    expect((await move(a, opp.id, { to: 'interested' })).statusCode).toBe(200);

    const queued = await resolveJobs(app);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toEqual({ companyId: opp.companyId });
    expect(queued[0]?.userId).toBe(a.userId);
  });

  it('does not queue resolution when the company already has a domain', async () => {
    const { app, a } = await boot();
    const opp = (await createOpp(a)).json();
    await setDomain(a, opp.companyId, 'initech.example');

    await move(a, opp.id, { to: 'interested' });

    expect(await resolveJobs(app)).toEqual([]);
  });

  it('does not queue resolution for a transition that is not an active pipeline stage', async () => {
    const { app, a } = await boot();
    const opp = (await createOpp(a)).json();

    // 'applied' then 'closed': the terminal exit is not worth a homepage lookup.
    await move(a, opp.id, { to: 'applied' });
    expect(await resolveJobs(app)).toHaveLength(1);
    // Clear the one queued by entering 'applied', so the 'closed' move is isolated below.
    await app.db.delete(jobs).where(eq(jobs.kind, COMPANY_DOMAIN_RESOLVE_KIND)).run();

    await move(a, opp.id, { to: 'closed', closedReason: 'withdrawn' });

    expect(await resolveJobs(app)).toEqual([]);
  });

  it('dedupes across several opportunities of the same company', async () => {
    const { app, a } = await boot();
    const first = (await createOpp(a)).json();
    const second = (await createOpp(a, { title: 'A different role' })).json();
    expect(second.companyId).toBe(first.companyId);

    await move(a, first.id, { to: 'interested' });
    await move(a, second.id, { to: 'applied' });

    expect(await resolveJobs(app)).toHaveLength(1);
  });

  it("never queues resolution into another user's job table", async () => {
    const { app, a, b } = await boot();
    const opp = (await createOpp(a)).json();

    await move(a, opp.id, { to: 'interested' });

    const bJobs = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, COMPANY_DOMAIN_RESOLVE_KIND), eq(jobs.userId, b.userId)))
      .all();
    expect(bJobs).toEqual([]);
  });
});

describe('stage sort expression', () => {
  it('orders by integer lifecycle positions (literal THEN values, typed int on Postgres)', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { OPPORTUNITY_STAGES } = await import('@opportun/core');
    const { OPPORTUNITY_SORTS } = await import('../src/repos/opportunities');
    const expr = OPPORTUNITY_SORTS.get('stage');
    if (expr === undefined || !('getSQL' in expr)) throw new Error('no stage sort');
    const q = new PgDialect().sqlToQuery(expr.getSQL());
    const whens = OPPORTUNITY_STAGES.map((_, i) => `WHEN $${i + 1} THEN ${i}`).join(' ');
    expect(q.sql).toBe(`CASE "opportunities"."stage" ${whens} END`);
    expect(q.params).toEqual([...OPPORTUNITY_STAGES]);
  });
});
