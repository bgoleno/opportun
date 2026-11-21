// Proving which Greenhouse board holds a job linked from a company's own careers page
// (https://github.com/bgoleno/opportun/issues/398, criteria 1, 5 and 6): which boards are asked,
// in what order, how many requests, and what is recorded.
import { describe, expect, it } from 'vitest';
import type { safeFetch } from '../src/lib/safeFetch';
import { eq } from 'drizzle-orm';
import { discoverySources, opportunities } from '../src/db/schema';
import {
  EMBED_CHECK_BUDGET_MS,
  knownGreenhouseTokens,
  MAX_TOKENS_TRIED,
  resolvePostingAtsJobRef,
  verifyEmbeddedGreenhouse,
} from '../src/lib/greenhouseEmbed';
import { createCompany } from '../src/repos/companies';
import { createSource } from '../src/repos/discovery';
import { createOpportunity, setPostingState } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const CAREERS = 'https://careers.example.com/jobs?gh_jid=8136554';

/** A fetch that answers Greenhouse's job endpoint for `holds` (token -> job ids), counting calls. */
function greenhouse(holds: Record<string, string[]>, opts: { idInAnswer?: string } = {}) {
  const asked: string[] = [];
  const fetch = (async (url: string, init?: { allowHosts?: string[] }) => {
    asked.push(url);
    const m = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/([0-9]+)$/.exec(
      url,
    );
    if (m === null || init?.allowHosts?.join() !== 'boards-api.greenhouse.io') {
      throw new Error(`unexpected request: ${url}`);
    }
    const [, token, id] = m as unknown as [string, string, string];
    const held = new Map(Object.entries(holds)).get(token)?.includes(id) === true;
    return {
      status: held ? 200 : 404,
      headers: new Headers(),
      body: Buffer.from(held ? JSON.stringify({ id: Number(opts.idInAnswer ?? id) }) : '{}'),
    };
  }) as unknown as typeof safeFetch;
  return { asked, sctx: { fetch, log: { warn: () => {} } as never } };
}

async function company(
  app: Awaited<ReturnType<typeof boot>>['app'],
  c: TestClient,
  detected: string | null,
) {
  const ctx = ctxOf(c);
  const co = await createCompany(app.db, ctx, {
    name: 'Example Corp',
    ...(detected === null
      ? {}
      : { atsKind: 'ats_greenhouse', atsRef: detected, atsVerifiedAt: Date.now() }),
  });
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Example Corp',
    title: 'Staff Engineer',
    sourceKind: 'manual',
  });
  return { ctx, co, opp };
}

describe('the boards asked about a gh_jid link (#398 criterion 1)', () => {
  it("the company's detected board first, then its Greenhouse sources, then its other opportunities' boards; at most three", async () => {
    const { app, a } = await boot();
    const { ctx, co, opp } = await company(app, a, 'detected');
    await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'fromsource' },
      companyId: co.id,
    });
    const other = await createOpportunity(app.db, ctx, {
      companyName: 'Example Corp',
      title: 'Designer',
      sourceKind: 'manual',
    });
    await setPostingState(app.db, ctx, other.id, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: {
        kind: 'ats_greenhouse',
        org: 'fromopportunity',
        externalId: '1',
        url: 'https://job-boards.greenhouse.io/fromopportunity/jobs/1',
      },
    });
    const third = await createOpportunity(app.db, ctx, {
      companyName: 'Example Corp',
      title: 'Writer',
      sourceKind: 'manual',
    });
    await setPostingState(app.db, ctx, third.id, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: {
        kind: 'ats_greenhouse',
        org: 'fourthboard',
        externalId: '2',
        url: 'https://job-boards.greenhouse.io/fourthboard/jobs/2',
      },
    });
    const tokens = await knownGreenhouseTokens(app.db, ctx, opp);
    expect(MAX_TOKENS_TRIED).toBe(3);
    // The other opportunities newest first (#598): the Writer's board, queued after the Designer's.
    expect(tokens).toEqual(['detected', 'fromsource', 'fourthboard']);
  });

  it('a company with no known board: no token, and no request', async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await company(app, a, null);
    const gh = greenhouse({});
    expect(await verifyEmbeddedGreenhouse(app.db, ctx, opp, CAREERS, gh.sctx)).toBeNull();
    expect(gh.asked).toEqual([]);
  });
});

