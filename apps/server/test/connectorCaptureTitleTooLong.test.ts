// POST /connector/capture refuses a job whose title is longer than a posting can store, by name,
// and stores nothing (https://github.com/bgoleno/opportun/issues/92). The extension words the
// `title_too_long` reason for the user; before, the refusal was `no_title_company`, worded as
// "the page had not finished loading". Every page here is synthetic.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listResults } from '../src/repos/discovery';
import { useApi } from './api';
import { queryAll } from './db';
import { INDEED_JOB, indeedText } from './fixtures/capture/indeedPages';
import { JOB as LINKEDIN_JOB } from './fixtures/capture/pages';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const PASSWORD = 'correct horse battery';
const boot = useApi();

/** A job title of 301 characters: one more than NormalizedPosting.title allows. */
const LONG_TITLE = `Staff Example Engineer ${'x'.repeat(301)}`.slice(0, 301);

const LINKEDIN_LONG = {
  ...LINKEDIN_JOB,
  title: `${LONG_TITLE} | Initech | LinkedIn`,
  text: LINKEDIN_JOB.text.replace('\nStaff Platform Engineer\n', `\n${LONG_TITLE}\n`),
};

const INDEED_LONG = {
  ...INDEED_JOB,
  text: indeedText({ title: LONG_TITLE, company: 'Example Corp' }),
};

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

describe('POST /connector/capture: a job title over 300 characters', () => {
  it.each([
    ['LinkedIn', LINKEDIN_LONG],
    ['Indeed', INDEED_LONG],
  ])('%s: refused as title_too_long, and nothing is stored', async (_site, page) => {
    const { app, a } = await boot();

    const res = await push(app, await token(a), page);

    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'unrecognized_page',
      reason: 'title_too_long',
    });
    const ctx = { userId: a.userId, isAdmin: false };
    expect((await listResults(app.db, ctx, { limit: 50, offset: 0 })).items).toEqual([]);
    expect(await queryAll(app, 'SELECT id FROM opportunities WHERE user_id = ?', a.userId)).toEqual(
      [],
    );
    // Shape check first: no model call is spent on a refused page.
    expect(runStructured).not.toHaveBeenCalled();
  });
});
