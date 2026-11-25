// Two request-path reads that grew with the user's history (https://github.com/bgoleno/opportun/issues/592,
// tl's backlog pass): the dashboard counted the whole timeline (every activity, stage change and
// linked message) to show ten of them, and the Settings > Jobs poll (every 5 s, 200 rows) read
// every column, payload and result included, ordered by updated_at with no index.
import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { describe, expect, it, vi } from 'vitest';
import { rawAll } from '../src/db/client';
import { jobCountsQuery, jobsListQuery } from '../src/repos/jobs';
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
    const text = jobsListQuery(app.db, { kind: 'all' }, { limit: 200 }).toSQL().sql;
    expect(text).not.toMatch(/"payload"|"result"/);
    expect(text).toMatch(/"updated_at"/);
  });

  async function plan(q: { toSQL: () => { sql: string; params: unknown[] } }) {
    const { sql: text, params } = q.toSQL();
    // Numbers and statuses: inlined for EXPLAIN.
    const left = [...params];
    const inlined = text.replace(/\?/g, () => {
      const p = left.shift();
      return typeof p === 'number' ? String(p) : `'${String(p)}'`;
    });
    const { app } = await boot();
    const rows = await rawAll<{ detail: string }>(app.db, sql.raw(`EXPLAIN QUERY PLAN ${inlined}`));
    return rows.map((r) => r.detail).join('\n');
  }

  // Filtered to Done it is nearly every job kept (#982): the same walk, not a sort of them all.
  it.skipIf(testDialect !== 'sqlite').each([undefined, 'done'] as const)(
    'its plan walks an index in updated_at order, with no table scan and no sort of every row: status %s',
    async (status) => {
      const { app } = await boot();
      const text = await plan(jobsListQuery(app.db, { kind: 'all' }, { status, limit: 200 }));
      expect(text).toMatch(/USING (COVERING )?INDEX jobs_updated_at_idx/);
      expect(text).not.toMatch(/TEMP B-TREE/);
    },
  );

  it.skipIf(testDialect !== 'sqlite').each(['queued', 'retrying', 'running', 'dead'] as const)(
    'filtered to %s it reads the jobs of that status by an index',
    async (status) => {
      const { app } = await boot();
      const text = await plan(jobsListQuery(app.db, { kind: 'all' }, { status, limit: 200 }));
      expect(text).toMatch(/USING INDEX jobs_status_run_at_idx \(status=\?\)/);
    },
  );

  it.skipIf(testDialect !== 'sqlite')(
    'the counts read the finished jobs from the index alone (#982)',
    async () => {
      const { app } = await boot();
      const text = await plan(jobCountsQuery(app.db, { kind: 'all' }));
      expect(text).toMatch(/USING COVERING INDEX jobs_status_run_at_idx/);
      expect(text).toMatch(/SEARCH jobs USING INDEX jobs_status_run_at_idx \(status=\?\)/);
      expect(text).not.toMatch(/SCAN jobs(?! USING COVERING)/);
    },
  );
});
