// POST /connector/capture completes a pending lead found by its posting identity, however the
// lead stored its job id (https://github.com/bgoleno/opportun/issues/80).
//
// QA's reproduction on https://github.com/bgoleno/opportun/pull/77: a lead from a source that
// keeps its own opaque id (`mcp-job-123`) beside the site's posting URL, with a location, and
// a capture of the same job with no location (or another one, from the refine step). The
// dedupe keys differ, so only the identity in the lead's URL can match it. Before #80 the
// identity lookup compared `externalId` literally, never found the lead, and the capture made a
// second opportunity beside it.
//
// Every page, company and id here is synthetic. Nothing is fetched.
import { AiUnavailableError, LinkedInCaptureOutputSchema, runStructured } from '@opportun/ai';
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  createRun,
  ensureChannelSource,
  getResult,
  insertResult,
  listResults,
  type DiscoveryResultView,
} from '../src/repos/discovery';
import { useApi } from './api';
import { queryAll } from './db';
import { INDEED_JOB, INDEED_JOB_URL } from './fixtures/capture/indeedPages';
import { JOB as LINKEDIN_JOB } from './fixtures/capture/pages';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

type Refined = z.infer<typeof LinkedInCaptureOutputSchema>;

const PASSWORD = 'correct horse battery';
const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/** The lead's location: the capture never has this one, so the dedupe keys never agree. */
const LEAD_LOCATION = 'Remote';

/** What the refine step adds when AI is available: a location that is not the lead's. */
const MODEL_FIELDS: Refined = {
  kind: 'job',
  name: null,
  headline: null,
  company: null,
  title: null,
  location: 'Example City, EX',
  compNote: null,
  descriptionMd: null,
};

/** Each site's page, and the lead a source with its own ids would have stored for it. */
const SITES = {
  indeed: {
    page: INDEED_JOB,
    lead: {
      company: 'Example Corp',
      title: 'Senior Example Engineer',
      postingUrl: INDEED_JOB_URL,
    },
  },
  linkedin: {
    page: LINKEDIN_JOB,
    lead: {
      company: 'Initech',
      title: 'Staff Platform Engineer',
      // Not the canonical URL the capture stores: the identity is the job id, not the string.
      postingUrl: 'https://www.linkedin.com/jobs/view/3901234567/?trk=example',
    },
  },
} as const;

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
});

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
    url: '/api/v1/connector/capture',
    headers: { authorization: `Bearer ${bearer}` },
    payload: page,
  });
}

/** A pending lead with an opaque id of its own source, the site's URL and a location. */
async function seedOpaqueLead(
  app: FastifyInstance,
  c: TestClient,
  site: keyof typeof SITES,
): Promise<DiscoveryResultView> {
  const ctx = ctxOf(c);
  const source = await ensureChannelSource(app.db, ctx, 'manual');
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const posting: NormalizedPosting = {
    ...SITES[site].lead,
    location: LEAD_LOCATION,
    externalId: 'mcp-job-123',
  };
  return await insertResult(app.db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    resolution: 'needs_capture',
  });
}

const opportunityIds = async (app: FastifyInstance, c: TestClient) =>
  (
    await queryAll<{ id: string }>(app, 'SELECT id FROM opportunities WHERE user_id = ?', c.userId)
  ).map((r) => r.id);

describe('POST /connector/capture: a lead with an opaque id beside the posting URL', () => {
  it.each([
    ['indeed', 'without an AI key', false],
    ['indeed', 'with AI available', true],
    ['linkedin', 'without an AI key', false],
    ['linkedin', 'with AI available', true],
  ] as const)('%s, %s: the capture completes the lead in place', async (site, _name, ai) => {
    const { app, a } = await boot();
    if (ai) vi.mocked(runStructured).mockResolvedValue(MODEL_FIELDS);
    const lead = await seedOpaqueLead(app, a, site);
    const bearer = await token(a);

    const res = await push(app, bearer, SITES[site].page);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().resultId).toBe(lead.id);
    const stored = await getResult(app.db, ctxOf(a), lead.id);
    expect(stored).toMatchObject({
      disposition: 'accepted',
      resolution: 'full',
      opportunityId: res.json().opportunityId,
    });
    expect(await opportunityIds(app, a)).toEqual([res.json().opportunityId]);
    const pending = await listResults(app.db, ctxOf(a), {
      disposition: 'pending',
      limit: 50,
      offset: 0,
    });
    expect(pending.items).toEqual([]);

    // Capturing it again finds the same opportunity and adds nothing.
    const again = await push(app, bearer, SITES[site].page);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ opportunityId: res.json().opportunityId });
    expect(await opportunityIds(app, a)).toEqual([res.json().opportunityId]);
  });
});
