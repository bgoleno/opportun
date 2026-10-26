// Lead resolution (Task 8, FR-D7): partial leads matched against the ATS boards of known
// companies, from cached results or a live lookup through the registered adapter; the lead's
// own URL (often linkedin.com) is never fetched.
import type { NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerSource,
  resetSources,
  type DiscoverySource,
} from '../src/adapters/discoverySource';
import { jobs } from '../src/db/schema';
import { DISCOVERY_RANK_KIND } from '../src/jobs/discoveryRank';
import { DISCOVERY_RUN_KIND } from '../src/jobs/discoveryRun';
import {
  LEAD_RESOLVE_KIND,
  resolveLead,
  TITLE_MATCH_THRESHOLD,
  titleOverlap,
} from '../src/jobs/leadResolve';
import { enqueue } from '../src/jobs/runner';
import type { safeFetch } from '../src/lib/safeFetch';
import { createCompany } from '../src/repos/companies';
import { createSource, getResult, listResults } from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 50, offset: 0 };

afterEach(() => resetSources());

/** A LinkedIn job alert lead: company, title and a linkedin.com link, no description. */
const LEAD: NormalizedPosting = {
  company: 'Initech',
  title: 'Platform Engineer, Payments',
  postingUrl: 'https://www.linkedin.com/jobs/view/1234567890/',
  descriptionMd: null,
};

/** The ATS posting the lead refers to, as a Lever board fixture lists it. */
const ATS_POSTING: NormalizedPosting = {
  company: 'Initech',
  title: 'Senior Platform Engineer - Payments',
  descriptionMd: 'Own the payments platform. Kubernetes, Go.',
  postingUrl: 'https://jobs.lever.co/initech/abc-123',
  location: 'Austin, TX',
  externalId: 'abc-123',
};

const LEVER_FIXTURE = JSON.stringify([
  {
    id: 'abc-123',
    text: ATS_POSTING.title,
    descriptionPlain: ATS_POSTING.descriptionMd,
    hostedUrl: ATS_POSTING.postingUrl,
    categories: { location: 'Austin, TX' },
  },
  {
    id: 'zzz-9',
    text: 'Office Manager',
    descriptionPlain: 'Run the office.',
    hostedUrl: 'https://jobs.lever.co/initech/zzz-9',
    categories: { location: 'Austin, TX' },
  },
]);

function staticSource(
  kind: DiscoverySource['kind'],
  postings: NormalizedPosting[],
): DiscoverySource {
  return {
    kind,
    async *fetchPostings() {
      for (const posting of postings) yield { posting, nextCursor: null };
    },
  };
}

/** A Lever-like adapter that reads its board through sctx.fetch (the safeFetch seam). */
const leverLike: DiscoverySource = {
  kind: 'ats_lever',
  async *fetchPostings(sctx, config) {
    const { org } = config as { org: string };
    const res = await sctx.fetch(`https://api.lever.co/v0/postings/${org}?mode=json`, {
      allowHosts: ['api.lever.co'],
    });
    const items = JSON.parse(res.body.toString('utf8')) as {
      id: string;
      text: string;
      descriptionPlain: string;
      hostedUrl: string;
      categories: { location: string };
    }[];
    for (const i of items) {
      yield {
        posting: {
          company: org,
          title: i.text,
          descriptionMd: i.descriptionPlain,
          postingUrl: i.hostedUrl,
          location: i.categories.location,
          externalId: i.id,
        },
        nextCursor: null,
      };
    }
  },
};

/** A recording fetch: serves the Lever fixture, records every URL asked for. */
function recordingFetch(): { fetch: typeof safeFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    urls.push(url);
    if (new URL(url).hostname !== 'api.lever.co') throw new Error(`unexpected fetch ${url}`);
    return { status: 200, headers: new Headers(), body: Buffer.from(LEVER_FIXTURE) };
  }) as unknown as typeof safeFetch;
  return { fetch, urls };
}

