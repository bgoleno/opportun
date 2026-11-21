// The referral ranking is kept (https://github.com/bgoleno/opportun/issues/590, Brian's approval of
// 2026-11-20): re-opening the tab with nothing changed gives the earlier ranking with no model call.
// The kept ranking is keyed on everything the model is given (the contacts that can match, the
// opportunity and its company, the prompt and the model), so any change gives a fresh one with no
// separate invalidation; Re-rank forces one. "AI unavailable" and "no prompt" are as before. The
// provider is mocked; every name is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { referralRankings } from '../src/db/schema';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
// A block, not an expression: a function returned from beforeEach is run as its cleanup.
beforeEach(() => {
  vi.mocked(runStructured).mockReset();
});

interface Candidates {
  items: { contactId: string; rank: number | null; rationale: string | null }[];
  ranked: boolean;
  aiUnavailable: string | null;
  rankedAt: number | null;
}

const KEY = 'made-up-key-for-a-test';

async function addKey(c: TestClient) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label: 'anthropic', value: KEY },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

async function setup(c: TestClient) {
  const opp = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName: 'Initech', title: 'Staff Platform Engineer', sourceKind: 'manual' },
  });
  expect(opp.statusCode, opp.body).toBe(201);
  const contact = async (body: Record<string, unknown>) => {
    const res = await c.request({ method: 'POST', url: '/api/v1/network', payload: body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string };
  };
  const jane = await contact({ name: 'Jane Doe', company: 'Initech', strength: 2 });
  const lee = await contact({ name: 'Lee Park', company: 'Initech', strength: 3 });
  await contact({ name: 'Ana Ruiz', company: 'Globex' }); // can never match: not in the key
  return { oppId: (opp.json() as { id: string }).id, jane, lee, contact };
}

/** The model ranks whoever it is sent, in that order, naming the call. */
function rankAsSent() {
  let calls = 0;
  vi.mocked(runStructured).mockImplementation((async (
    _deps: unknown,
    _task: unknown,
    input: { system: string },
  ) => {
    calls += 1;
    const ids = [...input.system.matchAll(/id: ([^ |]+)/g)].map((m) => m[1]!);
    return {
      ranked: ids.map((contactId, i) => ({ contactId, rank: i + 1, rationale: `call ${calls}` })),
    };
  }) as never);
  return () => calls;
}

