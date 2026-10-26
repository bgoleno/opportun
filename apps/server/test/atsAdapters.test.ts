// ATS source adapters (Task 9, FR-D1): Greenhouse, Lever and Ashby boards mapped to
// NormalizedPosting from recorded-shape fixtures, fetched only through safeFetch with exactly the
// adapter's API host allowed. An unknown org is a SourceConfigError: the run fails once, the
// source shows the error, and the runner does not retry it.
import { readFileSync } from 'node:fs';
import type { NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSource,
  resetSources,
  SourceConfigError,
  type DiscoverySource,
  type SourceContext,
} from '../src/adapters/discoverySource';
import { ashbySource } from '../src/adapters/sources/ashby';
import { greenhouseSource } from '../src/adapters/sources/greenhouse';
import { LEVER_PAGE_SIZE, leverSource } from '../src/adapters/sources/lever';
import { discoveryRuns, jobs } from '../src/db/schema';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import { enqueue } from '../src/jobs/runner';
import {
  createSafeFetch,
  FetchBlockedError,
  type RawResponse,
  type safeFetch,
} from '../src/lib/safeFetch';
import { createSource, getSourceRow, listResults } from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
afterEach(() => resetSources());

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ats/${name}`, import.meta.url), 'utf8');

interface Call {
  url: string;
  allowHosts: string[];
}

/** A recording safeFetch stand-in that answers every request with `respond(url)`. */
function recordingFetch(respond: (url: string) => { status: number; body: string }) {
  const calls: Call[] = [];
  const fetch = (async (url, opts) => {
    calls.push({ url, allowHosts: [...opts.allowHosts] });
    const r = respond(url);
    return { status: r.status, headers: new Headers(), body: Buffer.from(r.body) };
  }) as typeof safeFetch;
  return { calls, fetch };
}

const silentLog = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as SourceContext['log'];

async function collect(
  src: DiscoverySource,
  fetch: typeof safeFetch,
  org = 'initech',
): Promise<NormalizedPosting[]> {
  const out: NormalizedPosting[] = [];
  for await (const item of src.fetchPostings({ fetch, log: silentLog }, { org }, null)) {
    expect(item.nextCursor).toBeNull();
    out.push(item.posting);
  }
  return out;
}

describe('greenhouse adapter', () => {
  it('maps the board fixture (exact first item) from the one API host', async () => {
    const { calls, fetch } = recordingFetch(() => ({
      status: 200,
      body: fixture('greenhouse.json'),
    }));
    const postings = await collect(greenhouseSource, fetch);
    expect(calls).toEqual([
      {
        url: 'https://boards-api.greenhouse.io/v1/boards/initech/jobs?content=true',
        allowHosts: ['boards-api.greenhouse.io'],
      },
    ]);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toEqual({
      company: 'Initech',
      title: 'Staff Platform Engineer',
      // Greenhouse escapes its HTML once; the adapter undoes that, the engine sanitizes.
      descriptionMd:
        '<p>Own the <strong>payments platform</strong>.</p><ul><li>Kubernetes</li><li>Go</li></ul><p>Salary &amp; equity.</p>',
      postingUrl: 'https://boards.greenhouse.io/initech/jobs/4012345007',
      location: 'Austin, TX',
      remote: null,
      compNote: null,
      externalId: '4012345007',
      postedAt: Date.parse('2026-09-28T09:00:00-04:00'),
    });
    // No company_name on the item: the org slug stands in; a "Remote" location reads as remote.
    expect(postings[1]).toMatchObject({
      company: 'initech',
      remote: true,
      externalId: '4012399007',
    });
  });
});

describe('lever adapter', () => {
  it('maps the postings fixture (exact first item) from the one API host', async () => {
    const { calls, fetch } = recordingFetch(() => ({ status: 200, body: fixture('lever.json') }));
    const postings = await collect(leverSource, fetch);
    expect(calls).toEqual([
      {
        url: `https://api.lever.co/v0/postings/initech?mode=json&skip=0&limit=${LEVER_PAGE_SIZE}`,
        allowHosts: ['api.lever.co'],
      },
    ]);
    expect(postings).toHaveLength(2);
    expect(postings[0]).toEqual({
      company: 'initech',
      title: 'Senior Platform Engineer - Payments',
      descriptionMd:
        '<div>Own the <b>payments platform</b>.</div><h3>Requirements</h3><ul><li>Kubernetes</li><li>Go</li></ul><div>We offer relocation.</div>',
      postingUrl: 'https://jobs.lever.co/initech/5f1c2b9e-1111-4c2d-9a7e-0123456789ab',
      location: 'Austin, TX',
      remote: null,
      compNote: 'USD 180000-220000 per year',
      externalId: '5f1c2b9e-1111-4c2d-9a7e-0123456789ab',
      postedAt: 1790000000000,
    });
    expect(postings[1]).toMatchObject({ title: 'Senior Product Manager', remote: true });
  });

  it('pages with skip/limit until a short page', async () => {
    const item = (n: number) => ({
      id: `p-${n}`,
      text: `Role ${n}`,
      hostedUrl: `https://jobs.lever.co/initech/p-${n}`,
    });
    const { calls, fetch } = recordingFetch((url) => {
      const skip = Number(new URL(url).searchParams.get('skip'));
      const count = skip === 0 ? LEVER_PAGE_SIZE : 3;
      return {
        status: 200,
        body: JSON.stringify(Array.from({ length: count }, (_, i) => item(skip + i))),
      };
    });
    const postings = await collect(leverSource, fetch);
    expect(postings).toHaveLength(LEVER_PAGE_SIZE + 3);
    expect(calls.map((c) => new URL(c.url).searchParams.get('skip'))).toEqual([
      '0',
      String(LEVER_PAGE_SIZE),
    ]);
  });
});

