import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { queryOne } from './db';

const boot = useApi();
const START = '\u0002';
const END = '\u0003';

interface Hit {
  entityKind: string;
  entityId: string;
  snippet: string;
  opportunityId: string;
}

async function createOpp(c: TestClient, extra: Record<string, unknown> = {}) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: {
      companyName: 'Initech',
      title: 'Principal PM',
      descriptionMd: 'Own the observability roadmap for the platform.',
      sourceKind: 'manual',
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function addActivity(c: TestClient, oppId: string, body: Record<string, unknown>) {
  const res = await c.request({
    method: 'POST',
    url: `/api/v1/opportunities/${oppId}/activities`,
    payload: { kind: 'note', title: 'Call notes', ...body },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function search(c: TestClient, q: string): Promise<{ items: Hit[]; total: number }> {
  const res = await c.request({
    method: 'GET',
    url: `/api/v1/search?q=${encodeURIComponent(q)}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

describe('full-text search', () => {
  it('finds an opportunity by a description word, with a marked snippet', async () => {
    const { a } = await boot();
    const opp = await createOpp(a);
    const res = await search(a, 'observability');
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({
      entityKind: 'opportunity',
      entityId: opp.id,
      opportunityId: opp.id,
    });
    expect(res.items[0]?.snippet).toContain(`${START}observability${END}`);
  });

  it('finds an activity by a body word and reports its opportunity', async () => {
    const { a } = await boot();
    const opp = await createOpp(a);
    const act = await addActivity(a, opp.id, { bodyMd: 'Discussed the kubernetes migration.' });
    const res = await search(a, 'kubernetes');
    expect(res.items).toEqual([
      expect.objectContaining({ entityKind: 'activity', entityId: act.id, opportunityId: opp.id }),
    ]);
    // Titles are indexed too, and prefix matching works on the last term.
    expect((await search(a, 'princ')).items.map((h) => h.entityId)).toEqual([opp.id]);
  });

  it('keeps the index in step with updates and deletes', async () => {
    const { app, a } = await boot();
    const opp = await createOpp(a);
    const act = await addActivity(a, opp.id, { bodyMd: 'zebra' });
    await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${opp.id}`,
      payload: { descriptionMd: 'Now about giraffes.' },
    });
    expect((await search(a, 'observability')).total).toBe(0);
    expect((await search(a, 'giraffes')).total).toBe(1);

    await a.request({
      method: 'PATCH',
      url: `/api/v1/activities/${act.id}`,
      payload: { bodyMd: 'okapi' },
    });
    expect((await search(a, 'zebra')).total).toBe(0);
    expect((await search(a, 'okapi')).total).toBe(1);

    await a.request({ method: 'DELETE', url: `/api/v1/activities/${act.id}` });
    expect((await search(a, 'okapi')).total).toBe(0);

    await addActivity(a, opp.id, { bodyMd: 'lemur' });
    await a.request({ method: 'DELETE', url: `/api/v1/opportunities/${opp.id}` });
    expect((await search(a, 'giraffes')).total).toBe(0);
    expect((await search(a, 'lemur')).total).toBe(0);
    // The index rows themselves are gone, not just hidden by the join back to the source.
    const rows = (await queryOne(
      app,
      'SELECT count(*) AS n FROM search_index WHERE user_id = ?',
      a.userId,
    )) as { n: number };
    expect(rows.n).toBe(0);
  });

  it('treats query syntax as plain words and never errors', async () => {
    const { a } = await boot();
    await createOpp(a);
    for (const q of ['"', 'observability AND (', 'NEAR(', '*', "o'brien", 'roadmap OR x:y']) {
      const res = await a.request({
        method: 'GET',
        url: `/api/v1/search?q=${encodeURIComponent(q)}`,
      });
      expect(res.statusCode, `${q}: ${res.body}`).toBe(200);
    }
    // Operators are literal words, so "AND" must also appear for this to match.
    expect((await search(a, 'observability AND')).total).toBe(0);
    expect((await search(a, 'observability roadmap')).total).toBe(1);
  });

  it('rejects an empty query and requires a session', async () => {
    const { app, a } = await boot();
    expect((await a.request({ method: 'GET', url: '/api/v1/search?q=' })).statusCode).toBe(400);
    expect((await a.request({ method: 'GET', url: '/api/v1/search' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/search?q=x' })).statusCode).toBe(401);
  });

  // Search has no by-id read, so the harness's assertIsolated (create, then read by id
  // expecting 404) does not fit. This uses the harness's two users and checks both ways.
  it("never returns another user's rows, in either direction", async () => {
    const { a, b } = await boot();
    const aOpp = await createOpp(a, { descriptionMd: 'secret-alpha shared-term' });
    await addActivity(a, aOpp.id, { bodyMd: 'alpha-note shared-term' });
    const bOpp = await createOpp(b, { descriptionMd: 'secret-bravo shared-term' });
    await addActivity(b, bOpp.id, { bodyMd: 'bravo-note shared-term' });

    expect((await search(b, 'alpha')).total).toBe(0);
    expect((await search(a, 'bravo')).total).toBe(0);

    const asA = await search(a, 'shared');
    const asB = await search(b, 'shared');
    expect(asA.total).toBe(2);
    expect(asB.total).toBe(2);
    expect(asA.items.every((h) => h.opportunityId === aOpp.id)).toBe(true);
    expect(asB.items.every((h) => h.opportunityId === bOpp.id)).toBe(true);
    expect(JSON.stringify(asA)).not.toContain('bravo');
    expect(JSON.stringify(asB)).not.toContain('alpha');
  });

  it('honors limit and offset', async () => {
    const { a } = await boot();
    for (const t of ['One', 'Two', 'Three']) await createOpp(a, { title: `PM ${t}` });
    const page = await a.request({ method: 'GET', url: '/api/v1/search?q=observability&limit=2' });
    expect(page.json().total).toBe(3);
    expect(page.json().items).toHaveLength(2);
    const rest = await a.request({
      method: 'GET',
      url: '/api/v1/search?q=observability&limit=2&offset=2',
    });
    expect(rest.json().items).toHaveLength(1);
  });
});
