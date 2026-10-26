import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { attachments, resumeMatchReports, resumes, tailoringSessions } from '../src/db/schema';
import { roleSlug, updateResume } from '../src/repos/resumes';
import { useApi } from './api';
import { connectGoogle, fakeGoogle, type FakeGoogle } from './fakeGoogle';
import { assertIsolated, type TestClient } from './isolation';
import { BASE_DOC_ID, BASE_TEXT, createOpportunity, registerBase } from './resumeFixtures';

let google: FakeGoogle;
const newGoogle = (): FakeGoogle =>
  fakeGoogle({ [BASE_DOC_ID]: { title: 'Jane Base Resume', text: BASE_TEXT } });
const boot = useApi(() => {
  google = newGoogle();
  return { build: { google } };
});

describe('resumes', () => {
  it('registers an existing Google Doc as a base resume with its canonical title', async () => {
    const { a } = await boot();
    await connectGoogle(a);
    const id = await registerBase(a);
    const res = await a.request({ method: 'GET', url: `/api/v1/resumes/${id}` });
    expect(res.json()).toMatchObject({
      kind: 'base',
      title: 'Jane Base Resume',
      store: 'google_doc',
      docRef: BASE_DOC_ID,
      url: `https://docs.google.com/document/d/${BASE_DOC_ID}/edit`,
      status: 'draft',
      opportunityId: null,
      parentResumeId: null,
    });
    const text = await a.request({ method: 'GET', url: `/api/v1/resumes/${id}/text` });
    expect(text.json()).toEqual({ text: BASE_TEXT });
  });

  it('reads text from a local_file resume the same way, proven rather than assumed from the google_doc case', async () => {
    const { app, a } = await boot();
    const now = Date.now();
    const text = 'Avery Chen\nSenior Engineer\n\n- Shipped the billing platform rewrite';
    const written = await app.storage.writeAttachment(Buffer.from(text, 'utf8'));
    await app.db
      .insert(attachments)
      .values({
        id: newId(),
        userId: a.userId,
        opportunityId: null,
        filename: 'Avery Chen.txt',
        mime: 'text/plain',
        bytes: written.bytes,
        sha256: written.sha256,
        storedPath: written.storedPath,
        createdAt: now,
      })
      .run();
    const docRef = (await app.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.sha256, written.sha256))
      .get())!.id;
    await app.db
      .insert(resumes)
      .values({
        id: newId(),
        userId: a.userId,
        kind: 'base',
        opportunityId: null,
        title: 'Avery Chen',
        store: 'local_file',
        docRef,
        parentResumeId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const resumeId = (await app.db
      .select({ id: resumes.id })
      .from(resumes)
      .where(eq(resumes.docRef, docRef))
      .get())!.id;

    const res = await a.request({ method: 'GET', url: `/api/v1/resumes/${resumeId}/text` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text });
  });

  it('refuses to register without a connection, an unreadable doc, or a junk reference', async () => {
    const { a } = await boot();
    const payload = { store: 'google_doc', docRef: BASE_DOC_ID };
    const before = await a.request({ method: 'POST', url: '/api/v1/resumes', payload });
    expect(before.statusCode).toBe(409);
    await connectGoogle(a);
    const missing = await a.request({
      method: 'POST',
      url: '/api/v1/resumes',
      payload: { store: 'google_doc', docRef: 'NoSuchDoc_0123456789' },
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe('google_doc_unavailable');
    const junk = await a.request({
      method: 'POST',
      url: '/api/v1/resumes',
      payload: { store: 'google_doc', docRef: 'https://evil.example.com/x' },
    });
    expect(junk.statusCode).toBe(400);
  });

  it('creates a tailored copy named by the template and linked to opportunity and base', async () => {
    const { a } = await boot();
    await connectGoogle(a);
    const baseId = await registerBase(a);
    const oppId = await createOpportunity(a);
    const res = await a.request({
      method: 'POST',
      url: '/api/v1/resumes',
      payload: { baseResumeId: baseId, opportunityId: oppId },
    });
    expect(res.statusCode).toBe(201);
    const expectedName = 'isolation-a@example.com-Acme-senior_platform_engineer_go_k8s';
    expect(google.copies).toEqual([
      { fileId: BASE_DOC_ID, name: expectedName, newId: expect.any(String) },
    ]);
    expect(res.json()).toMatchObject({
      kind: 'tailored',
      title: expectedName,
      docRef: google.copies[0]!.newId,
      opportunityId: oppId,
      parentResumeId: baseId,
      status: 'draft',
    });
    const listed = await a.request({
      method: 'GET',
      url: `/api/v1/resumes?opportunityId=${oppId}`,
    });
    expect(listed.json().items.map((r: { id: string }) => r.id)).toEqual([res.json().id]);
  });

  it('uses a custom naming template and rejects unknown placeholders', async () => {
    const { a } = await boot();
    const bad = await a.request({
      method: 'PUT',
      url: '/api/v1/settings/resume-naming-template',
      payload: { template: '{{company}} {{salary}}' },
    });
    expect(bad.statusCode).toBe(400);
    const def = await a.request({ method: 'GET', url: '/api/v1/settings/resume-naming-template' });
    expect(def.json()).toEqual({ template: '{{displayName}}-{{company}}-{{roleSlug}}' });
    const put = await a.request({
      method: 'PUT',
      url: '/api/v1/settings/resume-naming-template',
      payload: { template: 'Resume {{company}} ({{roleSlug}})' },
    });
    expect(put.statusCode).toBe(200);
    await connectGoogle(a);
    const baseId = await registerBase(a);
    const oppId = await createOpportunity(a, 'Staff SRE');
    await a.request({
      method: 'POST',
      url: '/api/v1/resumes',
      payload: { baseResumeId: baseId, opportunityId: oppId },
    });
    expect(google.copies[0]!.name).toBe('Resume Acme (staff_sre)');
  });

  it('slugs a role title: lowercase, non-alphanumeric runs collapsed to underscores', () => {
    expect(roleSlug('Senior Platform Engineer, Go/K8s')).toBe('senior_platform_engineer_go_k8s');
    expect(roleSlug('  C++ Dev (II) ')).toBe('c_dev_ii');
  });

  it('requires submittedTo to move to submitted, and stamps submittedAt', async () => {
    const { a } = await boot();
    await connectGoogle(a);
    const id = await registerBase(a);
    const url = `/api/v1/resumes/${id}`;
    const without = await a.request({ method: 'PATCH', url, payload: { status: 'submitted' } });
    expect(without.statusCode).toBe(422);
    expect(without.json().error.code).toBe('submitted_to_required');
    expect((await a.request({ method: 'GET', url })).json().status).toBe('draft');

    const review = await a.request({ method: 'PATCH', url, payload: { status: 'in_review' } });
    expect(review.json().status).toBe('in_review');
    const before = Date.now();
    const sent = await a.request({
      method: 'PATCH',
      url,
      payload: { status: 'submitted', submittedTo: 'Acme careers portal' },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: 'submitted', submittedTo: 'Acme careers portal' });
    expect(sent.json().submittedAt).toBeGreaterThanOrEqual(before);

    const stray = await a.request({
      method: 'PATCH',
      url: url,
      payload: { status: 'final', submittedTo: 'x' },
    });
    expect(stray.statusCode).toBe(422);
    const back = await a.request({ method: 'PATCH', url, payload: { status: 'final' } });
    expect(back.json()).toMatchObject({ status: 'final', submittedTo: null, submittedAt: null });
  });

  it("cannot copy another user's base or link another user's opportunity", async () => {
    const { a, b } = await boot();
    await connectGoogle(a);
    await connectGoogle(b);
    const aBase = await registerBase(a);
    const aOpp = await createOpportunity(a);
    const bBase = await registerBase(b);
    const bOpp = await createOpportunity(b);
    for (const payload of [
      { baseResumeId: aBase, opportunityId: bOpp },
      { baseResumeId: bBase, opportunityId: aOpp },
    ]) {
      const res = await b.request({ method: 'POST', url: '/api/v1/resumes', payload });
      expect(res.statusCode).toBe(404);
    }
    expect(google.copies).toEqual([]);
    const list = await b.request({ method: 'GET', url: '/api/v1/resumes' });
    expect(list.json().items.map((r: { id: string }) => r.id)).toEqual([bBase]);
  });

  describe('attach, detach and move (#77)', () => {
    async function tailoredFor(a: TestClient, oppId: string): Promise<string> {
      await connectGoogle(a);
      const baseId = await registerBase(a);
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/resumes',
        payload: { baseResumeId: baseId, opportunityId: oppId },
      });
      return res.json().id as string;
    }

    it('absent opportunityId leaves the link alone', async () => {
      const { a } = await boot();
      const oppId = await createOpportunity(a);
      const id = await tailoredFor(a, oppId);
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/resumes/${id}`,
        payload: { title: 'Renamed' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ title: 'Renamed', opportunityId: oppId });
    });

    it('opportunityId: null detaches, and changes nothing else', async () => {
      const { a } = await boot();
      const oppId = await createOpportunity(a);
      const id = await tailoredFor(a, oppId);
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/resumes/${id}`,
        payload: { opportunityId: null },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ opportunityId: null, kind: 'tailored', status: 'draft' });
    });

    it('moves an attached resume to a different opportunity in one step, no detach first', async () => {
      const { a } = await boot();
      const oppA = await createOpportunity(a, 'Role A');
      const oppB = await createOpportunity(a, 'Role B');
      const id = await tailoredFor(a, oppA);
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/resumes/${id}`,
        payload: { opportunityId: oppB },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ opportunityId: oppB });
    });

    it('refuses an opportunityId patch on a base resume, attach or detach, and never changes kind', async () => {
      const { a } = await boot();
      await connectGoogle(a);
      const baseId = await registerBase(a);
      const oppId = await createOpportunity(a);
      const attach = await a.request({
        method: 'PATCH',
        url: `/api/v1/resumes/${baseId}`,
        payload: { opportunityId: oppId },
      });
      expect(attach.statusCode).toBe(422);
      expect(attach.json().error.code).toBe('base_cannot_attach');
      const detach = await a.request({
        method: 'PATCH',
        url: `/api/v1/resumes/${baseId}`,
        payload: { opportunityId: null },
      });
      expect(detach.statusCode).toBe(422);
      const after = await a.request({ method: 'GET', url: `/api/v1/resumes/${baseId}` });
      expect(after.json()).toMatchObject({ kind: 'base', opportunityId: null });
    });

    it("another user's opportunity id is a 404 on PATCH, not a successful link", async () => {
      const { a, b } = await boot();
      const oppA = await createOpportunity(a);
      const oppB = await createOpportunity(b);
      const id = await tailoredFor(a, oppA);
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/resumes/${id}`,
        payload: { opportunityId: oppB },
      });
      expect(res.statusCode).toBe(404);
      const after = await a.request({ method: 'GET', url: `/api/v1/resumes/${id}` });
      expect(after.json().opportunityId).toBe(oppA);
    });

    it("refuses another user's opportunity id at the repo layer too, called directly", async () => {
      // routes/resumes.ts already blocks this with its own pre-check (the test above), but
      // updateResume itself must not rely on that: a second caller added later, or that route
      // check being dropped, must not turn into a silent cross-tenant write.
      const { app, a, b } = await boot();
      const oppA = await createOpportunity(a);
      const oppB = await createOpportunity(b);
      const id = await tailoredFor(a, oppA);
      const ctx = { userId: a.userId, isAdmin: false };
      await expect(updateResume(app.db, ctx, id, { opportunityId: oppB })).rejects.toMatchObject({
        statusCode: 404,
      });
      const row = await app.db.select().from(resumes).where(eq(resumes.id, id)).get();
      expect(row?.opportunityId).toBe(oppA);
    });

    it('POST /resumes registers an existing doc and attaches it in one step, as tailored with no parent', async () => {
      const { a } = await boot();
      await connectGoogle(a);
      const oppId = await createOpportunity(a);
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/resumes',
        payload: {
          store: 'google_doc',
          docRef: `https://docs.google.com/document/d/${BASE_DOC_ID}/edit?usp=sharing`,
          opportunityId: oppId,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        kind: 'tailored',
        opportunityId: oppId,
        parentResumeId: null,
      });
    });

    it("another user's opportunity id is a 404 on the register-and-attach POST too", async () => {
      const { a, b } = await boot();
      await connectGoogle(a);
      const oppB = await createOpportunity(b);
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/resumes',
        payload: {
          store: 'google_doc',
          docRef: `https://docs.google.com/document/d/${BASE_DOC_ID}/edit?usp=sharing`,
          opportunityId: oppB,
        },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('delete and archive (#70)', () => {
    async function submit(a: TestClient, id: string): Promise<void> {
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/resumes/${id}`,
        payload: { status: 'submitted', submittedTo: 'Acme careers portal' },
      });
      expect(res.statusCode).toBe(200);
    }

    it('hard-deletes a resume that was never submitted', async () => {
      const { a } = await boot();
      await connectGoogle(a);
      const id = await registerBase(a);
      const res = await a.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: 'deleted' });
      const after = await a.request({ method: 'GET', url: `/api/v1/resumes/${id}` });
      expect(after.statusCode).toBe(404);
    });

    it('archives, never deletes, a submitted resume: status and the opportunity link survive', async () => {
      const { a } = await boot();
      await connectGoogle(a);
      const baseId = await registerBase(a);
      const oppId = await createOpportunity(a);
      const tailored = await a.request({
        method: 'POST',
        url: '/api/v1/resumes',
        payload: { baseResumeId: baseId, opportunityId: oppId },
      });
      const tailoredId = tailored.json().id as string;
      await submit(a, tailoredId);

      const res = await a.request({ method: 'DELETE', url: `/api/v1/resumes/${tailoredId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        outcome: 'archived',
        resume: { id: tailoredId, status: 'submitted', opportunityId: oppId },
      });
      expect(res.json().resume.archivedAt).toEqual(expect.any(Number));

      // A GET proves it, not just the delete response: still there, still linked, status untouched.
      const after = await a.request({ method: 'GET', url: `/api/v1/resumes/${tailoredId}` });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({ status: 'submitted', opportunityId: oppId });
      expect(after.json().archivedAt).toEqual(res.json().resume.archivedAt);
    });

    it('archiving does not cascade: a tailoring session for the resume survives', async () => {
      const { a, app } = await boot();
      await connectGoogle(a);
      const id = await registerBase(a);
      await submit(a, id);
      const sessionId = newId();
      await app.db
        .insert(tailoringSessions)
        .values({
          id: sessionId,
          userId: a.userId,
          resumeId: id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();

      const res = await a.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` });
      expect(res.json()).toMatchObject({ outcome: 'archived' });

      const survived = await app.db
        .select()
        .from(tailoringSessions)
        .where(eq(tailoringSessions.id, sessionId))
        .get();
      expect(survived?.resumeId).toBe(id);
    });

    it('hard-deleting a resume cascades to its match report (#175)', async () => {
      const { a, app } = await boot();
      await connectGoogle(a);
      const id = await registerBase(a);
      const oppId = await createOpportunity(a);
      await app.db
        .insert(resumeMatchReports)
        .values({
          userId: a.userId,
          resumeId: id,
          opportunityId: oppId,
          report: { score: 1, missingKeywords: [], weakAreas: [], summary: 's' },
          scoredAt: Date.now(),
        })
        .run();

      const res = await a.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` });
      expect(res.json()).toEqual({ outcome: 'deleted' });

      const survived = await app.db
        .select()
        .from(resumeMatchReports)
        .where(eq(resumeMatchReports.resumeId, id))
        .all();
      expect(survived).toEqual([]);
    });

    it('archiving an already-archived resume is a no-op that reports archived again', async () => {
      const { a } = await boot();
      await connectGoogle(a);
      const id = await registerBase(a);
      await submit(a, id);
      const first = await a.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` });
      const second = await a.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ outcome: 'archived' });
      expect(second.json().resume.archivedAt).toBe(first.json().resume.archivedAt);
    });

    it('deleting a base detaches its tailored copies instead of removing them', async () => {
      const { a } = await boot();
      await connectGoogle(a);
      const baseId = await registerBase(a);
      const oppId = await createOpportunity(a);
      const tailored = await a.request({
        method: 'POST',
        url: '/api/v1/resumes',
        payload: { baseResumeId: baseId, opportunityId: oppId },
      });
      const tailoredId = tailored.json().id as string;

      const res = await a.request({ method: 'DELETE', url: `/api/v1/resumes/${baseId}` });
      expect(res.json()).toEqual({ outcome: 'deleted' });

      const after = await a.request({ method: 'GET', url: `/api/v1/resumes/${tailoredId}` });
      expect(after.statusCode).toBe(200);
      expect(after.json().parentResumeId).toBeNull();
    });
  });

  describe('isolation', () => {
    const build = () => ({ google: newGoogle() });
    const create = async (c: TestClient) => {
      await connectGoogle(c);
      return registerBase(c);
    };
    for (const [name, read] of [
      [
        'resume',
        (c: TestClient, id: string) => c.request({ method: 'GET', url: `/api/v1/resumes/${id}` }),
      ],
      [
        'resume text',
        (c: TestClient, id: string) =>
          c.request({ method: 'GET', url: `/api/v1/resumes/${id}/text` }),
      ],
      [
        'resume status',
        (c: TestClient, id: string) =>
          c.request({
            method: 'PATCH',
            url: `/api/v1/resumes/${id}`,
            payload: { status: 'final' },
          }),
      ],
      [
        'resume delete',
        (c: TestClient, id: string) =>
          c.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` }),
      ],
    ] as const) {
      // A fresh fake per app: each assertIsolated boots its own.
      assertIsolated({ name, build: build(), create, read });
    }
  });
});

