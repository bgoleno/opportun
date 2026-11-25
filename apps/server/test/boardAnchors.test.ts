// A board's listing as title+url anchors, for enrichment, read through its site module
// (https://github.com/bgoleno/opportun/issues/769). The requests and what is read are unchanged.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boardAnchors } from '../src/jobs/opportunityEnrich';
import type { safeFetch } from '../src/lib/safeFetch';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ats/${name}`, import.meta.url), 'utf8');

function recording(status: number, body: string) {
  const calls: { url: string; allowHosts: readonly unknown[] }[] = [];
  const fetch = (async (url, opts) => {
    calls.push({ url: String(url), allowHosts: opts.allowHosts });
    return { status, headers: new Headers(), body: Buffer.from(body) };
  }) as typeof safeFetch;
  return { calls, fetch };
}

describe('boardAnchors', () => {
  it.each([
    [
      'ats_greenhouse',
      'greenhouse.json',
      'https://boards-api.greenhouse.io/v1/boards/initech/jobs',
      'boards-api.greenhouse.io',
    ],
    [
      'ats_lever',
      'lever.json',
      'https://api.lever.co/v0/postings/initech?mode=json',
      'api.lever.co',
    ],
    [
      'ats_ashby',
      'ashby.json',
      'https://api.ashbyhq.com/posting-api/job-board/initech',
      'api.ashbyhq.com',
    ],
  ])('%s: one request, to the API host only', async (kind, file, url, host) => {
    const { calls, fetch } = recording(200, fixture(file));
    const anchors = await boardAnchors(fetch, { kind, slug: 'initech' });
    expect(calls).toEqual([{ url, allowHosts: [{ exact: host }] }]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(a.url).toMatch(/^https:\/\//);
  });

  it('keeps a job Ashby marks unlisted, which the board listing leaves out', async () => {
    const { fetch } = recording(
      200,
      '{"jobs":[{"title":"Hidden","jobUrl":"https://jobs.ashbyhq.com/initech/1","isListed":false}]}',
    );
    expect(await boardAnchors(fetch, { kind: 'ats_ashby', slug: 'initech' })).toEqual([
      { url: 'https://jobs.ashbyhq.com/initech/1', text: 'Hidden' },
    ]);
  });

  it.each(['ats_greenhouse', 'ats_lever', 'ats_ashby'])(
    '%s: no anchors, and no request, for a slug no board has',
    async (kind) => {
      const { calls, fetch } = recording(200, '[]');
      expect(await boardAnchors(fetch, { kind, slug: '../x' })).toEqual([]);
      expect(calls).toEqual([]);
    },
  );

  it('none for Workday or an unknown kind, and no request', async () => {
    const { calls, fetch } = recording(200, '[]');
    expect(await boardAnchors(fetch, { kind: 'ats_workday', slug: 'initech/Site' })).toEqual([]);
    expect(await boardAnchors(fetch, { kind: 'mcp', slug: 'initech' })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    [404, '{}'],
    [503, '{}'],
    [200, 'not json'],
    [200, '{"jobs":[null]}'],
    [200, '{"jobs":[{"title":1,"absolute_url":"https://x.example"}]}'],
  ])('none when the board answers %s %s', async (status, body) => {
    const { fetch } = recording(status, body);
    expect(await boardAnchors(fetch, { kind: 'ats_greenhouse', slug: 'initech' })).toEqual([]);
  });
});
