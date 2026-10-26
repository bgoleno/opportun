// Posting reconciliation state on an opportunity (design D16, D17): which ATS req it is,
// how far the board search got, and the fingerprint of the description the system last wrote.
// All four columns are nullable and nothing backfills them, so an opportunity nobody
// reconciled is indistinguishable from one created before this existed.
import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import { createOpportunity, getOpportunity, setPostingState } from '../src/repos/opportunities';
import type { TestClient } from './isolation';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

const REF = {
  kind: 'ats_greenhouse' as const,
  org: 'soylent',
  externalId: '1000000001',
  url: 'https://boards.greenhouse.io/soylent/jobs/1000000001',
};

describe('posting reconciliation state', () => {
  it('stores and reads back an ATS ref, state and detail', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Soylent',
      title: 'Staff PM',
      sourceKind: 'discovery',
    });
    const out = await setPostingState(app.db, ctx, opp.id, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: REF,
    });
    expect(out.postingState).toBe('confirmed');
    expect(out.postingStateDetail).toBeNull();
    expect(out.atsJobRef).toEqual(REF);
    // Round-tripped through the database, not just through the return value.
    expect((await getOpportunity(app.db, ctx, opp.id)).atsJobRef).toEqual(REF);
  });

  it('leaves every new column null on an opportunity nobody reconciled', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Hooli',
      title: 'PM',
      sourceKind: 'manual',
    });
    expect([opp.atsJobRef, opp.postingState, opp.postingStateDetail]).toEqual([null, null, null]);
    expect(opp.descriptionFingerprint).toBeNull();
  });

  it('records needs_review with its reason, and no ref', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Soylent',
      title: 'Staff PM',
      sourceKind: 'discovery',
    });
    const out = await setPostingState(app.db, ctx, opp.id, {
      postingState: 'needs_review',
      postingStateDetail: 'ambiguous',
    });
    expect([out.postingState, out.postingStateDetail]).toEqual(['needs_review', 'ambiguous']);
    expect(out.atsJobRef).toBeNull();
  });

  it('stores the description fingerprint without exposing it as editable API surface', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Soylent',
      title: 'Staff PM',
      sourceKind: 'discovery',
    });
    const out = await setPostingState(app.db, ctx, opp.id, {
      postingState: 'searching',
      postingStateDetail: null,
      descriptionFingerprint: 'a'.repeat(64),
    });
    expect(out.descriptionFingerprint).toBe('a'.repeat(64));
  });

  it('does not leak another user’s opportunity', async () => {
    const { app, a, b } = await boot();
    const opp = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Soylent',
      title: 'Staff PM',
      sourceKind: 'discovery',
    });
    await expect(
      setPostingState(app.db, ctxOf(b), opp.id, {
        postingState: 'confirmed',
        postingStateDetail: null,
      }),
    ).rejects.toThrow();
  });
});
