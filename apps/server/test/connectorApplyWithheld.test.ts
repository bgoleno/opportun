// A detail value stored before #186's checks, which would fail them today, never reaches the
// device (https://github.com/bgoleno/opportun/issues/196, tl's ruling): GET
// /connector/apply/current runs each stored field through core's submissionFieldProblem, the
// rule the PATCH uses, leaves out any that fails, and names only its key in `withheld`. Every
// value here is a placeholder.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { applicationSubmissions } from '../src/db/schema';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { api, handedOffAttempt } from './submissionFixtures';

const boot = useApi();
const ON = { submissions: true };
const PASSWORD = 'correct horse battery';

async function token(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'Chrome', scopes: ['apply:assist'], password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

const current = (app: FastifyInstance, t: string, url: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/connector/apply/current?url=${encodeURIComponent(url)}`,
    headers: { authorization: `Bearer ${t}` },
  });

/**
 * A handed-off attempt whose fields were stored as given, past today's checks (a row saved before
 * #186), then reviewed and handed off through the real routes as they stand.
 */
async function storedThenHandedOff(
  app: FastifyInstance,
  c: TestClient,
  fields: Record<string, string>,
) {
  const s = await handedOffAttempt(app, c, { stopAt: 'draft' });
  await app.db
    .update(applicationSubmissions)
    .set({ fields })
    .where(eq(applicationSubmissions.id, s.id))
    .run();
  const now = await api(c, 'GET', `/submissions/${s.id}`);
  const reviewed = await api(c, 'POST', `/submissions/${s.id}/review`, {
    reviewDigest: now.json<{ reviewDigest: string }>().reviewDigest,
    acknowledged: true,
  });
  expect(reviewed.statusCode, reviewed.body).toBe(200);
  const handed = await api(c, 'POST', `/submissions/${s.id}/handoff`, {});
  expect(handed.statusCode, handed.body).toBe(200);
  return s;
}

const BAD_NAME = 'Jane\u202EExample';
const BAD_LINK = 'https://user:pw@jane.example.com/';

describe("#196: /current withholds a stored value that fails today's checks", () => {
  it('a failing name and link are left out of the fields and named in withheld; the rest is sent', async () => {
    const { app, a } = await boot(ON);
    const s = await storedThenHandedOff(app, a, {
      firstName: BAD_NAME,
      lastName: 'Doe-Example',
      linkedinUrl: BAD_LINK,
      websiteUrl: 'https://jane.example.com',
      email: 'jane@example.com',
    });
    const res = await current(app, await token(a), s.ats.url as string);
    expect(res.statusCode, res.body).toBe(200);
    const attempt = res.json<{ attempt: { fields: Record<string, string>; withheld?: string[] } }>()
      .attempt;
    expect(attempt.fields).toEqual({
      lastName: 'Doe-Example',
      websiteUrl: 'https://jane.example.com',
      email: 'jane@example.com',
    });
    expect(attempt.withheld).toEqual(['firstName', 'linkedinUrl']);
    // The values themselves never leave the server.
    expect(res.body).not.toContain('user:pw');
    expect(res.body).not.toContain('Jane');
  });

  it('values that pass are sent as they are, and nothing is withheld', async () => {
    const { app, a } = await boot(ON);
    const fields = {
      firstName: 'Jane',
      lastName: 'Doe-Example',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe-example',
    };
    const s = await storedThenHandedOff(app, a, fields);
    const res = await current(app, await token(a), s.ats.url as string);
    const attempt = res.json<{ attempt: { fields: Record<string, string>; withheld?: string[] } }>()
      .attempt;
    expect(attempt.fields).toEqual(fields);
    expect(attempt.withheld).toBeUndefined();
  });

  it('withholding leaves the attempt as reviewed: the digest still matches, and nothing is rewritten', async () => {
    const { app, a } = await boot(ON);
    const stored = { firstName: BAD_NAME, email: 'jane@example.com' };
    const s = await storedThenHandedOff(app, a, stored);
    await current(app, await token(a), s.ats.url as string);
    const row = await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, s.id))
      .get();
    expect(row?.fields).toEqual(stored);
    expect(row?.status).toBe('handed_off');
  });

  it("a stored email or phone that fails today's checks is withheld too (#203)", async () => {
    const { app, a } = await boot(ON);
    const s = await storedThenHandedOff(app, a, {
      email: 'jane\u200B@example.com',
      phone: '555-CALL-NOW',
      lastName: 'Doe-Example',
    });
    const res = await current(app, await token(a), s.ats.url as string);
    const attempt = res.json<{ attempt: { fields: Record<string, string>; withheld?: string[] } }>()
      .attempt;
    expect(attempt.fields).toEqual({ lastName: 'Doe-Example' });
    expect(attempt.withheld).toEqual(['email', 'phone']);
    expect(res.body).not.toContain('CALL');
  });
});
