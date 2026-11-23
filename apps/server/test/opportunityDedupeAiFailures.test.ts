// https://github.com/bgoleno/opportun/issues/687 (qa's third pass, on #644): the AI duplicate check
// caught errors around the model call only. A failure elsewhere for one row (its decision write,
// here) ended the whole pass, and the row was not passed over, so it came first again on every
// daily run and blocked the rows behind it. A row that keeps failing also cost one model call a
// day, forever. The decision write is wrapped here so a test can refuse it for one pair.
import { runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPPORTUNITY_DEDUPE_AI_MAX_FAILURES,
  runOpportunityDedupeAi,
} from '../src/jobs/opportunityDedupeAi';
import { resolveDedupeCandidateByAi } from '../src/repos/opportunityDedupe';
import { queryAll } from './db';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});
vi.mock('../src/repos/opportunityDedupe', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/repos/opportunityDedupe')>();
  return { ...real, resolveDedupeCandidateByAi: vi.fn(real.resolveDedupeCandidateByAi) };
});

const boot = useApi();
const log = { warn: () => undefined };
const DAY = 86_400_000;

let realResolve: typeof resolveDedupeCandidateByAi;
beforeEach(async () => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockResolvedValue({
    duplicateOfRef: null,
    confidence: 0.8,
    reason: 'Different team.',
  });
  const real = await vi.importActual<typeof import('../src/repos/opportunityDedupe')>(
    '../src/repos/opportunityDedupe',
  );
  realResolve = real.resolveDedupeCandidateByAi;
  vi.mocked(resolveDedupeCandidateByAi).mockReset();
  vi.mocked(resolveDedupeCandidateByAi).mockImplementation(realResolve);
});

function createOpp(c: TestClient, companyName: string, title: string) {
  return c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName, title, sourceKind: 'manual' },
  });
}

/** Three pending pairs, the oldest first; returns each pair's tracked id, oldest first. */
async function threePending(app: FastifyInstance, a: TestClient, start: number) {
  for (let i = 0; i < 3; i++) {
    vi.setSystemTime(start + i * 60_000);
    await createOpp(a, `Acme ${i} Robotics`, `Senior Product Manager ${i}`);
    await createOpp(a, `Acme ${i} Robotics, Inc.`, `Product Manager II ${i}`);
  }
  const rows = (await queryAll(
    app,
    "SELECT opportunity_id_a AS a FROM opportunity_dedupe_candidates WHERE user_id = ? AND decision = 'pending' ORDER BY created_at",
    a.userId,
  )) as { a: string }[];
  expect(rows).toHaveLength(3);
  return rows.map((r) => r.a);
}

const pendingOf = async (app: FastifyInstance, a: TestClient) =>
  (
    (await queryAll(
      app,
      "SELECT opportunity_id_a AS a FROM opportunity_dedupe_candidates WHERE user_id = ? AND decision = 'pending'",
      a.userId,
    )) as { a: string }[]
  ).map((r) => r.a);

/** Refuses the decision write for the pair whose tracked side is `trackedId`, every time. */
function refuseWriteFor(trackedId: string) {
  vi.mocked(resolveDedupeCandidateByAi).mockImplementation(async (...args) => {
    if (args[2] === trackedId) throw new Error('the database refused the write');
    return realResolve(...args);
  });
}

/** Model calls made about the pair whose tracked side is `trackedId`. */
const callsFor = (trackedId: string) =>
  vi
    .mocked(runStructured)
    .mock.calls.filter((c) => (c[2] as { system: string }).system.includes(trackedId)).length;

describe('the AI duplicate check, when one row fails outside the model call (#687)', () => {
  it('a refused decision write for the oldest row leaves it pending, and the pass decides the others', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { app, a } = await boot();
      const start = Date.UTC(2026, 10, 1, 7, 15);
      const [oldest, ...rest] = await threePending(app, a, start);
      refuseWriteFor(oldest!);
      vi.setSystemTime(start + DAY);
      const outcome = await runOpportunityDedupeAi(app.db, { log });
      expect(outcome).toMatchObject({ rejected: 2 });
      expect(await pendingOf(app, a)).toEqual([oldest]);
      for (const id of rest) expect(await pendingOf(app, a)).not.toContain(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`a row that keeps failing is not sent to the model again after ${OPPORTUNITY_DEDUPE_AI_MAX_FAILURES} runs`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { app, a } = await boot();
      const start = Date.UTC(2026, 10, 1, 7, 15);
      const [oldest] = await threePending(app, a, start);
      refuseWriteFor(oldest!);
      const perRun: number[] = [];
      for (let run = 1; run <= OPPORTUNITY_DEDUPE_AI_MAX_FAILURES + 2; run++) {
        vi.setSystemTime(start + run * DAY);
        vi.mocked(runStructured).mockClear();
        await runOpportunityDedupeAi(app.db, { log });
        perRun.push(callsFor(oldest!));
      }
      // One call a run until the cap, then none: it no longer costs a call a day.
      expect(perRun).toEqual([
        ...Array.from({ length: OPPORTUNITY_DEDUPE_AI_MAX_FAILURES }, () => 1),
        0,
        0,
      ]);
      // Still pending, for the user to decide.
      expect(await pendingOf(app, a)).toEqual([oldest]);
    } finally {
      vi.useRealTimers();
    }
  });
});
