// Guarding posting writes on authorship rather than presence (design D10, D11).
//
// FR-O1 keeps an opportunity's fields editable by hand, and before this branch that was
// enforced by refusing Find posting and attach whenever a description existed at all. A
// capture makes that permanently true, so the button that resolves a needs-review flag would
// vanish exactly when it is needed. The guard now asks who wrote the text.
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { descriptionFingerprint } from '../src/lib/postingFingerprint';
import { createCompany } from '../src/repos/companies';
import {
  createOpportunity,
  getOpportunity,
  setPostingState,
  updateOpportunity,
} from '../src/repos/opportunities';
import type { UserCtx } from '../src/repos/base';

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

async function opportunity(
  app: FastifyInstance,
  ctx: UserCtx,
  descriptionMd: string,
  writtenBySystem: boolean,
) {
  await createCompany(app.db, ctx, { name: 'Soylent' });
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Soylent',
    title: 'Staff Product Manager',
    descriptionMd,
    sourceKind: 'discovery',
  });
  if (writtenBySystem) {
    await updateOpportunity(app.db, ctx, opp.id, {
      descriptionFingerprint: descriptionFingerprint(descriptionMd),
    });
  }
  return opp;
}

const find = (c: TestClient, id: string) =>
  c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/find-posting` });

const attach = (c: TestClient, id: string, payload: Record<string, unknown>) =>
  c.request({ method: 'POST', url: `/api/v1/opportunities/${id}/posting`, payload });

describe('posting writes are guarded on authorship', () => {
  it('lets Find posting run again on a description the capture wrote', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'the captured page text', true);
    await setPostingState(app.db, ctx, opp.id, {
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });

    const res = await find(a, opp.id);

    // No board is registered, so the search itself finds nothing; what matters is that it ran
    // rather than being refused before it started.
    expect(res.statusCode, res.body).toBe(200);
  });

  it('still refuses Find posting on a description the user wrote', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, ctxOf(a), 'my own notes', false);

    const res = await find(a, opp.id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_described');
  });

  it('refuses Find posting once the user has edited what the capture wrote', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'the captured page text', true);
    await updateOpportunity(app.db, ctx, opp.id, { descriptionMd: 'my own notes' });

    expect((await find(a, opp.id)).statusCode).toBe(409);
  });

  it('lets the user act on the edited flag their own edit raised', async () => {
    // Final review, Important 3. The reconcile job raises `edited` precisely because the
    // description is the user's, and the banner's only action ran find-posting, which refuses
    // for the same reason. The flag offered a button that could never work. D11 says the user
    // decides; this is the state where they could not.
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'my own notes', false);
    await setPostingState(app.db, ctx, opp.id, {
      postingState: 'needs_review',
      postingStateDetail: 'edited',
    });

    expect((await find(a, opp.id)).statusCode).toBe(200);
    const res = await attach(a, opp.id, { text: 'the board copy' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await getOpportunity(app.db, ctx, opp.id)).descriptionMd).toBe('the board copy');
  });

  it('still refuses when the user has not asked, even on a flagged opportunity', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'my own notes', false);
    await setPostingState(app.db, ctx, opp.id, {
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });

    expect((await find(a, opp.id)).statusCode).toBe(409);
    expect((await attach(a, opp.id, { text: 'the board copy' })).statusCode).toBe(409);
  });

  it('attaching pasted text replaces a system description and refreshes the fingerprint', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const opp = await opportunity(app, ctx, 'the captured page text', true);

    const res = await attach(a, opp.id, { text: 'the board copy' });

    expect(res.statusCode, res.body).toBe(200);
    const out = await getOpportunity(app.db, ctx, opp.id);
    expect(out.descriptionMd).toBe('the board copy');
    expect(out.descriptionFingerprint).toBe(descriptionFingerprint('the board copy'));
    // A posting the user attached by hand is settled, not waiting on a board.
    expect(out.postingState).toBe('confirmed');
  });

  it('still refuses to attach over a description the user wrote', async () => {
    const { app, a } = await boot();
    const opp = await opportunity(app, ctxOf(a), 'my own notes', false);

    const res = await attach(a, opp.id, { text: 'the board copy' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_described');
  });

  it('attaches to an opportunity with no description at all, as it always did', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await createCompany(app.db, ctx, { name: 'Soylent' });
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Soylent',
      title: 'Staff Product Manager',
      sourceKind: 'manual',
    });

    expect((await attach(a, opp.id, { text: 'the board copy' })).statusCode).toBe(200);
  });
});