async function runSource(app: FastifyInstance, c: TestClient, sourceId: string): Promise<void> {
  await enqueue(app.db, DISCOVERY_RUN_KIND, { sourceId }, { userId: c.userId });
  await app.jobs.drain();
}

/** Initech, known with a Lever source. */
async function initechWithLever(app: FastifyInstance, c: TestClient) {
  const company = await createCompany(app.db, ctxOf(c), { name: 'Initech', status: 'followed' });
  return await createSource(app.db, ctxOf(c), {
    kind: 'ats_lever',
    config: { org: 'initech' },
    companyId: company.id,
  });
}

/** Delivers the lead the way the alert-email channel will (Task 12): a partial result. */
async function deliverLead(app: FastifyInstance, c: TestClient, lead = LEAD): Promise<string> {
  registerSource(staticSource('alert_email', [lead]));
  const alerts = await createSource(app.db, ctxOf(c), { kind: 'alert_email', config: {} });
  await runSource(app, c, alerts.id);
  const item = (await listResults(app.db, ctxOf(c), { ...PAGE, sourceId: alerts.id })).items[0];
  if (item === undefined) throw new Error('lead not stored');
  return item.id;
}

async function jobsOf(app: FastifyInstance, kind: string) {
  return await app.db.select().from(jobs).where(eq(jobs.kind, kind)).all();
}

describe('title matching', () => {
  it('scores normalized token overlap against the larger title', () => {
    expect(titleOverlap('Platform Engineer, Payments', 'Senior Platform Engineer - Payments')).toBe(
      0.75,
    );
    expect(titleOverlap('Platform Engineer', 'Office Manager')).toBe(0);
    expect(titleOverlap('Ing\u00e9nieur Plateforme', 'ingenieur plateforme')).toBe(1);
    expect(TITLE_MATCH_THRESHOLD).toBe(0.6);
  });
});