describe('verifyEmbeddedGreenhouse (#398 criteria 1, 2 and 5)', () => {
  it("records the board's identity when Greenhouse's API answers with the job, and the destination is the board's page", async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await company(app, a, 'examplecorp');
    const gh = greenhouse({ examplecorp: ['8136554'] });
    const ref = await verifyEmbeddedGreenhouse(app.db, ctx, opp, CAREERS, gh.sctx, 1234);
    expect(ref).toEqual({
      kind: 'ats_greenhouse',
      org: 'examplecorp',
      externalId: '8136554',
      url: 'https://job-boards.greenhouse.io/examplecorp/jobs/8136554',
      verifiedVia: 'gh_jid',
      verifiedAt: 1234,
    });
    expect(gh.asked).toEqual([
      'https://boards-api.greenhouse.io/v1/boards/examplecorp/jobs/8136554',
    ]);
  });

  it('a board that does not hold the job gives none; the next known board is asked', async () => {
    const { app, a } = await boot();
    const { ctx, co, opp } = await company(app, a, 'wrongboard');
    await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'rightboard' },
      companyId: co.id,
    });
    const none = greenhouse({});
    expect(await verifyEmbeddedGreenhouse(app.db, ctx, opp, CAREERS, none.sctx)).toBeNull();
    expect(none.asked).toHaveLength(2);
    const found = greenhouse({ rightboard: ['8136554'] });
    expect((await verifyEmbeddedGreenhouse(app.db, ctx, opp, CAREERS, found.sctx))?.org).toBe(
      'rightboard',
    );
  });

  it('an answer for another job id is not a yes', async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await company(app, a, 'examplecorp');
    const gh = greenhouse({ examplecorp: ['8136554'] }, { idInAnswer: '1' });
    expect(await verifyEmbeddedGreenhouse(app.db, ctx, opp, CAREERS, gh.sctx)).toBeNull();
  });

  it('a 404 is a no, even when its body names the job (sec on #414)', async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await company(app, a, 'examplecorp');
    const fetch = (async () => ({
      status: 404,
      headers: new Headers(),
      body: Buffer.from(JSON.stringify({ id: 8136554 })),
    })) as unknown as typeof safeFetch;
    const sctx = { fetch, log: { warn: () => {} } as never };
    expect(await verifyEmbeddedGreenhouse(app.db, ctx, opp, CAREERS, sctx)).toBeNull();
  });

  it("ignores the link's board= parameter: it is never asked, and never the token", async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await company(app, a, 'examplecorp');
    const gh = greenhouse({ examplecorp: ['8136554'], othercorp: ['8136554'] });
    const ref = await verifyEmbeddedGreenhouse(
      app.db,
      ctx,
      opp,
      `${CAREERS}&board=othercorp`,
      gh.sctx,
    );
    expect(ref?.org).toBe('examplecorp');
    expect(gh.asked.some((u) => u.includes('othercorp'))).toBe(false);
  });

  it('a non-numeric gh_jid, or a board-host link, asks nothing', async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await company(app, a, 'examplecorp');
    const gh = greenhouse({ examplecorp: ['8136554'] });
    expect(
      await verifyEmbeddedGreenhouse(
        app.db,
        ctx,
        opp,
        'https://careers.example.com/jobs?gh_jid=abc',
        gh.sctx,
      ),
    ).toBeNull();
    expect(
      await verifyEmbeddedGreenhouse(
        app.db,
        ctx,
        opp,
        'https://job-boards.greenhouse.io/examplecorp/jobs/8136554',
        gh.sctx,
      ),
    ).toBeNull();
    expect(gh.asked).toEqual([]);
  });

  it("a link on an unrelated host carrying the company's real job id still hands off to the board", async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await company(app, a, 'examplecorp');
    const gh = greenhouse({ examplecorp: ['8136554'] });
    const ref = await verifyEmbeddedGreenhouse(
      app.db,
      ctx,
      opp,
      'https://evil.example.net/apply?gh_jid=8136554',
      gh.sctx,
    );
    expect(ref?.url).toBe('https://job-boards.greenhouse.io/examplecorp/jobs/8136554');
    expect(JSON.stringify(ref)).not.toContain('evil.example.net');
  });
});

describe('resolvePostingAtsJobRef: an identity already verified costs no request', () => {
  it('keeps a verified identity for the same job without asking; asks when it is another job', async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await company(app, a, 'examplecorp');
    const verified = {
      kind: 'ats_greenhouse' as const,
      org: 'examplecorp',
      externalId: '8136554',
      url: 'https://job-boards.greenhouse.io/examplecorp/jobs/8136554',
      verifiedVia: 'gh_jid' as const,
      verifiedAt: 1,
    };
    const gh = greenhouse({ examplecorp: ['8136554', '42'] });
    expect(
      await resolvePostingAtsJobRef(
        app.db,
        ctx,
        { ...opp, atsJobRef: verified },
        'https://careers.example.com/other-page?gh_jid=8136554',
        gh.sctx,
      ),
    ).toEqual(verified);
    expect(gh.asked).toEqual([]);
    const next = await resolvePostingAtsJobRef(
      app.db,
      ctx,
      { ...opp, atsJobRef: verified },
      'https://careers.example.com/jobs?gh_jid=42',
      gh.sctx,
    );
    expect(next?.externalId).toBe('42');
    expect(gh.asked).toHaveLength(1);
  });
});

