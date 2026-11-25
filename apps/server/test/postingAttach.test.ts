// Attaching a posting to an opportunity (Task 4, FR-O1): the description and link are stored as
// a snapshot, the facts the opportunity already carries are left alone, and the timeline records
// where the posting came from. An opportunity that already has a description is never overwritten.
import type { NormalizedPosting } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { attachPosting } from '../src/lib/postingAttach';
import { listActivities } from '../src/repos/activities';
import {
  createOpportunity,
  deleteOpportunity,
  getOpportunity,
  setPostingState,
  updateOpportunity,
} from '../src/repos/opportunities';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { setRaceHook } from '../src/lib/racePoints';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { pauseAt, whileParked } from './race';

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

  // #858: what it decided from (whose text it is, and whether the user agreed to lose it) has to
  // hold at the write too.
  describe('a description saved between its read and its write is kept (#858)', () => {
    const SAVED = 'typed while the posting was being attached';

    it.each([
      ["the system's text", 'captured text', { written: 'captured text' }],
      ['no description', null, {}],
      ['text the user agreed to lose', 'my notes', { agreed: 'my notes' }],
      ['text kept as it is', 'my notes', { keep: true }],
    ] as const)('from %s', async (_what, descriptionMd, from) => {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const { id } = await createOpportunity(app.db, ctx, {
        companyName: 'Sentinel Edge',
        title: 'Product Manager, SIEM',
        sourceKind: 'import',
        ...(descriptionMd === null ? {} : { descriptionMd }),
      });
      if ('written' in from) {
        await updateOpportunity(app.db, ctx, id, {
          descriptionFingerprint: descriptionFingerprint(from.written),
        });
      }
      await setPostingState(app.db, ctx, id, {
        postingState: 'needs_review',
        postingStateDetail: 'edited',
      });
      const pause = pauseAt('posting.attach');

      const attaching = attachPosting(app.db, ctx, id, POSTING, 'board', undefined, undefined, {
        ...('agreed' in from ? { replaceAgreed: descriptionFingerprint(from.agreed) } : {}),
        ...('keep' in from ? { keepDescription: true } : {}),
      });
      const outcome = attaching.then(
        () => null,
        (err: unknown) => err,
      );
      const saved = await whileParked(pause, () =>
        a.request({
          method: 'PATCH',
          url: `/api/v1/opportunities/${id}`,
          payload: { descriptionMd: SAVED },
        }),
      );
      expect(saved.statusCode, saved.body).toBe(200);
      const before = saved.json();

      expect(await outcome).toMatchObject({
        statusCode: 409,
        code: 'description_changed',
        userMessage:
          "This opportunity's description changed while the posting was being attached, so nothing was changed. Check the description, then try again.",
      });
      // Nothing of the attach is there: not the text, the link, the state, or a timeline entry.
      const after = await getOpportunity(app.db, ctx, id);
      expect(after).toMatchObject({
        descriptionMd: SAVED,
        postingUrl: null,
        location: null,
        postingState: 'needs_review',
        postingStateDetail: 'edited',
        atsJobRef: null,
        updatedAt: before.updatedAt,
      });
      const { items } = await listActivities(app.db, ctx, id, PAGE);
      expect(items.filter((i) => i.kind === 'link')).toEqual([]);
    });

    // Not "the description changed": there is nothing left to say that of.
    it('an opportunity deleted meanwhile is not found', async () => {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const { id } = await createOpportunity(app.db, ctx, {
        companyName: 'Sentinel Edge',
        title: 'Product Manager, SIEM',
        sourceKind: 'import',
      });
      const pause = pauseAt('posting.attach');
      const outcome = attachPosting(app.db, ctx, id, POSTING, 'board').then(
        () => null,
        (err: unknown) => err,
      );
      await whileParked(pause, () => deleteOpportunity(app.db, ctx, id));
      expect(await outcome).toMatchObject({ statusCode: 404 });
    });

    it('a write that fails for another reason is that failure', async () => {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const { id } = await createOpportunity(app.db, ctx, {
        companyName: 'Sentinel Edge',
        title: 'Product Manager, SIEM',
        sourceKind: 'import',
      });
      setRaceHook((point) => {
        if (point === 'opportunities.update.locked') throw new Error('the disk is full');
      });
      await expect(attachPosting(app.db, ctx, id, POSTING, 'board')).rejects.toThrow(
        'the disk is full',
      );
    });
  });
});
