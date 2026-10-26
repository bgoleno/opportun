// One-shot backfill of companies.company_match_key (issue #193): companies written before
// that column existed get it filled in lazily, the same shape as repairDedupeKeys.test.ts.
import { companyMatchKey } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { companies, jobs } from '../src/db/schema';
import {
  enqueueRepairCompanyMatchKeysOnce,
  REPAIR_COMPANY_MATCH_KEYS_KIND,
  repairCompanyMatchKeys,
} from '../src/jobs/companyMatchKeyRepair';
import { createCompany, updateCompany } from '../src/repos/companies';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';

const boot = useApi();

const companyById = async (app: FastifyInstance, userId: string, id: string) =>
  (await app.db
    .select()
    .from(companies)
    .where(and(eq(companies.userId, userId), eq(companies.id, id)))
    .get())!;

describe('repairCompanyMatchKeys', () => {
  it('fills in a key for a row stored before the column existed', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Acme Robotics, Inc.' });
    // Simulate a pre-migration row: the column exists now, but this one was never backfilled.
    await app.db
      .update(companies)
      .set({ companyMatchKey: null })
      .where(eq(companies.id, company.id))
      .run();

    const outcome = await repairCompanyMatchKeys(app.db, ctx);

    expect(outcome.companies).toEqual({ scanned: 1, corrected: 1 });
    const row = await companyById(app, a.userId, company.id);
    expect(row.companyMatchKey).toBe(companyMatchKey('Acme Robotics, Inc.'));
  });

  it('leaves an already-keyed row untouched', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Acme Robotics' });
    const before = await companyById(app, a.userId, company.id);

    const outcome = await repairCompanyMatchKeys(app.db, ctx);

    const after = await companyById(app, a.userId, company.id);
    expect(after.companyMatchKey).toBe(before.companyMatchKey);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(outcome.companies).toEqual({ scanned: 0, corrected: 0 });
  });

  it('never scans twice: a second run against an already-repaired table is a no-op', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Acme Robotics' });
    await app.db
      .update(companies)
      .set({ companyMatchKey: null })
      .where(eq(companies.id, company.id))
      .run();

    const first = await repairCompanyMatchKeys(app.db, ctx);
    expect(first.companies).toEqual({ scanned: 1, corrected: 1 });

    // Safe to run again, whether because the job's own retry fired after a partial failure
    // or because someone re-ran it by hand: nothing left to find means nothing left to touch.
    const second = await repairCompanyMatchKeys(app.db, ctx);
    expect(second.companies).toEqual({ scanned: 0, corrected: 0 });
  });
});

describe('findMatches: the near-miss scan under a not-yet-backfilled company', () => {
  it('still finds a match while the key is null, not only after the repair runs', async () => {
    // The correctness guarantee a cached, indexed column has to earn: a company the backfill
    // has not reached yet (or whose repair job failed partway) must not quietly disappear from
    // the scan. findMatches' SQL filter widens to `company_match_key IS NULL` for exactly this
    // case, and falls back to the same companyName recompute the scan always ran, so a missing
    // key costs performance, never a missed duplicate.
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Acme Robotics' });
    const existing = await createOpportunity(app.db, ctx, {
      companyName: 'Acme Robotics',
      title: 'Senior Product Manager',
      sourceKind: 'manual',
    });
    await app.db
      .update(companies)
      .set({ companyMatchKey: null })
      .where(eq(companies.id, company.id))
      .run();

    // A corporate-suffix variant, same title, created with the other side's key still null.
    const other = await createOpportunity(app.db, ctx, {
      companyName: 'Acme Robotics, Inc.',
      title: 'Senior Product Manager',
      sourceKind: 'manual',
    });

    expect(other.possibleDuplicates).toEqual([existing.id]);
  });

  it('keeps finding the same match once the key is backfilled', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Acme Robotics' });
    const existing = await createOpportunity(app.db, ctx, {
      companyName: 'Acme Robotics',
      title: 'Senior Product Manager',
      sourceKind: 'manual',
    });
    await app.db
      .update(companies)
      .set({ companyMatchKey: null })
      .where(eq(companies.id, company.id))
      .run();
    await repairCompanyMatchKeys(app.db, ctx);

    const other = await createOpportunity(app.db, ctx, {
      companyName: 'Acme Robotics, Inc.',
      title: 'Senior Product Manager',
      sourceKind: 'manual',
    });

    expect(other.possibleDuplicates).toEqual([existing.id]);
  });
});

describe('withMatchKey: renaming a company keeps the two in step', () => {
  it('updateCompany recomputes the key when the name changes, not just on create', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Acme Robotics' });
    expect(company.companyMatchKey).toBe(companyMatchKey('Acme Robotics'));

    const renamed = await updateCompany(app.db, ctx, company.id, { name: 'Acme Systems' });

    expect(renamed.companyMatchKey).toBe(companyMatchKey('Acme Systems'));
    expect(renamed.companyMatchKey).not.toBe(companyMatchKey('Acme Robotics'));
  });

  it('a patch that does not touch name leaves the key alone', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Acme Robotics' });

    const patched = await updateCompany(app.db, ctx, company.id, { notes: 'Following up' });

    expect(patched.companyMatchKey).toBe(company.companyMatchKey);
  });
});

describe('enqueueRepairCompanyMatchKeysOnce', () => {
  const repairJobs = async (app: FastifyInstance) =>
    app.db.select().from(jobs).where(eq(jobs.kind, REPAIR_COMPANY_MATCH_KEYS_KIND)).all();

  it('does not retire the repair when the install has no users yet', async () => {
    const { app } = await boot();
    expect(await repairJobs(app)).toHaveLength(0);

    const queued = await enqueueRepairCompanyMatchKeysOnce(app.db);
    expect(queued).toBe(2); // the two users registered after boot

    expect(await repairJobs(app)).toHaveLength(2);
  });

  it('never queues the repair twice', async () => {
    const { app } = await boot();
    await enqueueRepairCompanyMatchKeysOnce(app.db);

    const second = await enqueueRepairCompanyMatchKeysOnce(app.db);

    expect(second).toBe(0);
    expect(await repairJobs(app)).toHaveLength(2);
  });
});
