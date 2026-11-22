// Two request-path reads that grew with the user's history (https://github.com/bgoleno/opportun/issues/592,
// tl's backlog pass): the dashboard counted the whole timeline (every activity, stage change and
// linked message) to show ten of them, and the Settings > Jobs poll (every 5 s, 200 rows) read
// every column, payload and result included, ordered by updated_at with no index.
import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { describe, expect, it, vi } from 'vitest';
import { rawAll } from '../src/db/client';
import { jobsListQuery } from '../src/routes/jobs';
import { useApi } from './api';
import { testDialect } from './db';
import type { TestClient } from './isolation';

// Every single-row raw read, rendered, so a test can see whether the timeline was counted.
const reads: string[] = [];
const render = new SQLiteSyncDialect();
vi.mock('../src/db/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/db/client')>();
  return {
    ...real,
    rawGet: vi.fn((e: Parameters<typeof real.rawGet>[0], q: Parameters<typeof real.rawGet>[1]) => {
      reads.push(render.sqlToQuery(q).sql);
      return real.rawGet(e, q);
    }),
  };
});

const boot = useApi();
const timelineCounts = () => reads.filter((s) => /count\(\*\) AS n FROM \(/i.test(s));

async function withHistory(c: TestClient): Promise<string> {
  const opp = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName: 'Initech', title: 'Principal PM', sourceKind: 'manual' },
  });
  expect(opp.statusCode, opp.body).toBe(201);
  const id = (opp.json() as { id: string }).id;
  for (let i = 0; i < 3; i++) {
    const res = await c.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/activities`,
      payload: { kind: 'note', title: `Note ${i}` },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  return id;
}

describe('the dashboard counts nothing it does not show (#592)', () => {
  it('a dashboard load runs no count of the whole timeline, and its recent activity is as before', async () => {
    const { a } = await boot();
    await withHistory(a);
    reads.length = 0;
    const res = await a.request({ method: 'GET', url: '/api/v1/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(timelineCounts()).toEqual([]);
    const titles = (res.json() as { recentActivity: { title?: string }[] }).recentActivity.map(
      (r) => r.title,
    );
    expect(titles.slice(0, 3)).toEqual(['Note 2', 'Note 1', 'Note 0']);
  });

  it("an opportunity's timeline still counts its whole history, for its pages", async () => {
    const { a } = await boot();
    const id = await withHistory(a);
    reads.length = 0;
    const res = await a.request({ method: 'GET', url: `/api/v1/opportunities/${id}/timeline` });
    expect(res.statusCode).toBe(200);
    expect(timelineCounts()).toHaveLength(1);
    expect((res.json() as { total: number }).total).toBeGreaterThanOrEqual(3);
  });
});

describe('the jobs poll reads only what the screen shows, by an index (#592)', () => {
  it('selects the shown columns, never a payload or a result', async () => {
    const { app } = await boot();
    const text = jobsListQuery(app.db, undefined, 200).toSQL().sql;
    expect(text).not.toMatch(/"payload"|"result"/);
    expect(text).toMatch(/"updated_at"/);
  });

  it.skipIf(testDialect !== 'sqlite')(
    'its plan walks an index in updated_at order: no table scan, no sort of every row',
    async () => {
      const { app } = await boot();
      const q = jobsListQuery(app.db, undefined, 200).toSQL();
      // Its only parameter is the limit, a number: inlined for EXPLAIN.
      const params = [...q.params] as number[];
      const inlined = q.sql.replace(/\?/g, () => String(params.shift()));
      const plan = await rawAll<{ detail: string }>(
        app.db,
        sql.raw(`EXPLAIN QUERY PLAN ${inlined}`),
      );
      const text = plan.map((r) => r.detail).join('\n');
      expect(text).toMatch(/USING (COVERING )?INDEX jobs_updated_at_idx/);
      expect(text).not.toMatch(/TEMP B-TREE/);
    },
  );
});
