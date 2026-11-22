// https://github.com/bgoleno/opportun/issues/742 (qa's gap pass at c3f433d; tl on #701): the AI
// duplicate check counted a row's failures (#687) only for unexpected errors and made-up refs.
// The router reports a provider error and a malformed answer as AiUnavailableError too, and every
// AiUnavailableError was passed over as the user's setup, so a row whose call kept failing that way
// was retried every day forever. Those two are now counted toward the cap; the user's setup (no
// key, a spent budget, a rejected key) is still not.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPPORTUNITY_DEDUPE_AI_MAX_FAILURES,
  runOpportunityDedupeAi,
} from '../src/jobs/opportunityDedupeAi';
import { queryAll } from './db';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 1, 7, 15);

function createOpp(c: TestClient, companyName: string, title: string) {
  return c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName, title, sourceKind: 'manual' },
  });
}

/** One pending pair; returns its row's failures and decision as stored. */
async function onePending(app: FastifyInstance, a: TestClient) {
  vi.setSystemTime(START);
  await createOpp(a, 'Acme Robotics', 'Senior Product Manager');
  await createOpp(a, 'Acme Robotics, Inc.', 'Product Manager II');
  const row = async () =>
    (
      (await queryAll(
        app,
        'SELECT ai_failures AS failures, decision FROM opportunity_dedupe_candidates WHERE user_id = ?',
        a.userId,
      )) as { failures: number; decision: string }[]
    )[0]!;
  expect((await row()).decision).toBe('pending');
  return row;
}

/** Runs the pass `n` days in a row; returns the model calls each run made, and each outcome. */
async function runDays(app: FastifyInstance, n: number, warn = vi.fn()) {
  const calls: number[] = [];
  const outcomes: Record<string, number>[] = [];
  for (let day = 1; day <= n; day++) {
    vi.setSystemTime(START + day * DAY);
    vi.mocked(runStructured).mockClear();
    outcomes.push(
      (await runOpportunityDedupeAi(app.db, { log: { warn } })) as unknown as Record<
        string,
        number
      >,
    );
    calls.push(vi.mocked(runStructured).mock.calls.length);
  }
  return { calls, outcomes, warn };
}

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
});

describe('the AI duplicate check stops retrying a row whose call keeps failing (#742)', () => {
  it.each([
    ['a provider error', () => new AiUnavailableError('provider_error', 'HTTP 500')],
    ['a malformed answer', () => new AiUnavailableError('invalid_output', 'schema')],
  ])('%s is counted, and capped: no call after the cap', async (_, error) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { app, a } = await boot();
      const row = await onePending(app, a);
      vi.mocked(runStructured).mockRejectedValue(error());
      const { calls, outcomes, warn } = await runDays(app, OPPORTUNITY_DEDUPE_AI_MAX_FAILURES + 2);
      expect(calls).toEqual([
        ...Array.from({ length: OPPORTUNITY_DEDUPE_AI_MAX_FAILURES }, () => 1),
        0,
        0,
      ]);
      expect(await row()).toEqual({
        failures: OPPORTUNITY_DEDUPE_AI_MAX_FAILURES,
        decision: 'pending',
      });
      // The cap and its reason are recorded: in the job's result, and in one log line.
      expect(outcomes.map((o) => o.failed)).toEqual([1, 1, 1, 0, 0]);
      expect(outcomes.map((o) => o.capped)).toEqual([0, 0, 1, 0, 0]);
      const atCap = warn.mock.calls.filter(
        ([, msg]) => msg === 'opportunity dedupe AI gave up on a row at its failure cap',
      );
      expect(atCap).toHaveLength(1);
      expect(atCap[0]![0]).toMatchObject({ 'error.type': error().reason });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['no key', () => new AiUnavailableError('no_key')],
    ['a spent budget', () => new AiUnavailableError('budget_exceeded')],
    [
      'a rejected key',
      () => new AiUnavailableError('provider_error', 'HTTP 401', { keyRejected: true }),
    ],
  ])('%s is the user’s setup: not counted, and tried again each day', async (_, error) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { app, a } = await boot();
      const row = await onePending(app, a);
      vi.mocked(runStructured).mockRejectedValue(error());
      const { calls } = await runDays(app, OPPORTUNITY_DEDUPE_AI_MAX_FAILURES + 2);
      expect(calls).toEqual(
        Array.from({ length: OPPORTUNITY_DEDUPE_AI_MAX_FAILURES + 2 }, () => 1),
      );
      expect((await row()).failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failure then a success records the success', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { app, a } = await boot();
      const row = await onePending(app, a);
      vi.mocked(runStructured)
        .mockRejectedValueOnce(new AiUnavailableError('provider_error', 'HTTP 503'))
        .mockResolvedValueOnce({
          duplicateOfRef: null,
          confidence: 0.8,
          reason: 'Different team.',
        });
      const { outcomes } = await runDays(app, 2);
      expect(outcomes[0]).toMatchObject({ failed: 1, rejected: 0 });
      expect(outcomes[1]).toMatchObject({ failed: 0, rejected: 1 });
      expect((await row()).decision).toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });
});
