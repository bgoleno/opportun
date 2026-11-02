// POST /connector/capture with an Indeed job (https://github.com/bgoleno/opportun/issues/73).
// The LinkedIn behaviour of this route is specified by connectorCapture.test.ts, unchanged; this
// file covers what Indeed adds: a job becomes an opportunity at `interested`, a page that is not
// one posting is refused with a named reason, a pending Indeed alert lead for the same job key
// is completed rather than twinned, and the LinkedIn refine prompt never runs on an Indeed page.
// Every page and lead here is synthetic. Nothing fetches indeed.com (C-1).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AiUnavailableError, LinkedInCaptureOutputSchema, runStructured } from '@opportun/ai';
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { parseIndeedAlert } from '../src/lib/alertParsers/indeed';
import type { safeFetch } from '../src/lib/safeFetch';
import {
  createRun,
  ensureChannelSource,
  getResult,
  insertResult,
  listResults,
  type DiscoveryResultView,
} from '../src/repos/discovery';
import { getOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import { queryAll } from './db';
import {
  INDEED_JK,
  INDEED_JOB,
  INDEED_JOB_URL,
  INDEED_REFUSED,
} from './fixtures/capture/indeedPages';
import { JOB as LINKEDIN_JOB } from './fixtures/capture/pages';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

type Refined = z.infer<typeof LinkedInCaptureOutputSchema>;

const PASSWORD = 'correct horse battery';
const URL_ = '/api/v1/connector/capture';
const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/** What a model would add if it were asked: none of it may reach an Indeed capture. */
const MODEL_FIELDS: Refined = {
  kind: 'job',
  name: null,
  headline: null,
  company: 'Example Corp',
  title: 'Senior Example Engineer',
  location: 'Example City, EX',
  compNote: '$1 a year',
  descriptionMd: 'A model rewrite of the description.',
};

/** A synthetic Indeed alert digest for the fixture job, in the parser's own format. */
const ALERT_TEXT = [
  'Jobs 1-1 of 1 new jobs for example engineer',
  '',
  'Senior Example Engineer',
  'Example Corp - Remote',
  '$100,000 - $120,000 a year',
  'Lorem ipsum dolor sit amet...',
  `https://www.indeed.com/rc/clk/dl?jk=${INDEED_JK}&from=ja`,
].join('\n');

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
});

function forbidFetch(app: FastifyInstance): string[] {
  const urls: string[] = [];
  app.jobs.services.sourceFetch = (async (url: string) => {
    urls.push(url);
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof safeFetch;
  return urls;
}

async function token(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'Browser extension', scopes: ['capture:push'], password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { token: string }).token;
}

function push(app: FastifyInstance, bearer: string, page: object) {
  return app.inject({
    method: 'POST',
    url: URL_,
    headers: { authorization: `Bearer ${bearer}` },
    payload: page,
  });
}

/** A pending lead exactly as the Indeed alert parser produces it. */
async function seedAlertLead(app: FastifyInstance, c: TestClient): Promise<DiscoveryResultView> {
  const [posting] = parseIndeedAlert(ALERT_TEXT) as [NormalizedPosting];
  expect(posting).toMatchObject({ externalId: INDEED_JK, postingUrl: INDEED_JOB_URL });
  const ctx = ctxOf(c);
  const source = await ensureChannelSource(app.db, ctx, 'alert_email');
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  return await insertResult(app.db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    resolution: 'needs_capture',
  });
}

const resultsOf = async (app: FastifyInstance, c: TestClient) =>
  (await listResults(app.db, ctxOf(c), { limit: 200, offset: 0 })).items;

const opportunityIds = async (app: FastifyInstance, c: TestClient) =>
  (
    await queryAll<{ id: string }>(app, 'SELECT id FROM opportunities WHERE user_id = ?', c.userId)
  ).map((r) => r.id);