const get = async (c: TestClient, oppId: string, query = '') => {
  const res = await c.request({
    method: 'GET',
    url: `/api/v1/opportunities/${oppId}/referral-candidates${query}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Candidates;
};

describe('#590 criterion 1: nothing changed, no model call', () => {
  it('a second open gives the earlier ranking, with the same time', async () => {
    const { a } = await boot();
    await addKey(a);
    const { oppId } = await setup(a);
    const calls = rankAsSent();
    const first = await get(a, oppId);
    expect(first.ranked).toBe(true);
    expect(calls()).toBe(1);
    const again = await get(a, oppId);
    expect(calls()).toBe(1);
    expect(again).toEqual(first);
    expect(again.items.every((i) => i.rationale === 'call 1')).toBe(true);
    expect(again.rankedAt).toBeTypeOf('number');
  });

  it("another user's ranking of their own opportunity is theirs alone", async () => {
    const { a, b } = await boot();
    await addKey(a);
    await addKey(b);
    const mine = await setup(a);
    const theirs = await setup(b);
    const calls = rankAsSent();
    await get(a, mine.oppId);
    await get(b, theirs.oppId);
    expect(calls()).toBe(2);
  });
});

describe('#590 criterion 5: any input changed, a fresh ranking', () => {
  const changes: [
    string,
    (c: TestClient, s: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  ][] = [
    [
      'a contact that can match is edited',
      async (c, s) => {
        const res = await c.request({
          method: 'PATCH',
          url: `/api/v1/network/${s.jane.id}`,
          payload: { strength: 1 },
        });
        expect(res.statusCode, res.body).toBe(200);
      },
    ],
    [
      'a contact that can match is added',
      async (_c, s) => {
        await s.contact({ name: 'Sam Lee', company: 'Initech' });
      },
    ],
    [
      'a contact that can match is deleted',
      async (c, s) => {
        const res = await c.request({ method: 'DELETE', url: `/api/v1/network/${s.lee.id}` });
        expect(res.statusCode, res.body).toBe(204);
      },
    ],
    [
      'the opportunity is edited',
      async (c, s) => {
        const res = await c.request({
          method: 'PATCH',
          url: `/api/v1/opportunities/${s.oppId}`,
          payload: { title: 'Principal Platform Engineer' },
        });
        expect(res.statusCode, res.body).toBe(200);
      },
    ],
    [
      "the opportunity's company changes",
      async (c, s) => {
        await s.contact({ name: 'Kim Sato', company: 'Hooli' });
        const res = await c.request({
          method: 'PATCH',
          url: `/api/v1/opportunities/${s.oppId}`,
          payload: { companyName: 'Hooli' },
        });
        expect(res.statusCode, res.body).toBe(200);
      },
    ],
    [
      'the prompt changes',
      async (c) => {
        const created = await c.request({
          method: 'POST',
          url: '/api/v1/ai/prompts',
          payload: {
            taskKey: 'referral.rationale',
            body: 'Rank these.\n{{contacts_untrusted}}\n{{opportunity_untrusted}}',
          },
        });
        expect(created.statusCode, created.body).toBe(201);
        const id = (created.json() as { id: string }).id;
        const on = await c.request({ method: 'POST', url: `/api/v1/ai/prompts/${id}/activate` });
        expect(on.statusCode, on.body).toBe(200);
      },
    ],
    [
      'the model changes',
      async (c) => {
        const res = await c.request({
          method: 'PUT',
          url: '/api/v1/ai/policies/referral.rationale',
          payload: { provider: 'anthropic', model: 'claude-made-up-model', maxOutputTokens: 1500 },
        });
        expect(res.statusCode, res.body).toBe(200);
      },
    ],
  ];
  for (const [name, change] of changes) {
    it(name, async () => {
      const { a } = await boot();
      await addKey(a);
      const s = await setup(a);
      const calls = rankAsSent();
      await get(a, s.oppId);
      await get(a, s.oppId);
      expect(calls()).toBe(1);
      await change(a, s);
      const after = await get(a, s.oppId);
      expect(calls()).toBe(2);
      expect(after.ranked).toBe(true);
      // And that one is kept in turn.
      await get(a, s.oppId);
      expect(calls()).toBe(2);
    });
  }

  // Each key input on its own (the cases above can change more than one): the model alone, with
  // the rest of the policy as it was, and a new prompt version with the same text.
  it('the model alone changes', async () => {
    const { a } = await boot();
    await addKey(a);
    const s = await setup(a);
    const policy = (model: string) =>
      a.request({
        method: 'PUT',
        url: '/api/v1/ai/policies/referral.rationale',
        payload: { provider: 'anthropic', model, maxOutputTokens: 1500 },
      });
    expect((await policy('claude-made-up-one')).statusCode).toBe(200);
    const calls = rankAsSent();
    await get(a, s.oppId);
    await get(a, s.oppId);
    expect(calls()).toBe(1);
    expect((await policy('claude-made-up-two')).statusCode).toBe(200);
    await get(a, s.oppId);
    expect(calls()).toBe(2);
  });

  it('a new prompt version with the same text is a new prompt', async () => {
    const { a } = await boot();
    await addKey(a);
    const s = await setup(a);
    const calls = rankAsSent();
    await get(a, s.oppId);
    const list = await a.request({
      method: 'GET',
      url: '/api/v1/ai/prompts?taskKey=referral.rationale',
    });
    const active = (list.json() as { items: { body: string; isActive: boolean }[] }).items.find(
      (p) => p.isActive,
    )!;
    const created = await a.request({
      method: 'POST',
      url: '/api/v1/ai/prompts',
      payload: { taskKey: 'referral.rationale', body: active.body },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    expect(
      (await a.request({ method: 'POST', url: `/api/v1/ai/prompts/${id}/activate` })).statusCode,
    ).toBe(200);
    await get(a, s.oppId);
    expect(calls()).toBe(2);
  });

  it('one kept ranking per opportunity: a fresh one replaces it', async () => {
    const { app, a } = await boot();
    await addKey(a);
    const s = await setup(a);
    rankAsSent();
    await get(a, s.oppId);
    await s.contact({ name: 'Sam Lee', company: 'Initech' });
    await get(a, s.oppId);
    const rows = await app.db
      .select()
      .from(referralRankings)
      .where(eq(referralRankings.opportunityId, s.oppId))
      .all();
    expect(rows).toHaveLength(1);
  });
});

describe('#590 criterion 6: Re-rank', () => {
  it('?refresh=true calls the model though a ranking is kept, and the new one is kept', async () => {
    const { a } = await boot();
    await addKey(a);
    const s = await setup(a);
    const calls = rankAsSent();
    await get(a, s.oppId);
    const fresh = await get(a, s.oppId, '?refresh=true');
    expect(calls()).toBe(2);
    expect(fresh.items.every((i) => i.rationale === 'call 2')).toBe(true);
    const after = await get(a, s.oppId);
    expect(calls()).toBe(2);
    expect(after.items.every((i) => i.rationale === 'call 2')).toBe(true);
  });

  it('a Re-rank with AI unavailable says so, and leaves the kept ranking as it was', async () => {
    const { a } = await boot();
    await addKey(a);
    const s = await setup(a);
    const calls = rankAsSent();
    const kept = await get(a, s.oppId);
    vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('provider_error'));
    const failed = await get(a, s.oppId, '?refresh=true');
    expect(failed).toMatchObject({ ranked: false, aiUnavailable: 'provider_error' });
    expect(await get(a, s.oppId)).toEqual(kept);
    expect(calls()).toBe(1);
  });
});

describe('#590 criterion 4: AI unavailable and no prompt are as before', () => {
  it('a kept ranking with the key since removed: not ranked by AI (no key), as today', async () => {
    const { a } = await boot();
    const key = await addKey(a);
    const s = await setup(a);
    rankAsSent();
    expect((await get(a, s.oppId)).ranked).toBe(true);
    const del = await a.request({ method: 'DELETE', url: `/api/v1/secrets/${key.id}` });
    expect(del.statusCode, del.body).toBe(204);
    // What the real call answers with no key.
    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
    expect(await get(a, s.oppId)).toMatchObject({ ranked: false, aiUnavailable: 'no_key' });
  });

  it('rank=false never reads or writes a kept ranking', async () => {
    const { app, a } = await boot();
    await addKey(a);
    const s = await setup(a);
    const calls = rankAsSent();
    expect(await get(a, s.oppId, '?rank=false')).toMatchObject({ ranked: false, rankedAt: null });
    expect(calls()).toBe(0);
    expect(await app.db.select().from(referralRankings).all()).toEqual([]);
  });
});
