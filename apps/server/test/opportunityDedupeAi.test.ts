// Issue #94's second PR: the AI consumer for 'pending' rows the heuristic
// (../src/repos/opportunityDedupe.ts) could not resolve on its own. runStructured is mocked
// the same way discoveryRank.test.ts mocks it: the real router, prompt rendering and budget
// check still run, only the model call itself is faked.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { opportunityDedupeCandidates } from '../src/db/schema';
import {
  OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN,
  runOpportunityDedupeAi,
} from '../src/jobs/opportunityDedupeAi';
import { queryAll, queryOne } from './db';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const log = { warn: () => undefined };

beforeEach(() => vi.mocked(runStructured).mockReset());

function createOpp(c: TestClient, companyName: string, title: string) {
  return c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName, title, sourceKind: 'manual' },
  });
}

/** Seeds exactly one 'pending' row via the real heuristic (same fixture shape as
 *  opportunities.test.ts's mid-confidence test) and returns its stored pair, ordered the way
 *  the table itself orders it. */
async function seedPending(
  app: FastifyInstance,
  a: TestClient,
): Promise<{ trackedId: string; candidateId: string }> {
  await createOpp(a, 'Acme Robotics', 'Senior Product Manager');
  await createOpp(a, 'Acme Robotics, Inc.', 'Product Manager II');
  const row = (await queryOne(
    app,
    'SELECT opportunity_id_a AS a, opportunity_id_b AS b FROM opportunity_dedupe_candidates WHERE user_id = ?',
    a.userId,
  )) as { a: string; b: string };
  return { trackedId: row.a, candidateId: row.b };
}

async function decisionRow(app: FastifyInstance, userId: string) {
  return (await queryOne(
    app,
    'SELECT decision, decided_by AS "decidedBy" FROM opportunity_dedupe_candidates WHERE user_id = ?',
    userId,
  )) as { decision: string; decidedBy: string | null };
}

async function possibleDuplicateOf(app: FastifyInstance, id: string): Promise<string | null> {
  const row = (await queryOne(
    app,
    'SELECT possible_duplicate_of AS v FROM opportunities WHERE id = ?',
    id,
  )) as { v: string | null };
  return row.v;
}

describe('opportunity.dedupe AI pass', () => {
  it('confirms a pending pair when the model echoes the tracked ref', async () => {
    const { app, a } = await boot();
    const { trackedId, candidateId } = await seedPending(app, a);
    vi.mocked(runStructured).mockResolvedValueOnce({
      duplicateOfRef: trackedId,
      confidence: 0.92,
      reason: 'Same role, same company, title variant.',
    });

    const outcome = await runOpportunityDedupeAi(app.db, { log });

    expect(outcome).toEqual({ scanned: 1, confirmed: 1, rejected: 0, failed: 0, capped: 0 });
    expect(vi.mocked(runStructured)).toHaveBeenCalledTimes(1);
    const [, task] = vi.mocked(runStructured).mock.calls[0]!;
    expect(task).toBe('opportunity.dedupe');
    expect(await decisionRow(app, a.userId)).toEqual({ decision: 'confirmed', decidedBy: 'ai' });
    expect(await possibleDuplicateOf(app, candidateId)).toBe(trackedId);
  });

  it('rejects a pending pair when the model returns no match', async () => {
    const { app, a } = await boot();
    const { candidateId } = await seedPending(app, a);
    vi.mocked(runStructured).mockResolvedValueOnce({
      duplicateOfRef: null,
      confidence: 0.8,
      reason: 'Different team.',
    });

    const outcome = await runOpportunityDedupeAi(app.db, { log });

    expect(outcome).toEqual({ scanned: 1, confirmed: 0, rejected: 1, failed: 0, capped: 0 });
    expect(await decisionRow(app, a.userId)).toEqual({ decision: 'rejected', decidedBy: 'ai' });
    expect(await possibleDuplicateOf(app, candidateId)).toBeNull();
  });

  it('leaves a row pending on an unrecognized ref, rather than trusting it either way', async () => {
    const { app, a } = await boot();
    await seedPending(app, a);
    vi.mocked(runStructured).mockResolvedValueOnce({
      duplicateOfRef: 'not-a-sent-id',
      confidence: 0.9,
      reason: 'Hallucinated.',
    });

    const outcome = await runOpportunityDedupeAi(app.db, { log });

    expect(outcome).toEqual({ scanned: 1, confirmed: 0, rejected: 0, failed: 1, capped: 0 });
    expect((await decisionRow(app, a.userId)).decision).toBe('pending');
  });

  it('leaves a row pending when the AI is unavailable', async () => {
    const { app, a } = await boot();
    await seedPending(app, a);
    vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('budget_exceeded'));

    const outcome = await runOpportunityDedupeAi(app.db, { log });

    expect(outcome).toEqual({ scanned: 1, confirmed: 0, rejected: 0, failed: 0, capped: 0 });
    expect((await decisionRow(app, a.userId)).decision).toBe('pending');
  });

  it('never calls the model for an already-decided row', async () => {
    const { app, a } = await boot();
    await seedPending(app, a);
    await app.db
      .update(opportunityDedupeCandidates)
      .set({ decision: 'rejected', decidedBy: 'user' })
      .where(eq(opportunityDedupeCandidates.userId, a.userId))
      .run();

    const outcome = await runOpportunityDedupeAi(app.db, { log });

    expect(outcome).toEqual({ scanned: 0, confirmed: 0, rejected: 0, failed: 0, capped: 0 });
    expect(vi.mocked(runStructured)).not.toHaveBeenCalled();
  });

  it('caps the number of pending rows processed per run, leaving the rest for tomorrow', async () => {
    const { app, a } = await boot();
    const n = OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN + 3;
    for (let i = 0; i < n; i++) {
      await createOpp(a, `Acme ${i} Robotics`, `Senior Product Manager ${i}`);
      await createOpp(a, `Acme ${i} Robotics, Inc.`, `Product Manager II ${i}`);
    }
    vi.mocked(runStructured).mockResolvedValue({
      duplicateOfRef: null,
      confidence: 0.7,
      reason: 'Different team.',
    });

    const outcome = await runOpportunityDedupeAi(app.db, { log });

    expect(outcome).toEqual({
      scanned: OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN,
      confirmed: 0,
      rejected: OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN,
      failed: 0,
      capped: 0,
    });
    const stillPending = (await queryAll(
      app,
      "SELECT id FROM opportunity_dedupe_candidates WHERE user_id = ? AND decision = 'pending'",
      a.userId,
    )) as { id: string }[];
    expect(stillPending).toHaveLength(3);
  });
});

