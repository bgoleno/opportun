// https://github.com/bgoleno/opportun/issues/785 (qa's second regression pass): two saves of the
// same `gh_jid` link 300 ms apart, the second also changing the company, ended with the second
// company and the first company's job identity. A `gh_jid` link's identity is proven on the
// company's own Greenhouse boards (#398), so it holds only for the company it was checked
// against: a company change drops it and checks the new company's boards, and a check made for
// the old company never lands on the row once the company has changed.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { opportunities } from '../src/db/schema';
import { verifiedGreenhouseRef } from '../src/lib/atsJobRef';
import { setCheckedPostingRef } from '../src/lib/greenhouseEmbed';
import type { safeFetch } from '../src/lib/safeFetch';
import { createCompany } from '../src/repos/companies';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const L = 'https://careers.example.com/jobs?gh_jid=7201';
const JOB = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/([0-9]+)$/;

type Answer = 'yes' | 'no' | Promise<'yes' | 'no'>;

/** A Greenhouse API whose answer per board the test decides. */
function greenhouse(answer: (board: string) => Answer) {
  return (async (url: string) => {
    const m = JOB.exec(url);
    if (m === null) throw new Error(`unexpected request: ${url}`);
    const [, board, jid] = m as unknown as [string, string, string];
    const a = await answer(board);
    return {
      status: a === 'yes' ? 200 : 404,
      headers: new Headers(),
      body: Buffer.from(a === 'yes' ? JSON.stringify({ id: Number(jid) }) : '{}'),
    };
  }) as unknown as typeof safeFetch;
}

/** Acme (board `acme`) and Beta (board `beta`), and an opportunity at Acme with no link. */
async function twoCompanies(app: App, c: TestClient) {
  const ctx = ctxOf(c);
  for (const [name, board] of [
    ['Acme', 'acme'],
    ['Beta', 'beta'],
  ] as const) {
    await createCompany(app.db, ctx, {
      name,
      atsKind: 'ats_greenhouse',
      atsRef: board,
      atsVerifiedAt: Date.now(),
    });
  }
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Acme',
    title: 'Staff Engineer',
    sourceKind: 'manual',
  });
  return { ctx, opp };
}

const save = (c: TestClient, id: string, body: { postingUrl?: string; companyName?: string }) =>
  c.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload: body });

async function stored(app: App, id: string) {
  const row = (await app.db
    .select({
      postingUrl: opportunities.postingUrl,
      atsJobRef: opportunities.atsJobRef,
      companyId: opportunities.companyId,
    })
    .from(opportunities)
    .where(eq(opportunities.id, id))
    .get())!;
  return { ...row, board: (row.atsJobRef as { org?: string } | null)?.org ?? null };
}

/** A promise held until `release`, and one that resolves once the hold is reached. */
function hold() {
  let release!: () => void;
  let reached!: () => void;
  const answer = new Promise<'yes'>((r) => (release = () => r('yes')));
  const atHold = new Promise<void>((r) => (reached = r));
  return { answer, atHold, release, reached };
}

describe('overlapping saves of one gh_jid link, the second changing the company (#785)', () => {
  it("qa's repro: the identity is the new company's, not the first save's", async () => {
    const { app, a } = await boot();
    const { opp } = await twoCompanies(app, a);
    const acme = hold();
    app.jobs.services.sourceFetch = greenhouse((board) => {
      if (board !== 'acme') return 'yes';
      acme.reached();
      return acme.answer;
    });
    const first = save(a, opp.id, { postingUrl: L, companyName: 'Acme' });
    await acme.atHold;
    expect((await save(a, opp.id, { postingUrl: L, companyName: 'Beta' })).statusCode).toBe(200);
    acme.release();
    expect((await first).statusCode).toBe(200);
    expect((await stored(app, opp.id)).board).toBe('beta');
  });

  it("the first save's late identity does not land when the new company's boards lack the job", async () => {
    const { app, a } = await boot();
    const { opp } = await twoCompanies(app, a);
    const acme = hold();
    app.jobs.services.sourceFetch = greenhouse((board) => {
      if (board !== 'acme') return 'no';
      acme.reached();
      return acme.answer;
    });
    const first = save(a, opp.id, { postingUrl: L, companyName: 'Acme' });
    await acme.atHold;
    expect((await save(a, opp.id, { postingUrl: L, companyName: 'Beta' })).statusCode).toBe(200);
    acme.release();
    expect((await first).statusCode).toBe(200);
    const row = await stored(app, opp.id);
    expect(row.postingUrl).toBe(L);
    expect(row.atsJobRef).toBeNull();
  });

  it('one after the other: a company change drops the old identity and checks the new boards', async () => {
    const { app, a } = await boot();
    const { opp } = await twoCompanies(app, a);
    app.jobs.services.sourceFetch = greenhouse(() => 'yes');
    expect((await save(a, opp.id, { postingUrl: L, companyName: 'Acme' })).statusCode).toBe(200);
    expect((await stored(app, opp.id)).board).toBe('acme');
    expect((await save(a, opp.id, { postingUrl: L, companyName: 'Beta' })).statusCode).toBe(200);
    expect((await stored(app, opp.id)).board).toBe('beta');
  });

  it('a save that changes only the company checks the stored link on the new boards', async () => {
    const { app, a } = await boot();
    const { opp } = await twoCompanies(app, a);
    app.jobs.services.sourceFetch = greenhouse(() => 'yes');
    await save(a, opp.id, { postingUrl: L });
    expect((await stored(app, opp.id)).board).toBe('acme');
    expect((await save(a, opp.id, { companyName: 'Beta' })).statusCode).toBe(200);
    expect((await stored(app, opp.id)).board).toBe('beta');
  });

  it('a check made for one company is not stored once the row has another', async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await twoCompanies(app, a);
    app.jobs.services.sourceFetch = greenhouse(() => 'no');
    await save(a, opp.id, { postingUrl: L, companyName: 'Acme' });
    const acmeId = (await stored(app, opp.id)).companyId;
    await save(a, opp.id, { companyName: 'Beta' });
    const ref = verifiedGreenhouseRef('acme', '7201', Date.now())!;
    expect(await setCheckedPostingRef(app.db, ctx, opp.id, L, ref, acmeId)).toBe(false);
    expect((await stored(app, opp.id)).atsJobRef).toBeNull();
  });

  it("a board link's identity is the link's own, and stays through a company change", async () => {
    const { app, a } = await boot();
    const { opp } = await twoCompanies(app, a);
    app.jobs.services.sourceFetch = greenhouse(() => 'no');
    const board = 'https://job-boards.greenhouse.io/acme/jobs/7201';
    await save(a, opp.id, { postingUrl: board });
    expect((await stored(app, opp.id)).board).toBe('acme');
    await save(a, opp.id, { companyName: 'Beta' });
    expect((await stored(app, opp.id)).board).toBe('acme');
  });
});