describe('POST /connector/capture: Indeed jobs', () => {
  it('an Indeed job page becomes an opportunity at interested, and nothing is fetched', async () => {
    const { app, a } = await boot();
    const fetched = forbidFetch(app);
    const res = await push(app, await token(a), INDEED_JOB);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ kind: 'job', duplicate: false, refined: false });

    const result = await getResult(app.db, ctxOf(a), body.resultId);
    expect(result).toMatchObject({
      disposition: 'accepted',
      resolution: 'full',
      sourceKind: 'extension',
      opportunityId: body.opportunityId,
    });
    expect(result.posting).toMatchObject({
      company: 'Example Corp',
      title: 'Senior Example Engineer',
      postingUrl: INDEED_JOB_URL,
      externalId: `indeed:${INDEED_JK}`,
      location: null,
      compNote: null,
    });

    const opp = await getOpportunity(app.db, ctxOf(a), body.opportunityId);
    expect(opp).toMatchObject({
      stage: 'interested',
      companyName: 'Example Corp',
      title: 'Senior Example Engineer',
      postingUrl: INDEED_JOB_URL,
    });
    expect(opp.descriptionMd).toContain('own the example platform');
    expect(fetched).toEqual([]);
  });

  it.each(Object.entries(INDEED_REFUSED))(
    '%s is refused with 422 and its reason, and creates nothing',
    async (_name, c) => {
      const { app, a } = await boot();
      const res = await push(app, await token(a), c.page);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error).toMatchObject({ code: 'unrecognized_page', reason: c.reason });
      expect(await resultsOf(app, a)).toEqual([]);
      expect(await opportunityIds(app, a)).toEqual([]);
      expect(runStructured).not.toHaveBeenCalled();
    },
  );
});

describe('POST /connector/capture: Indeed alert leads', () => {
  it.each([
    ['without an AI key', false],
    ['with AI available', true],
  ])('completes the pending alert lead for the same job key, %s', async (_name, ai) => {
    const { app, a } = await boot();
    if (ai) vi.mocked(runStructured).mockResolvedValue(MODEL_FIELDS);
    const lead = await seedAlertLead(app, a);
    const bearer = await token(a);

    const res = await push(app, bearer, INDEED_JOB);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().resultId).toBe(lead.id);
    const stored = await getResult(app.db, ctxOf(a), lead.id);
    expect(stored).toMatchObject({
      disposition: 'accepted',
      resolution: 'full',
      opportunityId: res.json().opportunityId,
    });
    expect(stored.posting.descriptionMd).toContain('own the example platform');

    // Capturing it again adds nothing.
    const again = await push(app, bearer, INDEED_JOB);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({
      opportunityId: res.json().opportunityId,
      resultId: lead.id,
    });
    expect(await opportunityIds(app, a)).toEqual([res.json().opportunityId]);
    expect((await resultsOf(app, a)).map((r) => r.id)).toEqual([lead.id]);
  });
});

describe('POST /connector/capture: no LinkedIn prompt on an Indeed page', () => {
  it('skips the refine step on Indeed even when AI is available, and runs it on LinkedIn', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValue(MODEL_FIELDS);
    const bearer = await token(a);

    const res = await push(app, bearer, INDEED_JOB);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().refined).toBe(false);
    expect(runStructured).not.toHaveBeenCalled();
    const { posting } = await getResult(app.db, ctxOf(a), res.json().resultId);
    expect(posting).toMatchObject({ location: null, compNote: null });
    expect(posting.descriptionMd).not.toContain('model rewrite');

    // The control: the same setup does run the refine step on a LinkedIn page, so the skip
    // above is the site rule, not a missing prompt or key.
    const linkedIn = await push(app, bearer, LINKEDIN_JOB);
    expect(linkedIn.statusCode, linkedIn.body).toBe(201);
    expect(runStructured).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runStructured).mock.calls[0]?.[1]).toBe('capture.linkedin');
  });
});

describe('C-1: the Indeed recognizer has no fetch path', () => {
  it('fetches nothing', async () => {
    const source = await readFile(join(__dirname, '..', 'src/lib/indeedCapture.ts'), 'utf8');
    expect(source).not.toMatch(/safeFetch|sourceFetch|\bfetch\s*\(|node:https?|undici/);
  });
});