// https://github.com/bgoleno/opportun/issues/598: the boards asked are the company the save ends
// with, in a defined order, and the whole check in one save is bounded.
describe('#598: which company, which order, and how long', () => {
  const patch = (c: TestClient, id: string, payload: Record<string, unknown>) =>
    c.request({ method: 'PATCH', url: `/api/v1/opportunities/${id}`, payload });

  it("a PATCH that changes the company and the link asks the new company's boards", async () => {
    const { app, a } = await boot();
    const { ctx, opp } = await company(app, a, 'oldboard');
    await createCompany(app.db, ctx, {
      name: 'Other Corp',
      atsKind: 'ats_greenhouse',
      atsRef: 'newboard',
      atsVerifiedAt: Date.now(),
    });
    const gh = greenhouse({ newboard: ['8136554'], oldboard: ['8136554'] });
    app.jobs.services.sourceFetch = gh.sctx.fetch;
    const res = await patch(a, opp.id, { companyName: 'Other Corp', postingUrl: CAREERS });
    expect(res.statusCode, res.body).toBe(200);
    expect(gh.asked).toEqual(['https://boards-api.greenhouse.io/v1/boards/newboard/jobs/8136554']);
    expect(res.json<{ atsJobRef: { org: string } | null }>().atsJobRef?.org).toBe('newboard');
  });

  it('a PATCH to a company not yet known asks nothing: it has no board', async () => {
    const { app, a } = await boot();
    const { opp } = await company(app, a, 'oldboard');
    const gh = greenhouse({ oldboard: ['8136554'] });
    app.jobs.services.sourceFetch = gh.sctx.fetch;
    const res = await patch(a, opp.id, { companyName: 'Brand New Inc', postingUrl: CAREERS });
    expect(res.statusCode, res.body).toBe(200);
    expect(gh.asked).toEqual([]);
    expect(res.json<{ atsJobRef: unknown }>().atsJobRef).toBeNull();
  });

  it('sources and other opportunities are asked newest first, whatever order the rows were written in', async () => {
    const { app, a } = await boot();
    const { ctx, co, opp } = await company(app, a, null);
    const older = await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'oldersource' },
      companyId: co.id,
    });
    const newer = await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'newersource' },
      companyId: co.id,
    });
    await app.db
      .update(discoverySources)
      .set({ createdAt: 1000 })
      .where(eq(discoverySources.id, older.id))
      .run();
    await app.db
      .update(discoverySources)
      .set({ createdAt: 2000 })
      .where(eq(discoverySources.id, newer.id))
      .run();
    expect(await knownGreenhouseTokens(app.db, ctx, opp)).toEqual(['newersource', 'oldersource']);

    await app.db.delete(discoverySources).where(eq(discoverySources.companyId, co.id)).run();
    const sibling = async (title: string, org: string, createdAt: number) => {
      const o = await createOpportunity(app.db, ctx, {
        companyName: 'Example Corp',
        title,
        sourceKind: 'manual',
      });
      await setPostingState(app.db, ctx, o.id, {
        postingState: 'confirmed',
        postingStateDetail: null,
        atsJobRef: {
          kind: 'ats_greenhouse',
          org,
          externalId: '1',
          url: `https://job-boards.greenhouse.io/${org}/jobs/1`,
        },
      });
      await app.db.update(opportunities).set({ createdAt }).where(eq(opportunities.id, o.id)).run();
    };
    // Written oldest first: read in table order, the oldest would be asked first.
    await sibling('Designer', 'oldestboard', 1000);
    await sibling('Writer', 'middleboard', 2000);
    await sibling('Analyst', 'newestboard', 3000);
    expect(await knownGreenhouseTokens(app.db, ctx, opp)).toEqual([
      'newestboard',
      'middleboard',
      'oldestboard',
    ]);
  });

  it('the whole check has one time budget: once it is spent, nothing more is asked and there is no identity', async () => {
    const { app, a } = await boot();
    const { ctx, co, opp } = await company(app, a, 'first');
    await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'second' },
      companyId: co.id,
    });
    await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'third' },
      companyId: co.id,
    });
    // Every board hangs: an answer comes only when the request's own time limit ends it, as
    // safeFetch's timeout does. Without a limit it would hang this long.
    const timeouts: (number | undefined)[] = [];
    const fetch = (async (_url: string, init?: { timeoutMs?: number }) => {
      timeouts.push(init?.timeoutMs);
      await new Promise((r) => setTimeout(r, init?.timeoutMs ?? 400));
      throw new Error('timeout');
    }) as unknown as typeof safeFetch;
    const started = Date.now();
    const ref = await verifyEmbeddedGreenhouse(
      app.db,
      ctx,
      opp,
      CAREERS,
      { fetch, log: { warn: () => {} } as never },
      Date.now(),
      80,
    );
    expect(ref).toBeNull();
    // Well under the 1.2 s three unbounded checks take here, with room for a slow database.
    expect(Date.now() - started).toBeLessThan(700);
    // Each request gets what is left of the budget, never more, and none after it is spent.
    expect(timeouts.length).toBeGreaterThanOrEqual(1);
    expect(timeouts.every((t) => t !== undefined && t > 0 && t <= 80)).toBe(true);
    expect(timeouts.reduce<number>((sum, t) => sum + (t ?? 0), 0)).toBeLessThanOrEqual(
      80 + timeouts.length * 5,
    );
  });

  it('a save waits 5 s at most for the boards, by default', () => {
    expect(EMBED_CHECK_BUDGET_MS).toBe(5000);
  });
});
