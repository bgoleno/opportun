// Company homepage resolution (issue #239): a candidate domain is only ever written once a
// fetched homepage actually names the company. Mirrors opportunityEnrich.test.ts's net() fixture
// since this reuses that module's candidateDomains/getPage/pageNamesCompany/senderDomain.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { communications, companies, jobs } from '../src/db/schema';
import {
  backfillCompanyDomains,
  COMPANY_DOMAIN_BACKFILL_KIND,
  COMPANY_DOMAIN_RESOLVE_KIND,
  companyDomainResolveDedupeKey,
  enqueueCompanyDomainBackfillOnce,
  enqueueCompanyDomainResolve,
  resolveCompanyDomain,
} from '../src/jobs/companyDomainResolve';
import { createSafeFetch } from '../src/lib/safeFetch';
import { createCompany, updateCompany } from '../src/repos/companies';
import { createOpportunity, transitionOpportunity } from '../src/repos/opportunities';
import type { UserCtx } from '../src/repos/base';
import { useApi } from './api';

const boot = useApi();

const PUBLIC_IP = ['93.184.216.34'];

/** A safeFetch over a URL -> body map; unmapped hosts fail DNS, unmapped URLs 404. */
function net(routes: Record<string, string>) {
  const hosts = new Set(Object.keys(routes).map((u) => new URL(u).hostname));
  const requested: string[] = [];
  const fetch = createSafeFetch({
    now: () => 0,
    sleep: async () => undefined,
    resolve: async (host) => {
      if (!hosts.has(host)) throw new Error(`no dns entry for ${host}`);
      return PUBLIC_IP;
    },
    request: async (target) => {
      requested.push(target.url.href);
      const body = new Map(Object.entries(routes)).get(target.url.href);
      return {
        status: body === undefined ? 404 : 200,
        headers: { 'content-type': 'text/html' },
        body: (async function* () {
          if (body !== undefined) yield Buffer.from(body);
        })(),
      };
    },
  });
  return { fetch, requested };
}

async function addCommunication(
  db: Parameters<typeof createOpportunity>[0],
  ctx: UserCtx,
  opportunityId: string,
  from: string,
  sentAt = 1,
): Promise<void> {
  await db
    .insert(communications)
    .values({
      id: newId(),
      userId: ctx.userId,
      channel: 'gmail',
      externalId: `ext-${newId()}`,
      from,
      to: [],
      sentAt,
      opportunityId,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

describe('resolveCompanyDomain', () => {
  it('resolves from the outreach sender domain once the homepage names the company', async () => {
    const { app, a } = await boot();
    const ctx: UserCtx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Initech Labs' });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Initech Labs',
      title: 'Staff PM',
      sourceKind: 'communication',
    });
    await addCommunication(app.db, ctx, opp.id, '"Recruiter" <talent@initechhq.dev>');
    const { fetch } = net({
      'https://initechhq.dev/': '<html><body>Initech Labs builds billing software.</body></html>',
    });

    const outcome = await resolveCompanyDomain(app.db, ctx, fetch, company.id);

    expect(outcome).toEqual({ outcome: 'resolved', domain: 'initechhq.dev' });
    const row = await app.db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(row?.domain).toBe('initechhq.dev');
  });

  it('falls through to a name-derived guess when the sender domain fails verification', async () => {
    const { app, a } = await boot();
    const ctx: UserCtx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Initech Labs' });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Initech Labs',
      title: 'Staff PM',
      sourceKind: 'communication',
    });
    // A recruiting-agency sender: its own homepage never names Initech Labs.
    await addCommunication(app.db, ctx, opp.id, '"Agency" <jane@talentco.example>');
    const { fetch, requested } = net({
      'https://talentco.example/': '<html><body>TalentCo staffing</body></html>',
      'https://initechlabs.com/': '<html><body>Initech Labs builds billing software.</body></html>',
    });

    const outcome = await resolveCompanyDomain(app.db, ctx, fetch, company.id);

    expect(outcome).toEqual({ outcome: 'resolved', domain: 'initechlabs.com' });
    expect(requested).toEqual(['https://talentco.example/', 'https://initechlabs.com/']);
  });

  it('leaves the company unresolved when no candidate verifies', async () => {
    const { app, a } = await boot();
    const ctx: UserCtx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Zzyzx Quantum Devices' });
    const { fetch } = net({}); // every candidate 404s

    const outcome = await resolveCompanyDomain(app.db, ctx, fetch, company.id);

    expect(outcome).toEqual({ outcome: 'unresolved' });
  });

  it('never overwrites an already-resolved domain, and never fetches to check', async () => {
    const { app, a } = await boot();
    const ctx: UserCtx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, {
      name: 'Initech Labs',
      domain: 'initech.example',
    });
    const { fetch, requested } = net({
      'https://initechlabs.com/': '<html><body>Initech Labs</body></html>',
    });

    const outcome = await resolveCompanyDomain(app.db, ctx, fetch, company.id);

    expect(outcome).toEqual({ outcome: 'already_resolved' });
    expect(requested).toEqual([]);
    const row = await app.db.select().from(companies).where(eq(companies.id, company.id)).get();
    expect(row?.domain).toBe('initech.example');
  });

  it('reports not_found for a company that does not exist (or belongs to another user)', async () => {
    const { app, a } = await boot();
    const ctx: UserCtx = { userId: a.userId, isAdmin: false };
    const { fetch } = net({});

    const outcome = await resolveCompanyDomain(app.db, ctx, fetch, 'no-such-company');

    expect(outcome).toEqual({ outcome: 'not_found' });
  });
});

