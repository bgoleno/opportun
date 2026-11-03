// The detail fields prefill reads by name (assisted apply M3a,
// https://github.com/bgoleno/opportun/issues/181; tl's design on
// https://github.com/bgoleno/opportun/issues/120#issuecomment-6596240167): firstName, lastName,
// linkedinUrl and websiteUrl, saved as the user typed them, checked on the way in, and covered
// by the review digest. Every name and address here is made up.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { applicationSubmissions, opportunities, resumes } from '../src/db/schema';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { api, requisition } from './submissionFixtures';

const ON = { submissions: true };
const boot = useApi();

interface SubmissionJson {
  id: string;
  status: string;
  reviewDigest: string;
  fields: Record<string, string>;
}

/** A draft for a fresh eligible opportunity, its snapshot settled (a local file: unsupported). */
async function draft(app: FastifyInstance, c: TestClient): Promise<string> {
  const ctx = { userId: c.userId, isAdmin: false };
  const opp = await createOpportunity(app.db, ctx, {
    companyName: 'Example Corp',
    title: `Senior Example Engineer ${newId().slice(-6)}`,
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({ stage: 'interested', atsJobRef: requisition(), postingState: 'confirmed' })
    .where(eq(opportunities.id, opp.id))
    .run();
  const resume = await insertResume(app.db, ctx, {
    kind: 'base',
    title: 'Example Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, resume.id)).run();
  const created = await api(c, 'POST', `/opportunities/${opp.id}/submissions`, {
    idempotencyKey: crypto.randomUUID(),
    resumeId: resume.id,
  });
  expect(created.statusCode, created.body).toBe(201);
  await app.jobs.drain();
  return created.json<SubmissionJson>().id;
}

const patchFields = (c: TestClient, id: string, fields: Record<string, string>) =>
  api(c, 'PATCH', `/submissions/${id}`, { fields });

const read = async (c: TestClient, id: string): Promise<SubmissionJson> =>
  (await api(c, 'GET', `/submissions/${id}`)).json<SubmissionJson>();

async function reviewedWith(
  app: FastifyInstance,
  c: TestClient,
  fields: Record<string, string>,
): Promise<SubmissionJson> {
  const id = await draft(app, c);
  const saved = await patchFields(c, id, fields);
  expect(saved.statusCode, saved.body).toBe(200);
  const res = await api(c, 'POST', `/submissions/${id}/review`, {
    reviewDigest: saved.json<SubmissionJson>().reviewDigest,
    acknowledged: true,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<SubmissionJson>();
}

const PREFILL = {
  firstName: 'Jane',
  lastName: 'Doe-Example',
  linkedinUrl: 'https://www.linkedin.com/in/jane-doe-example',
  websiteUrl: 'https://jane.example.com/portfolio?tab=work',
};

describe('acceptance 1: the four fields are saved as typed and read back', () => {
  it('saves firstName, lastName, linkedinUrl and websiteUrl alongside the others', async () => {
    const { app, a } = await boot(ON);
    const id = await draft(app, a);
    const fields = { ...PREFILL, fullName: 'Jane Doe-Example', email: 'jane@example.com' };
    const res = await patchFields(a, id, fields);
    expect(res.statusCode, res.body).toBe(200);
    expect((await read(a, id)).fields).toEqual(fields);
  });

  it('accepts names in any script and at the length limit, and plain http addresses', async () => {
    const { app, a } = await boot(ON);
    const id = await draft(app, a);
    const accepted: Record<string, string>[] = [
      { firstName: 'Zoë', lastName: 'Núñez de la Peña' },
      { firstName: '李', lastName: 'O’Brien' },
      { firstName: 'J'.repeat(100), lastName: 'D'.repeat(100) },
      { linkedinUrl: 'http://linkedin.example/in/jane', websiteUrl: 'HTTPS://JANE.EXAMPLE' },
    ];
    for (const fields of accepted) {
      const res = await patchFields(a, id, fields);
      expect(res.statusCode, `${JSON.stringify(fields)}: ${res.body}`).toBe(200);
    }
  });
});

describe('acceptance 4: refusals are named 422 reasons, and nothing is saved', () => {
  async function refused(
    app: FastifyInstance,
    c: TestClient,
    fields: Record<string, string>,
    code: string,
    field: string,
  ) {
    const id = await draft(app, c);
    const before = await read(c, id);
    const res = await patchFields(c, id, fields);
    expect(res.statusCode, `${JSON.stringify(fields)}: ${res.body}`).toBe(422);
    const error = res.json<{ error: { code: string; field: string } }>().error;
    expect(error).toMatchObject({ code, field });
    // The value itself is never echoed back: the field's name says which one to fix.
    for (const value of Object.values(fields)) {
      if (value.length > 3) expect(res.body).not.toContain(value);
    }
    const after = await read(c, id);
    expect(after.fields).toEqual(before.fields);
    expect(after.reviewDigest).toBe(before.reviewDigest);
  }

  it('an address that is not http(s) is field_url_invalid, for either link', async () => {
    const { app, a } = await boot(ON);
    for (const bad of [
      'javascript:alert(document.cookie)',
      'data:text/html,hello-example',
      'ftp://files.example.com/cv',
      'www.linkedin.com/in/jane-doe-example',
      'https://',
      'https://exa mple.com/jane',
      ' https://jane.example.com',
      'not a url at all',
      // #186: a username or password, or a format character, is refused too.
      'https://user:pw@jane.example.com/',
      'https://www.linkedin.com@jane.example.com/in/jane',
      'https://jane.example.com/\u202Efdp.exe',
    ]) {
      await refused(app, a, { linkedinUrl: bad }, 'field_url_invalid', 'linkedinUrl');
      await refused(app, a, { websiteUrl: bad }, 'field_url_invalid', 'websiteUrl');
    }
  });

  it('a name that is not one line of plain text, or is too long, is field_name_invalid', async () => {
    const { app, a } = await boot(ON);
    for (const bad of [
      'J'.repeat(101),
      'Jane\nDoe-Example',
      'Jane\u0000Example',
      'Jane\u2028Example',
      ' Jane-Example',
      'Jane-Example\t',
      '',
      '   ',
      // #186: format and bidi control characters, and a joiner with no letter beside it.
      'Jane\u202EExample',
      'Jane\u200BExample',
      '\u200DJane',
    ]) {
      await refused(app, a, { firstName: bad }, 'field_name_invalid', 'firstName');
      await refused(app, a, { lastName: bad }, 'field_name_invalid', 'lastName');
    }
  });

  it('a refused edit leaves a reviewed attempt reviewed, its digest unchanged', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewedWith(app, a, PREFILL);
    const res = await patchFields(a, r.id, { ...PREFILL, websiteUrl: 'javascript:void(0)' });
    expect(res.statusCode, res.body).toBe(422);
    const after = await read(a, r.id);
    expect(after.status).toBe('reviewed');
    expect(after.reviewDigest).toBe(r.reviewDigest);
    expect(after.fields).toEqual(PREFILL);
  });

  it('other keys keep their earlier rules: free text, as before', async () => {
    const { app, a } = await boot(ON);
    const id = await draft(app, a);
    const res = await patchFields(a, id, { links: 'linkedin.com/in/jane, jane.example.com' });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('acceptance 2: the review digest covers each of them', () => {
  for (const [key, changed] of [
    ['firstName', 'Janet'],
    ['lastName', 'Doe-Sample'],
    ['linkedinUrl', 'https://www.linkedin.com/in/someone-else-example'],
    ['websiteUrl', 'https://other.example.com'],
  ] as const) {
    it(`editing ${key} after review sends the attempt back to review`, async () => {
      const { app, a } = await boot(ON);
      const r = await reviewedWith(app, a, PREFILL);
      const res = await patchFields(a, r.id, { ...PREFILL, [key]: changed });
      expect(res.statusCode, res.body).toBe(200);
      const after = res.json<SubmissionJson>();
      expect(after.status).toBe('draft');
      expect(after.reviewDigest).not.toBe(r.reviewDigest);
      // The review the user saw before the edit no longer counts...
      const stale = await api(a, 'POST', `/submissions/${r.id}/review`, {
        reviewDigest: r.reviewDigest,
        acknowledged: true,
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json<{ error: { code: string } }>().error.code).toBe('review_stale');
      // ...and nothing can be handed off until the new state is reviewed.
      const handoff = await api(a, 'POST', `/submissions/${r.id}/handoff`, {});
      expect(handoff.statusCode, handoff.body).not.toBe(200);
      const row = await app.db
        .select({ status: applicationSubmissions.status })
        .from(applicationSubmissions)
        .where(eq(applicationSubmissions.id, r.id))
        .get();
      expect(row?.status).toBe('draft');
    });
  }
});

describe('acceptance 3: attempts without them keep working, with nothing invented', () => {
  it('an attempt with only a full name and free-text links is saved, reviewed and handed off as it is', async () => {
    const { app, a } = await boot(ON);
    const legacy = {
      fullName: 'Jane Doe-Example',
      links: 'https://www.linkedin.com/in/jane-doe-example https://jane.example.com',
    };
    const r = await reviewedWith(app, a, legacy);
    expect(r.fields).toEqual(legacy);
    const handoff = await api(a, 'POST', `/submissions/${r.id}/handoff`, {});
    expect(handoff.statusCode, handoff.body).toBe(200);
    // No first or last name split from the full name, no address lifted from the links.
    expect((await read(a, r.id)).fields).toEqual(legacy);
  });

  it('a row stored before these checks, with a value they would refuse, still reads, reviews and is sent back unchanged', async () => {
    const { app, a } = await boot(ON);
    const id = await draft(app, a);
    const stored = { linkedinUrl: 'linkedin.com/in/jane-doe-example' };
    await app.db
      .update(applicationSubmissions)
      .set({ fields: stored })
      .where(eq(applicationSubmissions.id, id))
      .run();
    const current = await read(a, id);
    expect(current.fields).toEqual(stored);
    const res = await api(a, 'POST', `/submissions/${id}/review`, {
      reviewDigest: current.reviewDigest,
      acknowledged: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    // "Review again" sends the stored fields back unchanged: not refused for a value it kept...
    const again = await patchFields(a, id, { ...stored, email: 'jane@example.com' });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<SubmissionJson>().fields).toEqual({ ...stored, email: 'jane@example.com' });
    // ...but a new value for that field is checked like any other.
    const changed = await patchFields(a, id, { linkedinUrl: 'www.linkedin.com/in/jane' });
    expect(changed.statusCode, changed.body).toBe(422);
    expect(changed.json<{ error: { code: string } }>().error.code).toBe('field_url_invalid');
  });
});
