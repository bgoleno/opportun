// Stage 2, the gate model (spec D1). Two things this file pins, because they are the reasons
// the gate is allowed to exist at all:
//
//   1. WHO it sees. Only a message Stage 1 passed on a positive signal. A message with no job
//      signal is dropped by rule 7 and is never a question for a model, and a pass the user
//      asked for (their allow list, their own address) is not the model's to overrule.
//   2. WHAT it may do when it is broken. Pass, in every failure mode. A gate that drops mail
//      when the provider is down silently swallows recruiter email.
//
// The model's free-text `reason` never leaves this module: the outcome carries a code. That the
// stored row holds no part of it is pinned where the row is written, in the ingest tests.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prompts } from '../src/db/schema';
import type { TriageRule, TriageVerdict } from '../src/lib/mailTriage';
import { GATE_INPUT_CHARS, gateApplies, gateMessage } from '../src/lib/triageGate';
import type { TriageOutput } from '../src/lib/triageGate';
import { useApi } from './api';
import type { TestClient } from './isolation';

// The router is mocked: each test decides what the gate "returns".
vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
});

const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const passedOn = (rule: TriageRule): TriageVerdict => ({
  decision: 'pass',
  matchedRule: rule,
  ruleId: null,
  pattern: null,
});

function gateReturns(output: Partial<TriageOutput>): void {
  vi.mocked(runStructured).mockResolvedValueOnce({
    jobRelated: true,
    reason: 'looks like recruiter outreach',
    confidence: 0.9,
    ...output,
  } satisfies TriageOutput);
}

const message = (over: Partial<Parameters<typeof gateMessage>[2]> = {}) => ({
  from: 'billing@clinic-a.example',
  subject: 'Your appointment',
  body: 'Please bring your insurance card.',
  ...over,
});

describe('gateApplies', () => {
  it('consults the gate for a positive Stage 1 pass', () => {
    expect(gateApplies(passedOn('job_sender'), false)).toBe(true);
    expect(gateApplies(passedOn('vocabulary'), false)).toBe(true);
    expect(gateApplies(passedOn('thread'), false)).toBe(true);
  });

  it('bypasses the gate for a pass the model must not overrule', () => {
    for (const rule of ['allow_list', 'own_address', 'unreadable_sender', 'none'] as const) {
      expect(gateApplies(passedOn(rule), false), rule).toBe(false);
    }
  });

  it('bypasses the gate for an alert digest sender', () => {
    expect(gateApplies(passedOn('job_sender'), true)).toBe(false);
  });

  it('is never consulted about a message Stage 1 already dropped', () => {
    const dropped: TriageVerdict = {
      decision: 'drop',
      matchedRule: 'deny_list',
      ruleId: null,
      pattern: null,
    };
    expect(gateApplies(dropped, false)).toBe(false);
  });
});

describe('gateMessage', () => {
  it('drops a confident not-job-related verdict, carrying a code and not the model text', async () => {
    const { app, a } = await boot();
    gateReturns({ jobRelated: false, confidence: 0.92, reason: 'dental appointment reminder' });

    // toEqual on the whole object is the assertion: no field smuggles the model's reason out.
    expect(await gateMessage(app.db, ctxOf(a), message())).toEqual({
      decision: 'drop',
      why: 'not_job_related',
    });
  });

  it('passes a job-related verdict', async () => {
    const { app, a } = await boot();
    gateReturns({ jobRelated: true, confidence: 0.88 });

    expect(await gateMessage(app.db, ctxOf(a), message())).toEqual({
      decision: 'pass',
      why: 'job_related',
    });
  });

  it('passes when the model is not confident enough to drop', async () => {
    const { app, a } = await boot();
    gateReturns({ jobRelated: false, confidence: 0.49 });

    expect(await gateMessage(app.db, ctxOf(a), message())).toEqual({
      decision: 'pass',
      why: 'low_confidence',
    });
  });

  it('passes when no API key is configured', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValueOnce(new AiUnavailableError('no_key'));

    expect(await gateMessage(app.db, ctxOf(a), message())).toEqual({
      decision: 'pass',
      why: 'unavailable',
    });
  });

  it('passes when the provider throws', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValueOnce(new Error('502 Bad Gateway'));

    expect(await gateMessage(app.db, ctxOf(a), message())).toEqual({
      decision: 'pass',
      why: 'unavailable',
    });
  });

  it('passes on an answer it cannot read at all', async () => {
    // Not a hypothetical: it is what a mocked or half-upgraded router hands back, and reading
    // `.confidence` off it used to throw out of gateMessage and out of ingest with it, which
    // failed the whole delivery rather than the gate.
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValueOnce(undefined as never);

    expect(await gateMessage(app.db, ctxOf(a), message())).toEqual({
      decision: 'pass',
      why: 'unavailable',
    });
  });

  it('passes without calling the provider when no triage prompt is active', async () => {
    const { app, a } = await boot();
    await app.db.delete(prompts).where(eq(prompts.taskKey, 'comms.triage')).run();

    expect(await gateMessage(app.db, ctxOf(a), message())).toEqual({
      decision: 'pass',
      why: 'no_prompt',
    });
    expect(runStructured).not.toHaveBeenCalled();
  });

  it('sends the sender, the subject and at most the first GATE_INPUT_CHARS of the body', async () => {
    const { app, a } = await boot();
    const head = 'a'.repeat(GATE_INPUT_CHARS);
    const body = `${head}SECRET-DIAGNOSIS${'b'.repeat(1_000)}`;
    gateReturns({ jobRelated: true });

    await gateMessage(
      app.db,
      ctxOf(a),
      message({ from: 'billing@clinic-a.example', subject: 'Visit summary', body }),
    );

    const call = vi.mocked(runStructured).mock.calls[0];
    expect(call).toBeDefined();
    const system = call![2].system;
    expect(system).toContain('billing@clinic-a.example');
    expect(system).toContain('Visit summary');
    expect(system).toContain(head);
    expect(system).not.toContain('SECRET-DIAGNOSIS');
  });
});