describe('enqueueCompanyDomainResolve', () => {
  it('queues a job deduped by companyId', async () => {
    const { app, a } = await boot();
    await enqueueCompanyDomainResolve(app.db, a.userId, 'company-1');
    await enqueueCompanyDomainResolve(app.db, a.userId, 'company-1');

    const rows = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, COMPANY_DOMAIN_RESOLVE_KIND))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ companyId: 'company-1' });
    expect(rows[0]?.dedupeKey).toBe(companyDomainResolveDedupeKey('company-1'));
  });
});

describe('backfillCompanyDomains (issue #239)', () => {
  it('queues only companies already in an active stage with no domain', async () => {
    const { app, a } = await boot();
    const ctx: UserCtx = { userId: a.userId, isAdmin: false };

    // Still in 'discovered': not in the pipeline, must not be queued.
    await createOpportunity(app.db, ctx, {
      companyName: 'Discovered Co',
      title: 'Role',
      sourceKind: 'manual',
    });

    // In an active stage but already resolved: must not be queued.
    const resolvedOpp = await createOpportunity(app.db, ctx, {
      companyName: 'Resolved Co',
      title: 'Role',
      sourceKind: 'manual',
    });
    await updateCompany(app.db, ctx, resolvedOpp.companyId, { domain: 'resolved.example' });
    await transitionOpportunity(app.db, ctx, resolvedOpp.id, { to: 'interested' });

    // In an active stage, no domain: must be queued.
    const activeOpp = await createOpportunity(app.db, ctx, {
      companyName: 'Active Co',
      title: 'Role',
      sourceKind: 'manual',
    });
    await transitionOpportunity(app.db, ctx, activeOpp.id, { to: 'applied' });
    // transitionOpportunity's own hook already queued this company; clear it so the backfill's
    // own enumeration is what this test observes, not the hook from setup above.
    await app.db.delete(jobs).where(eq(jobs.kind, COMPANY_DOMAIN_RESOLVE_KIND)).run();

    const outcome = await backfillCompanyDomains(app.db, ctx);

    expect(outcome).toEqual({ companiesQueued: 1 });
    const rows = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, COMPANY_DOMAIN_RESOLVE_KIND))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ companyId: activeOpp.companyId });
  });
});

describe('enqueueCompanyDomainBackfillOnce', () => {
  const backfillJobs = async (app: Awaited<ReturnType<typeof boot>>['app']) =>
    app.db.select().from(jobs).where(eq(jobs.kind, COMPANY_DOMAIN_BACKFILL_KIND)).all();

  it('queues the backfill once per user on a fresh install', async () => {
    const { app } = await boot();
    expect(await backfillJobs(app)).toHaveLength(0);

    const queued = await enqueueCompanyDomainBackfillOnce(app.db);
    expect(queued).toBe(2); // the two users useApi registers

    expect(await backfillJobs(app)).toHaveLength(2);
  });

  it('never queues the backfill twice', async () => {
    const { app } = await boot();
    await enqueueCompanyDomainBackfillOnce(app.db);

    const second = await enqueueCompanyDomainBackfillOnce(app.db);

    expect(second).toBe(0);
    expect(await backfillJobs(app)).toHaveLength(2);
  });
});