// https://github.com/bgoleno/opportun/issues/593: a sweep took the 25 oldest pending rows, so rows
// that stay pending (the AI unavailable for their user) came first on every run and a newer pair
// was never judged; and one unexpected model error ended the whole batch.
describe('opportunity.dedupe AI pass: rows that stay pending (#593)', () => {
  const DAY = 86_400_000;

  it('a newer pending pair is decided within two runs behind a full batch of rows that stay pending', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { app, a, b } = await boot();
      let now = Date.UTC(2026, 10, 1, 7, 15);
      vi.setSystemTime(now);
      // b's pairs first: OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN of them, the AI never available for b.
      for (let i = 0; i < OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN; i++) {
        await createOpp(b, `Stuckco ${i} Robotics`, `Senior Product Manager ${i}`);
        await createOpp(b, `Stuckco ${i} Robotics, Inc.`, `Product Manager II ${i}`);
      }
      vi.setSystemTime((now += 60_000));
      await seedPending(app, a);
      vi.mocked(runStructured).mockImplementation(async (...args: unknown[]) => {
        const system = (args[2] as { system?: string } | undefined)?.system ?? '';
        if (system.includes('Stuckco')) throw new AiUnavailableError('no_key');
        return { duplicateOfRef: null, confidence: 0.8, reason: 'Different team.' } as never;
      });

      const calls: number[] = [];
      for (let run = 0; run < 2; run++) {
        vi.setSystemTime((now += DAY));
        vi.mocked(runStructured).mockClear();
        await runOpportunityDedupeAi(app.db, { log });
        calls.push(vi.mocked(runStructured).mock.calls.length);
      }

      expect(await decisionRow(app, a.userId)).toEqual({ decision: 'rejected', decidedBy: 'ai' });
      // No run asks the model about more rows than before.
      for (const n of calls) expect(n).toBeLessThanOrEqual(OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one row's unexpected error leaves that row pending and the rest of the batch goes on", async () => {
    const { app, a } = await boot();
    await createOpp(a, 'Acme Robotics', 'Senior Product Manager');
    await createOpp(a, 'Acme Robotics, Inc.', 'Product Manager II');
    await createOpp(a, 'Acme 2 Robotics', 'Senior Product Manager 2');
    await createOpp(a, 'Acme 2 Robotics, Inc.', 'Product Manager II 2');
    const pending = async () =>
      (await queryAll(
        app,
        "SELECT id FROM opportunity_dedupe_candidates WHERE user_id = ? AND decision = 'pending'",
        a.userId,
      )) as { id: string }[];
    expect(await pending()).toHaveLength(2);
    vi.mocked(runStructured)
      .mockRejectedValueOnce(new Error('the provider answered something unexpected'))
      .mockResolvedValueOnce({ duplicateOfRef: null, confidence: 0.8, reason: 'Different.' });

    const outcome = await runOpportunityDedupeAi(app.db, { log });

    expect(outcome).toEqual({ scanned: 2, confirmed: 0, rejected: 1, failed: 1, capped: 0 });
    expect(await pending()).toHaveLength(1);
  });
});
