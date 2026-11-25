// companies.company_match_key (issue #193): kept in step with the name, and not needed for a company
// stored before the column existed, whose opportunities are found by its name.
import { companyMatchKey } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies } from '../src/db/schema';
import { createCompany, updateCompany } from '../src/repos/companies';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';

const boot = useApi();

describe('findMatches: the near-miss scan of a company with no key', () => {
  it('still finds a match while the key is null, not only with one', async () => {
    // The correctness guarantee a cached, indexed column has to earn: a company stored before it
    // existed, which nothing fills in (#1034), must not quietly disappear from the scan. findMatches'
    // SQL filter widens to `company_match_key IS NULL` for exactly this case, and falls back to the
    // same companyName recompute the scan always ran, so a missing key costs performance, never a
    // missed duplicate.
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

  it('is not a match of another company because its key is null', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const company = await createCompany(app.db, ctx, { name: 'Globex' });
    const opportunity = (companyName: string) =>
      createOpportunity(app.db, ctx, {
        companyName,
        title: 'Senior Product Manager',
        sourceKind: 'manual',
      });
    await opportunity('Globex');
    await app.db
      .update(companies)
      .set({ companyMatchKey: null })
      .where(eq(companies.id, company.id))
      .run();

    expect((await opportunity('Acme Robotics')).possibleDuplicates).toEqual([]);
  });

  it('keeps finding the same match once it has a key', async () => {
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
    await updateCompany(app.db, ctx, company.id, { name: 'Acme Robotics' });

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