describe('drive search (#136)', () => {
  it('distinguishes not connected, a document match, and no match, as three different outcomes', async () => {
    const { a } = await boot();
    // Not connected (no client configured yet, at that): a 409 before any Drive call is made,
    // same as every other resumes route that needs Google (registerBase's own guard, above).
    const notConnected = await a.request({ method: 'GET', url: '/api/v1/resumes/drive-search' });
    expect(notConnected.statusCode).toBe(409);

    await connectGoogle(a);
    google.drive.set('folder-1', {
      id: 'folder-1',
      name: 'Resumes',
      modifiedTime: '',
      parentId: null,
      isFolder: true,
    });
    google.drive.set('doc-1', {
      id: 'doc-1',
      name: 'Platform Engineer Resume',
      modifiedTime: '2026-10-18T00:00:00.000Z',
      parentId: 'folder-1',
    });

    const match = await a.request({
      method: 'GET',
      url: '/api/v1/resumes/drive-search?q=Platform',
    });
    expect(match.statusCode).toBe(200);
    expect(match.json()).toEqual({
      files: [
        {
          id: 'doc-1',
          name: 'Platform Engineer Resume',
          modifiedTime: '2026-10-18T00:00:00.000Z',
          folderName: 'Resumes',
        },
      ],
    });

    const noMatch = await a.request({
      method: 'GET',
      url: '/api/v1/resumes/drive-search?q=Cover+Letter',
    });
    expect(noMatch.statusCode).toBe(200);
    expect(noMatch.json()).toEqual({ files: [] });
  });

  it('an empty query returns the most recently modified documents', async () => {
    const { a } = await boot();
    await connectGoogle(a);
    google.drive.set('old', {
      id: 'old',
      name: 'Old Resume',
      modifiedTime: '2024-01-01T00:00:00.000Z',
      parentId: null,
    });
    google.drive.set('new', {
      id: 'new',
      name: 'New Resume',
      modifiedTime: '2026-10-01T00:00:00.000Z',
      parentId: null,
    });

    const res = await a.request({ method: 'GET', url: '/api/v1/resumes/drive-search' });
    expect(res.json().files.map((f: { id: string }) => f.id)).toEqual(['new', 'old']);
  });

  it('pages through Drive’s own pageToken rather than an offset', async () => {
    const { a } = await boot();
    await connectGoogle(a);
    for (const [id, day] of [
      ['a', '03'],
      ['b', '02'],
      ['c', '01'],
    ] as const) {
      google.drive.set(id, {
        id,
        name: `Resume ${id}`,
        modifiedTime: `2026-10-${day}T00:00:00.000Z`,
        parentId: null,
      });
    }

    const first = await a.request({
      method: 'GET',
      url: '/api/v1/resumes/drive-search?limit=1',
    });
    const firstBody = first.json() as { files: { id: string }[]; nextPageToken?: string };
    expect(firstBody.files.map((f) => f.id)).toEqual(['a']);
    expect(firstBody.nextPageToken).toBeDefined();

    const second = await a.request({
      method: 'GET',
      url: `/api/v1/resumes/drive-search?limit=1&pageToken=${firstBody.nextPageToken}`,
    });
    const secondBody = second.json() as { files: { id: string }[]; nextPageToken?: string };
    expect(secondBody.files.map((f) => f.id)).toEqual(['b']);
  });

  it('tells a revoked or expired connection apart from never having connected at all', async () => {
    const { a } = await boot();
    await connectGoogle(a);
    google.searchDriveFiles = async () => {
      const err = new Error('invalid_grant') as Error & { response: { status: number } };
      err.response = { status: 401 };
      throw err;
    };
    const res = await a.request({ method: 'GET', url: '/api/v1/resumes/drive-search' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'google_reauth_required' } });
  });
});
