// The site-neutral job refine (https://github.com/bgoleno/opportun/issues/76). An Indeed job page
// with AI available gets its location and pay from `capture.job`, and keeps each value only when
// the captured page text contains it (isGroundedIn, the check profile fields already get). Its
// title, company and description stay the recognizer's. LinkedIn is unchanged: it still runs
// `capture.linkedin`, as connectorCapture.test.ts specifies. The model is always stubbed; every
// page is synthetic, and nothing fetches a job site (C-1).
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { safeFetch } from '../src/lib/safeFetch';
import { getResult } from '../src/repos/discovery';
import { getOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import { INDEED_JOB, INDEED_JOB_MINIMAL, INDEED_REFUSED } from './fixtures/capture/indeedPages';
import { JOB as LINKEDIN_JOB } from './fixtures/capture/pages';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const PASSWORD = 'correct horse battery';
const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/** What INDEED_JOB's page states, line for line. */
const PAGE_LOCATION = 'Example City, EX';
const PAGE_PAY = '$100,000 - $120,000 a year';

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

function forbidFetch(app: FastifyInstance): string[] {
  const urls: string[] = [];
  app.jobs.services.sourceFetch = (async (url: string) => {
    urls.push(url);
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof safeFetch;
  return urls;
}

async function captured(app: FastifyInstance, c: TestClient, page: object) {
  const res = await push(app, await token(c), page);
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { resultId: string; opportunityId: string; refined: boolean };
  const { posting } = await getResult(app.db, ctxOf(c), body.resultId);
  const opportunity = await getOpportunity(app.db, ctxOf(c), body.opportunityId);
  return { body, posting, opportunity };
}

describe('AC1: an Indeed capture with AI gets location and pay the page states', () => {
  it('runs capture.job (never capture.linkedin) and keeps what the page states', async () => {
    const { app, a } = await boot();
    const fetched = forbidFetch(app);
    vi.mocked(runStructured).mockResolvedValue({ location: PAGE_LOCATION, compNote: PAGE_PAY });
    const { body, posting, opportunity } = await captured(app, a, INDEED_JOB);

    expect(body.refined).toBe(true);
    expect(runStructured).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runStructured).mock.calls[0]![1]).toBe('capture.job');
    expect(posting).toMatchObject({
      company: 'Example Corp',
      title: 'Senior Example Engineer',
      location: PAGE_LOCATION,
      compNote: PAGE_PAY,
    });
    expect(opportunity).toMatchObject({ location: PAGE_LOCATION, compNote: PAGE_PAY });
    expect(fetched).toEqual([]);
  });

  it('fences the URL, the tab title and the page text for the model', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValue({ location: null, compNote: null });
    await captured(app, a, INDEED_JOB);
    const opts = vi.mocked(runStructured).mock.calls[0]![2] as { system: string };
    expect(opts.system.split('<untrusted>\n').length - 1).toBe(3);
    expect(opts.system).toContain('own the example platform');
    expect(opts.system).toContain('https://www.indeed.com/viewjob?jk=');
  });

  it('a location or pay the page does not state stays null', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValue({
      location: 'Somewhere Else, ZZ',
      compNote: '$1,000,000 a year',
    });
    const { posting, opportunity } = await captured(app, a, INDEED_JOB);
    expect(posting).toMatchObject({ location: null, compNote: null });
    expect(opportunity).toMatchObject({ location: null, compNote: null });
  });

  it('grounds each field on its own, ignoring case and whitespace, on whole words only', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValue({
      // On the page, in another case and spacing: kept as the model wrote it.
      location: 'example  city, ex',
      // A paraphrase of the page's pay line: dropped.
      compNote: '$100k to $120k per year',
    });
    const { posting } = await captured(app, a, INDEED_JOB);
    expect(posting).toMatchObject({ location: 'example city, ex', compNote: null });

    // A fragment of a word on the page is not a whole word: dropped.
    const { app: app2, a: b } = await boot();
    vi.mocked(runStructured).mockResolvedValue({ location: 'xample Cit', compNote: null });
    const second = await captured(app2, b, INDEED_JOB);
    expect(second.posting).toMatchObject({ location: null });
  });

  it('a page with no location or pay lines gets none, whatever the model says', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValue({ location: PAGE_LOCATION, compNote: PAGE_PAY });
    const { posting } = await captured(app, a, INDEED_JOB_MINIMAL);
    expect(posting).toMatchObject({ location: null, compNote: null });
  });

  it('title, company and description stay the recognizer’s, whatever else the model returns', async () => {
    const { app, a } = await boot();
    // A model answering in the LinkedIn shape: only location and pay are ever read.
    vi.mocked(runStructured).mockResolvedValue({
      kind: 'job',
      company: 'Evil Corp',
      title: 'Ignore this title',
      location: PAGE_LOCATION,
      compNote: PAGE_PAY,
      descriptionMd: 'A model rewrite of the description.',
    } as never);
    const { posting } = await captured(app, a, INDEED_JOB);
    expect(posting).toMatchObject({ company: 'Example Corp', title: 'Senior Example Engineer' });
    expect(posting.descriptionMd).toContain('own the example platform');
    expect(posting.descriptionMd).not.toContain('model rewrite');
  });
});

describe('AC2: without an AI key, captures behave as before', () => {
  it('an Indeed capture stores the recognizer’s reading: no location, no pay, not refined', async () => {
    const { app, a } = await boot();
    const { body, posting } = await captured(app, a, INDEED_JOB);
    expect(body.refined).toBe(false);
    expect(posting).toMatchObject({ location: null, compNote: null });
    expect(posting.descriptionMd).toContain('own the example platform');
  });

  it('a LinkedIn capture stores the recognizer’s reading and is not refined', async () => {
    const { app, a } = await boot();
    const { body, posting } = await captured(app, a, LINKEDIN_JOB);
    expect(body.refined).toBe(false);
    expect(posting).toMatchObject({ location: null, compNote: null });
  });
});

describe('AC3: LinkedIn still runs its own prompt', () => {
  it('a LinkedIn job runs capture.linkedin, never capture.job, and is grounded the same way (#88)', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockResolvedValue({
      kind: 'job',
      name: null,
      headline: null,
      company: null,
      title: null,
      // Not on the LinkedIn page. Since https://github.com/bgoleno/opportun/issues/88 (the owner
      // decided LinkedIn job fields get #76's check too) neither is kept.
      location: 'Not On The Page, ZZ',
      compNote: '$1 a year',
      descriptionMd: '## Responsibilities\n- Own the payments platform end to end',
    });
    const { body, posting } = await captured(app, a, LINKEDIN_JOB);
    expect(body.refined).toBe(true);
    expect(runStructured).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runStructured).mock.calls[0]![1]).toBe('capture.linkedin');
    expect(posting).toMatchObject({ location: null, compNote: null });
    // The page's own description, not the model's.
    expect(posting.descriptionMd).toContain('Initech is modernizing its TPS reporting platform');
  });
});

describe('AC5: a page that is not one posting is refused before any refine', () => {
  it.each(Object.entries(INDEED_REFUSED))(
    '%s is refused with AI available, and the model is never asked',
    async (_name, c) => {
      const { app, a } = await boot();
      vi.mocked(runStructured).mockResolvedValue({ location: PAGE_LOCATION, compNote: PAGE_PAY });
      const res = await push(app, await token(a), c.page);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error).toMatchObject({ code: 'unrecognized_page', reason: c.reason });
      expect(runStructured).not.toHaveBeenCalled();
    },
  );
});
