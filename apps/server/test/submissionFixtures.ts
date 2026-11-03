// A submitted application, made through the real routes (draft, review, handoff, "I submitted
// it"), for tests of what happens after: confirmation matching (#119). The helpers in
// submissionOutcome.test.ts build the same thing step by step for that file's own checks.
import { newId, type AtsJobRef } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { companies, opportunities, resumes } from '../src/db/schema';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import type { TestClient } from './isolation';

export const api = (
  c: TestClient,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) => c.request({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });

/** A Greenhouse requisition of its own (a random job id), at the given board. */
export function requisition(org = 'examplecorp'): AtsJobRef {
  const externalId = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
  return {
    kind: 'ats_greenhouse',
    org,
    externalId,
    url: `https://boards.greenhouse.io/${org}/jobs/${externalId}`,
  };
}

export interface Submitted {
  id: string;
  oppId: string;
  companyId: string;
  ats: AtsJobRef;
  submittedAt: number;
}

/**
 * One opportunity at `company` (with `domain` as its known domain, or none), for `title`, taken
 * through to `submitted` with "I submitted it" at `submittedAt` (default now), stage unticked.
 */
export async function submittedAttempt(
  app: FastifyInstance,
  c: TestClient,
  opts: {
    company?: string;
    domain?: string | null;
    title?: string;
    ats?: AtsJobRef;
    submittedAt?: number;
  } = {},
): Promise<Submitted> {
  const ctx = { userId: c.userId, isAdmin: false };
  const ats = opts.ats ?? requisition();
  const opp = await createOpportunity(app.db, ctx, {
    companyName: opts.company ?? 'Example Corp',
    title: opts.title ?? 'Senior Platform Engineer',
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({ stage: 'interested', atsJobRef: ats, postingState: 'confirmed' })
    .where(eq(opportunities.id, opp.id))
    .run();
  const companyId = (await app.db
    .select({ id: opportunities.companyId })
    .from(opportunities)
    .where(eq(opportunities.id, opp.id))
    .get())!.id;
  const domain = opts.domain === undefined ? 'examplecorp.example' : opts.domain;
  await app.db.update(companies).set({ domain }).where(eq(companies.id, companyId)).run();
  const resume = await insertResume(app.db, ctx, {
    kind: 'base',
    title: 'Example Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, resume.id)).run();
  const created = await api(c, 'POST', `/opportunities/${opp.id}/submissions`, {
    idempotencyKey: crypto.randomUUID(),
    resumeId: resume.id,
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ id: string }>().id;
  await app.jobs.drain(); // the local file's snapshot settles as unsupported, which review allows
  const current = await api(c, 'GET', `/submissions/${id}`);
  const reviewed = await api(c, 'POST', `/submissions/${id}/review`, {
    reviewDigest: current.json<{ reviewDigest: string }>().reviewDigest,
    acknowledged: true,
  });
  expect(reviewed.statusCode, reviewed.body).toBe(200);
  const handed = await api(c, 'POST', `/submissions/${id}/handoff`, {});
  expect(handed.statusCode, handed.body).toBe(200);
  const submittedAt = opts.submittedAt ?? Date.now();
  const attested = await api(c, 'POST', `/submissions/${id}/attest`, {
    moveToApplied: false,
    submittedAt,
  });
  expect(attested.statusCode, attested.body).toBe(200);
  return { id, oppId: opp.id, companyId, ats, submittedAt };
}
