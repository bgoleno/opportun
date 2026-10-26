// Search parity between SQLite (FTS5, unicode61 remove_diacritics 2) and Postgres (tsvector,
// iteration 4 Task 11). This file runs on whichever engine the run uses (both legs of the CI
// matrix) against ONE table of expectations, so a query whose hits differ between the engines
// fails on the leg that disagrees. The corpus is written through the real write paths (routes
// and the inbound mail upsert), never straight into search_index.
//
// Documented differences are expectations here, not skips (see KNOWN_DIFFERENCES, in
// searchCorpus.ts alongside the table itself).
//
// Split out of a single bundled file by issue #322: this file used to also carry the pgSnippet
// builder/snippet tests, the indexed-text-cap tests and the index-rollback test, so a failure
// in any of the four read as a dialect-parity failure regardless of which one actually broke.
// They now live in pgSnippet.test.ts, searchDocumentCap.test.ts and searchIndexRollback.test.ts
// respectively. CORPUS/QUERIES moved to searchCorpus.ts, since pgSnippet.test.ts's reference-
// snippet cross-check reuses the same table (see that file's own header for why that one
// sharing is a declared import, not a duplicated copy).
import { describe, expect, it } from 'vitest';
import { upsertInbound } from '../src/repos/communications';
import { SNIPPET_END, SNIPPET_START } from '../src/repos/search';
import { useApi } from './api';
import { testDialect } from './db';
import type { TestClient } from './isolation';
import { BIG, CORPUS, KNOWN_DIFFERENCES, QUERIES, type Label } from './searchCorpus';

const S = SNIPPET_START;
const E = SNIPPET_END;

interface Hit {
  entityKind: string;
  entityId: string;
  snippet: string;
  opportunityId: string | null;
}

const boot = useApi();

async function create(c: TestClient, label: Label, oppId: string): Promise<string> {
  const doc = CORPUS[label];
  if (doc.kind === 'o') {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: {
        companyName: 'Zeta',
        title: doc.title,
        descriptionMd: doc.text,
        sourceKind: 'manual',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }
  if (doc.kind === 'a') {
    const res = await c.request({
      method: 'POST',
      url: `/api/v1/opportunities/${oppId}/activities`,
      payload: { kind: 'note', title: 'Zz', bodyMd: doc.text },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }
  if (doc.kind === 'p') {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/contacts',
      payload: { name: doc.title, notes: doc.text },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }
  throw new Error(`create ${label} through upsertInbound instead`);
}

async function search(c: TestClient, q: string): Promise<{ items: Hit[]; total: number }> {
  const res = await c.request({
    method: 'GET',
    url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=100`,
  });
  expect(res.statusCode, `${q}: ${res.body}`).toBe(200);
  return res.json();
}

describe(`search parity (${testDialect})`, () => {
  it('returns the expected hit set for every query in the table, on this engine', async () => {
    const { app, a, b } = await boot();
    // The holder opportunity for activities; its own words never appear in QUERIES.
    const holder = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Zeta', title: 'Holder', sourceKind: 'manual' },
    });
    const oppId = (holder.json() as { id: string }).id;
    const idOf = new Map<string, Label>();
    let seq = 0;
    for (const label of Object.keys(CORPUS) as Label[]) {
      const doc = CORPUS[label];
      let id: string;
      if (doc.kind === 'c') {
        seq += 1;
        const ctx = { userId: a.userId, isAdmin: false };
        id = (
          await upsertInbound(app.db, ctx, 'gmail', {
            externalId: `parity-${seq}`,
            threadKey: `t-${seq}`,
            from: 'someone@zeta.example',
            to: ['me@zeta.example'],
            subject: doc.title,
            snippet: doc.text,
            bodyText: '',
            sentAt: 1_790_000_000_000,
          })
        ).id;
      } else {
        id = await create(a, label, oppId);
      }
      idOf.set(id, label);
    }
    // User b holds the same words: none of it may reach user a.
    const bOpp = await b.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: {
        companyName: 'Zeta',
        title: 'Café Résumé state-of-the-art',
        descriptionMd: 'needle observability 東京 jane.doe@example.com AND',
        sourceKind: 'manual',
      },
    });
    expect(bOpp.statusCode).toBe(201);

    const mismatches: string[] = [];
    for (const { q, hits, top } of QUERIES) {
      const res = await search(a, q);
      const got = res.items.map((h) => idOf.get(h.entityId) ?? `foreign:${h.entityId}`);
      const want = [...hits].sort();
      if (JSON.stringify([...got].sort()) !== JSON.stringify(want) || res.total !== hits.length) {
        mismatches.push(
          `${JSON.stringify(q)}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)} (total ${res.total})`,
        );
      }
      if (top !== undefined && got[0] !== top) {
        mismatches.push(`${JSON.stringify(q)}: want top ${top}, got ${String(got[0])}`);
      }
      for (const h of res.items) {
        // Every hit marks what matched, and no snippet carries user b's text.
        if (!h.snippet.includes(S) || !h.snippet.includes(E)) {
          mismatches.push(`${JSON.stringify(q)}: unmarked snippet ${JSON.stringify(h.snippet)}`);
        }
      }
    }
    // Printed in full: on a leg where the engines disagree this is the whole diff.
    expect(mismatches, `${testDialect} search parity:\n${mismatches.join('\n')}`).toEqual([]);
    expect(KNOWN_DIFFERENCES).toEqual([]);
  });

  it('marks the matched term in a snippet window, with ellipses where it cuts', async () => {
    const { a } = await boot();
    const holder = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Zeta', title: 'Holder', descriptionMd: BIG, sourceKind: 'manual' },
    });
    expect(holder.statusCode).toBe(201);
    const [hit] = (await search(a, 'needle')).items;
    expect(hit?.snippet).toContain(`${S}needle${E}`);
    expect(hit?.snippet.startsWith('...')).toBe(true);
    expect(hit?.snippet.endsWith('...')).toBe(true);
    expect(hit?.snippet.length).toBeLessThan(200);
    // Accent-folded and prefix matches mark the original word.
    await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: { companyName: 'Zeta', title: 'Café Résumé', sourceKind: 'manual' },
    });
    const [cafe] = (await search(a, 'cafe resu')).items;
    expect(cafe?.snippet).toBe(`${S}Café${E} ${S}Résumé${E}`);
  });
});
