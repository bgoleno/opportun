// https://github.com/bgoleno/opportun/issues/750, the marking pass: a sample of the sentences now
// marked for users, each read from the response as the web shows it (lib/api.ts errorMessage
// reads `message` from the envelope). The scan in userFacingErrors.test.ts covers every marked
// throw; these show the sentence actually reaches the client, through the route's own schema.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { opportunities } from '../src/db/schema';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import { requisition } from './submissionFixtures';

const boot = useApi();

describe('a marked sentence reaches the client (#750)', () => {
  it("a mail filter refused for its pattern says why, echoing the caller's own pattern", async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/mail-filters',
      payload: { pattern: 'nodot', effect: 'deny' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'invalid_pattern', message: 'Not a sender pattern: nodot' },
    });
  });

  it('a Reactive Resume address over http says to use https', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/integrations/reactive-resume',
      payload: { baseUrl: 'http://rr.example.com', apiKey: 'rr-key-750-0123456789' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toEqual({
      code: 'invalid_base_url',
      message: 'Reactive Resume must be reached over https.',
    });
  });

  it('a purge without its confirmation word names the word', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/communications/purge',
      payload: { what: 'mail_bodies', confirm: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'not_confirmed', message: 'Type PURGE to confirm' });
  });

  // #853 (qa's pass 3): two more of #750's marked sentences, pinned as the web reads them.
  it('a Gmail label that cannot go in a query says so', async () => {
    const { a } = await boot();
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/mail-filters/label',
      payload: { label: 'Jobs "2026"' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toEqual({
      code: 'invalid_label',
      message: 'That label cannot be used in a Gmail query',
    });
  });

  it('an application started with no resume asks for one', async () => {
    const { app, a } = await boot({ submissions: true });
    const ctx = { userId: a.userId, isAdmin: false };
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Example Corp',
      title: 'Senior Platform Engineer',
      sourceKind: 'manual',
    });
    await app.db
      .update(opportunities)
      .set({ stage: 'interested', atsJobRef: requisition(), postingState: 'confirmed' })
      .where(eq(opportunities.id, opp.id))
      .run();
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp.id}/submissions`,
      payload: { idempotencyKey: crypto.randomUUID() },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toEqual({ code: 'resume_required', message: 'Choose a resume.' });
  });
});
