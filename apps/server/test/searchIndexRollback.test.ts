// Review note 8: the index write shares the entity's transaction on Postgres too. SQLite
// cannot take a trigger on its FTS5 virtual table, so this runs on the Postgres leg. Split out
// of searchParity.test.ts by issue #322: a transaction-rollback bug here is not a dialect-parity
// disagreement, even though it only runs on one leg.
import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import { countRows, queryOne, testDialect, withFailingWrite } from './db';
import type { TestClient } from './isolation';

interface Hit {
  entityKind: string;
  entityId: string;
  snippet: string;
  opportunityId: string | null;
}

const boot = useApi();

async function search(c: TestClient, q: string): Promise<{ items: Hit[]; total: number }> {
  const res = await c.request({
    method: 'GET',
    url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=100`,
  });
  expect(res.statusCode, `${q}: ${res.body}`).toBe(200);
  return res.json();
}

describe.runIf(testDialect === 'postgres')('index writes roll back with their entity', () => {
  it('a failed index write leaves no opportunity, and an update keeps the old text', async () => {
    const { app, a } = await boot();
    const undo = await withFailingWrite(app, 'search_index', { on: 'INSERT', message: 'boom' });
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Zeta', title: 'Rollback probe', sourceKind: 'manual' },
    });
    expect(res.statusCode).toBe(500);
    expect(await countRows(app, 'opportunities', 'user_id = ?', a.userId)).toBe(0);
    await undo();

    const made = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Zeta', title: 'Original title', sourceKind: 'manual' },
    });
    const id = (made.json() as { id: string }).id;
    const undoUpdate = await withFailingWrite(app, 'search_index', {
      on: 'UPDATE',
      message: 'boom',
    });
    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${id}`,
      payload: { title: 'Replaced title' },
    });
    expect(patched.statusCode).toBe(500);
    await undoUpdate();
    const row = await queryOne<{ title: string }>(
      app,
      'SELECT title FROM opportunities WHERE id = ?',
      id,
    );
    expect(row?.title).toBe('Original title');
    expect((await search(a, 'original')).items.map((h) => h.entityId)).toEqual([id]);
    expect((await search(a, 'replaced')).items).toEqual([]);
  });
});