describe('ashby adapter', () => {
  it('maps the job board fixture (exact first item), skipping unlisted jobs', async () => {
    const { calls, fetch } = recordingFetch(() => ({ status: 200, body: fixture('ashby.json') }));
    const postings = await collect(ashbySource, fetch);
    expect(calls).toEqual([
      {
        url: 'https://api.ashbyhq.com/posting-api/job-board/initech?includeCompensation=true',
        allowHosts: ['api.ashbyhq.com'],
      },
    ]);
    expect(postings.map((p) => p.externalId)).toEqual([
      '0c3f1a2b-3333-4d5e-8f90-abcdef012345',
      '9d8e7f6a-4444-4d5e-8f90-abcdef012345',
    ]);
    expect(postings[0]).toEqual({
      company: 'initech',
      title: 'Staff Data Engineer',
      descriptionMd: '<p>Build the <em>lakehouse</em>.</p>',
      postingUrl: 'https://jobs.ashbyhq.com/initech/0c3f1a2b-3333-4d5e-8f90-abcdef012345',
      location: 'New York, NY',
      remote: null,
      compNote: '$190K - $230K • Offers Equity',
      externalId: '0c3f1a2b-3333-4d5e-8f90-abcdef012345',
      postedAt: Date.parse('2026-09-30T16:00:00.000+00:00'),
    });
    expect(postings[1]).toMatchObject({ remote: true, descriptionMd: 'Talk to developers.' });
  });
});

describe('every ATS adapter', () => {
  const adapters = [greenhouseSource, leverSource, ashbySource];

  it('is registered as a built-in that survives resetSources', () => {
    resetSources();
    expect(getSource('ats_greenhouse')).toBe(greenhouseSource);
    expect(getSource('ats_lever')).toBe(leverSource);
    expect(getSource('ats_ashby')).toBe(ashbySource);
  });

  it('throws SourceConfigError for an org the ATS does not know (404)', async () => {
    for (const adapter of adapters) {
      const { fetch } = recordingFetch(() => ({ status: 404, body: '{"error":"not found"}' }));
      await expect(collect(adapter, fetch, 'no-such-org')).rejects.toBeInstanceOf(
        SourceConfigError,
      );
    }
  });

  it('throws SourceConfigError for an invalid config, before any fetch', async () => {
    for (const adapter of adapters) {
      const { calls, fetch } = recordingFetch(() => ({ status: 200, body: '[]' }));
      await expect(collect(adapter, fetch, '../../admin')).rejects.toBeInstanceOf(
        SourceConfigError,
      );
      expect(calls).toEqual([]);
    }
  });

  it('a server error is a plain (retryable) error, not a config error', async () => {
    for (const adapter of adapters) {
      const { fetch } = recordingFetch(() => ({ status: 503, body: '' }));
      const err = await collect(adapter, fetch).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SourceConfigError);
    }
  });

  it('runs through safeFetch: a redirect off the API host is refused (allowlist wiring)', async () => {
    for (const adapter of adapters) {
      const requested: string[] = [];
      const fetch = createSafeFetch({
        now: () => 0,
        sleep: async () => undefined,
        resolve: async () => ['93.184.216.34'],
        request: async (target): Promise<RawResponse> => {
          requested.push(target.url.hostname);
          return {
            status: 302,
            headers: { location: 'https://evil.example.net/steal' },
            body: (async function* () {})(),
          };
        },
      });
      const err = await collect(adapter, fetch).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FetchBlockedError);
      expect((err as FetchBlockedError).reason).toBe('host_not_allowed');
      expect(requested).toHaveLength(1);
      expect(requested[0]).not.toBe('evil.example.net');
    }
  });
});

describe('discovery.run with an ATS adapter', () => {
  it('a 404 org fails fast: exactly one error run, source status error, no retry', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const { calls, fetch } = recordingFetch(() => ({ status: 404, body: '' }));
    app.jobs.services.sourceFetch = fetch;
    const src = await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'nope' },
    });
    const jobId = await enqueue(
      app.db,
      DISCOVERY_RUN_KIND,
      { sourceId: src.id },
      { userId: a.userId },
    );
    await app.jobs.drain();

    const job = (await app.db.select().from(jobs).where(eq(jobs.id, jobId)).get())!;
    expect(job.status).toBe('done');
    expect(job.attempts).toBe(1);
    const runs = await app.db
      .select()
      .from(discoveryRuns)
      .where(eq(discoveryRuns.sourceId, src.id))
      .all();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.error).toMatch(/SourceConfigError/);
    expect(runs[0]!.finishedAt).not.toBeNull();
    const row = await getSourceRow(app.db, ctx, src.id);
    expect(row.status).toBe('error');
    expect(row.statusDetail).toMatch(/nope/);
    expect(calls).toHaveLength(1);
  });

  it('a healthy board stores sanitized results', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const { fetch } = recordingFetch(() => ({ status: 200, body: fixture('greenhouse.json') }));
    app.jobs.services.sourceFetch = fetch;
    const src = await createSource(app.db, ctx, {
      kind: 'ats_greenhouse',
      config: { org: 'initech' },
    });
    await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId: src.id }, { userId: a.userId });
    await app.jobs.drain();
    const results = (await listResults(app.db, ctx, { limit: 50, offset: 0, sourceId: src.id }))
      .items;
    expect(results).toHaveLength(2);
    const staff = results.find((r) => r.posting.title === 'Staff Platform Engineer')!;
    expect(staff.posting.descriptionMd).not.toMatch(/[<>]/);
    expect(staff.posting.descriptionMd).toContain('payments platform');
    expect(staff.posting.descriptionMd).toContain('Salary & equity.');
    expect((await getSourceRow(app.db, ctx, src.id)).status).toBe('ok');
  });
});