describe('discovery.lead_resolve job', () => {
  it('resolves a partial lead from a cached ATS posting and fills its description', async () => {
    const { app, a } = await boot();
    const lever = await initechWithLever(app, a);
    registerSource(staticSource('ats_lever', [ATS_POSTING]));
    await runSource(app, a, lever.id);
    const { fetch, urls } = recordingFetch();
    app.jobs.services.sourceFetch = fetch;

    const id = await deliverLead(app, a);

    const res = await getResult(app.db, ctxOf(a), id);
    expect(res.resolution).toBe('resolved_ats');
    expect(res.resolvedSourceRef).toBe('abc-123');
    expect(res.posting).toMatchObject({
      company: 'Initech',
      title: 'Platform Engineer, Payments',
      descriptionMd: 'Own the payments platform. Kubernetes, Go.',
      postingUrl: 'https://jobs.lever.co/initech/abc-123',
      location: 'Austin, TX',
    });
    // Cached: no network at all.
    expect(urls).toEqual([]);
    const lead = await jobsOf(app, LEAD_RESOLVE_KIND);
    expect(lead).toHaveLength(1);
    expect(lead[0]!.result).toEqual({ status: 'resolved_ats', ref: 'abc-123', via: 'cache' });
    // Ranking follows resolution.
    expect(
      (await jobsOf(app, DISCOVERY_RANK_KIND)).map(
        (j) => (j.payload as { resultId: string }).resultId,
      ),
    ).toContain(id);
  });

  it('falls back to a live lookup through the registered adapter, never fetching the linkedin.com link', async () => {
    const { app, a } = await boot();
    await initechWithLever(app, a);
    registerSource(leverLike);
    const { fetch, urls } = recordingFetch();
    app.jobs.services.sourceFetch = fetch;

    const id = await deliverLead(app, a);

    const res = await getResult(app.db, ctxOf(a), id);
    expect(res.resolution).toBe('resolved_ats');
    expect(res.posting.descriptionMd).toBe('Own the payments platform. Kubernetes, Go.');
    expect(urls).toEqual(['https://api.lever.co/v0/postings/initech?mode=json']);
    expect(urls.some((u) => /linkedin\.com/i.test(u))).toBe(false);
    expect((await jobsOf(app, LEAD_RESOLVE_KIND))[0]!.result).toMatchObject({ via: 'live' });
  });

  it('leaves a lead with no confident match as needs_capture, and still ranks it', async () => {
    const { app, a } = await boot();
    const lever = await initechWithLever(app, a);
    registerSource(
      staticSource('ats_lever', [{ ...ATS_POSTING, title: 'Office Manager', externalId: 'om' }]),
    );
    await runSource(app, a, lever.id);
    const { fetch, urls } = recordingFetch();
    app.jobs.services.sourceFetch = fetch;

    const id = await deliverLead(app, a);
    const res = await getResult(app.db, ctxOf(a), id);
    expect(res).toMatchObject({ resolution: 'needs_capture', resolvedSourceRef: null });
    expect(res.posting.descriptionMd).toBeNull();
    expect(res.posting.postingUrl).toBe(LEAD.postingUrl);
    expect(urls.some((u) => /linkedin\.com/i.test(u))).toBe(false);
    expect(
      (await jobsOf(app, DISCOVERY_RANK_KIND)).map(
        (j) => (j.payload as { resultId: string }).resultId,
      ),
    ).toContain(id);
  });

  it('an unknown company or a resolver that finds nothing leaves needs_capture', async () => {
    const { app, a } = await boot();
    const { fetch, urls } = recordingFetch();
    app.jobs.services.sourceFetch = fetch;
    const unknown = await deliverLead(app, a, { ...LEAD, company: 'Globex' });
    expect((await getResult(app.db, ctxOf(a), unknown)).resolution).toBe('needs_capture');

    await initechWithLever(app, a);
    // The shipped Lever adapter (Task 9) resolves during delivery; an empty board keeps the
    // lead partial so the injected resolver below is what decides.
    app.jobs.services.sourceFetch = (async () => ({
      status: 200,
      headers: new Headers(),
      body: Buffer.from('[]'),
    })) as unknown as typeof safeFetch;
    const id = await deliverLead(app, a);
    const live = vi.fn(async () => []);
    const log = app.log;
    const outcome = await resolveLead(app.db, ctxOf(a), id, { fetch, log }, { live });
    expect(outcome).toEqual({ status: 'needs_capture' });
    expect(live).toHaveBeenCalledTimes(1);
    expect(urls).toEqual([]);
  });

  it('the shipped Lever adapter serves the live lookup with no override registered', async () => {
    const { app, a } = await boot();
    const { fetch, urls } = recordingFetch();
    app.jobs.services.sourceFetch = fetch;
    await initechWithLever(app, a);
    const id = await deliverLead(app, a);
    const res = await getResult(app.db, ctxOf(a), id);
    expect(res.resolution).toBe('resolved_ats');
    expect(res.resolvedSourceRef).toBe('abc-123');
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).hostname).toBe('api.lever.co');
  });

  it('a full posting is ranked directly and never queued for resolution', async () => {
    const { app, a } = await boot();
    registerSource(staticSource('ats_ashby', [ATS_POSTING]));
    const src = await createSource(app.db, ctxOf(a), {
      kind: 'ats_ashby',
      config: { org: 'initech' },
    });
    await runSource(app, a, src.id);
    expect(await jobsOf(app, LEAD_RESOLVE_KIND)).toHaveLength(0);
    expect(await jobsOf(app, DISCOVERY_RANK_KIND)).toHaveLength(1);
  });

  it("does not resolve against another user's ATS sources", async () => {
    const { app, a, b } = await boot();
    const lever = await initechWithLever(app, b);
    registerSource(staticSource('ats_lever', [ATS_POSTING]));
    await runSource(app, b, lever.id);
    const id = await deliverLead(app, a);
    expect((await getResult(app.db, ctxOf(a), id)).resolution).toBe('needs_capture');
  });
});
