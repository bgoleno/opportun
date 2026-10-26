// searchDocument's size cap (review note 5), split out of searchParity.test.ts by issue #322:
// it is a correctness-at-the-size-cap check, not a dialect-parity one, though its one Postgres-
// only case does go through a real database to prove a 1 MB tsvector actually indexes.
import { describe, expect, it } from 'vitest';
import { withTransaction } from '../src/db/client';
import { indexOpportunity, SEARCH_DOCUMENT_MAX_BYTES, searchDocument } from '../src/repos/search';
import { useApi } from './api';
import { testDialect } from './db';
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

describe('indexed text cap (review note 5)', () => {
  /** `n` distinct short words: the worst case for tsvector size. */
  const distinct = (bytes: number) => {
    const words: string[] = [];
    let size = 0;
    for (let i = 0; size < bytes; i++) {
      const w = `w${i.toString(36)}`;
      words.push(w);
      size += w.length + 1;
    }
    return words.join(' ');
  };

  it('indexes at most SEARCH_DOCUMENT_MAX_BYTES of folded tokens, cut between tokens', () => {
    const doc = searchDocument(distinct(1024 * 1024));
    expect(Buffer.byteLength(doc)).toBeLessThanOrEqual(SEARCH_DOCUMENT_MAX_BYTES);
    expect(Buffer.byteLength(doc)).toBeGreaterThan(SEARCH_DOCUMENT_MAX_BYTES - 16);
    expect(distinct(1024 * 1024).startsWith(`${doc} `)).toBe(true);
    // Bytes, not characters: three-byte CJK tokens are capped by their UTF-8 size.
    const cjk = searchDocument('東京 '.repeat(200_000));
    expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(SEARCH_DOCUMENT_MAX_BYTES);
    expect(cjk.endsWith('東京')).toBe(true);
  });

  it.runIf(testDialect === 'postgres')(
    'a 1 MB body of distinct words indexes (no "string is too long for tsvector") and its start is found',
    async () => {
      const { app, a } = await boot();
      const ctx = { userId: a.userId, isAdmin: false };
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: { companyName: 'Zeta', title: 'Holder', sourceKind: 'manual' },
      });
      const id = (res.json() as { id: string }).id;
      await withTransaction(app.db, (tx) =>
        indexOpportunity(tx, ctx, { id, title: 'Holder', descriptionMd: distinct(1024 * 1024) }),
      );
      const hits = await search(a, 'w1a');
      expect(hits.items.map((h) => h.entityId)).toEqual([id]);
    },
    60_000, // issue #72: indexing a genuine 1 MB document into Postgres's tsvector is real,
    // non-trivial work, and this test does it inline with an HTTP round trip and a search
    // query, all inside the suite's 30_000 ms global default -- tight enough that it failed
    // reproducibly under full-suite Postgres contention while passing cleanly in isolation
    // (11/11). The guarantee here is correctness at the size cap (no "string is too long for
    // tsvector", the indexed prefix is still searchable), not timing, so the fix is headroom
    // for real work, not a smaller document that would stop proving the cap matters.
  );
});
