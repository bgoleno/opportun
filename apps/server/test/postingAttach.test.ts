// Attaching a posting to an opportunity (Task 4, FR-O1): the description and link are stored as
// a snapshot, the facts the opportunity already carries are left alone, and the timeline records
// where the posting came from. An opportunity that already has a description is never overwritten.
import type { NormalizedPosting } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { attachPosting } from '../src/lib/postingAttach';
import { listActivities } from '../src/repos/activities';
import { createOpportunity, getOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const PAGE = { limit: 50, offset: 0 };

const POSTING: NormalizedPosting = {
  company: 'Sentinel Edge',
  title: 'Staff Product Manager, SIEM',
  descriptionMd: 'What We Do: cybercrime is growing.',
  postingUrl: 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003',
  location: 'United States of America',
  remote: true,
  compNote: '$180k - $220k',
  externalId: '7663059003',
};

describe('attachPosting', () => {
  it('fills description, link and the empty facts, and leaves set facts alone', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
      location: 'Remote - US',
    });

    const updated = await attachPosting(app.db, ctx, opp.id, POSTING, 'board');

    expect(updated.descriptionMd).toBe('What We Do: cybercrime is growing.');
    expect(updated.postingUrl).toBe(
      'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003',
    );
    expect(updated.location).toBe('Remote - US');
    expect(updated.remote).toBe(true);
    expect(updated.compNote).toBe('$180k - $220k');
    expect(updated.title).toBe('Product Manager, SIEM');
  });

  it('names a refetch of an already-confirmed opportunity distinctly from the first attach (issue #255)', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });

    const first = await attachPosting(app.db, ctx, opp.id, POSTING, 'board');
    expect(first.postingState).toBe('confirmed');

    const refreshed: NormalizedPosting = { ...POSTING, descriptionMd: 'What We Do: updated.' };
    await attachPosting(app.db, ctx, opp.id, refreshed, 'board');

    const { items } = await listActivities(app.db, ctx, opp.id, { ...PAGE, sort: '-occurredAt' });
    const links = items.filter((i) => i.kind === 'link');
    expect(links).toHaveLength(2);
    expect(links[0]!.bodyMd).toContain('Refetched');
    expect(links[1]!.bodyMd).not.toContain('Refetched');
  });

  it('records a link activity naming how the posting was found', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });

    await attachPosting(app.db, ctx, opp.id, POSTING, 'email_link');

    const { items } = await listActivities(app.db, ctx, opp.id, { ...PAGE, sort: '-occurredAt' });
    const entry = items.find((i) => i.kind === 'link');
    expect(entry).toBeDefined();
    expect(entry!.bodyMd).toContain('Staff Product Manager, SIEM');
    expect(entry!.bodyMd).toContain('message');
    expect(entry!.externalUrl).toBe(
      'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003',
    );
  });

  it('carries a note onto the timeline entry (#114), not just whatever the caller shows once', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });

    await attachPosting(
      app.db,
      ctx,
      opp.id,
      POSTING,
      'board',
      'Large Workday board: showing the first 200 of 500 postings. Paste the posting link or ' +
        'text if yours is not among them.',
    );

    const { items } = await listActivities(app.db, ctx, opp.id, { ...PAGE, sort: '-occurredAt' });
    const entry = items.find((i) => i.kind === 'link');
    expect(entry!.bodyMd).toContain('Large Workday board: showing the first 200 of 500');
  });

  it('refuses an opportunity that already has a description', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
      descriptionMd: 'the description I already had',
    });

    await expect(attachPosting(app.db, ctx, opp.id, POSTING, 'board')).rejects.toMatchObject({
      statusCode: 409,
      code: 'already_described',
    });
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe(
      'the description I already had',
    );
  });

  it('truncates an over-long description through the sanitizer', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });

    const updated = await attachPosting(
      app.db,
      ctx,
      opp.id,
      { ...POSTING, descriptionMd: 'x'.repeat(60_000) },
      'paste',
    );

    expect(updated.descriptionMd).toHaveLength(50_000);
  });

  it('refuses a posting with no description', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });

    await expect(
      attachPosting(app.db, ctx, opp.id, { ...POSTING, descriptionMd: '   ' }, 'paste'),
    ).rejects.toMatchObject({ statusCode: 422, code: 'invalid_posting' });
  });

  it("404s for another user's opportunity", async () => {
    const { app, a, b } = await boot();
    const opp = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Sentinel Edge',
      title: 'Product Manager, SIEM',
      sourceKind: 'import',
    });

    await expect(attachPosting(app.db, ctxOf(b), opp.id, POSTING, 'board')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
