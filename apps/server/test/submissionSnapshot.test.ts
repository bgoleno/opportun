// The resume snapshot of an application attempt (assisted apply M1b,
// https://github.com/bgoleno/opportun/issues/115, with the Tech Lead's answers on that issue).
// Organised by the issue's acceptance criteria. The Google store is a fake whose export answers
// from a map of document refs; the local-file and Reactive Resume stores are the real ones,
// which answer export_unsupported without reading anything. Nothing here contacts Google, an
// employer or an ATS.
import { createHash } from 'node:crypto';
import { newId, type AtsJobRef } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DocumentExportError,
  type DocumentExportFailure,
  type DocumentStore,
} from '../src/adapters/documentStore';
import {
  applicationSubmissions,
  attachments,
  jobs,
  opportunities,
  resumes,
} from '../src/db/schema';
import { ATTACHMENT_SWEEP_GRACE_MS, sweepOrphanedAttachments } from '../src/jobs/attachmentSweep';
import { runNextJob } from '../src/jobs/runner';
import { SNAPSHOT_JOB_KIND } from '../src/jobs/submissionSnapshot';
import type { UserCtx } from '../src/repos/base';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { snapshotBlocksReview } from '../src/repos/submissions';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';
import { pauseAt } from './race';

const ON = { submissions: true };
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);

const ATS_REF: AtsJobRef = {
  kind: 'ats_greenhouse',
  org: 'examplecorp',
  externalId: '1000001',
  url: 'https://boards.greenhouse.io/examplecorp/jobs/1000001',
};

/**
 * The Google store, faked at the DocumentStore boundary: `exportFile` answers from `docs` by
 * ref (or throws `fail`), and records every call. Nothing else may be called.
 */
interface FakeStore extends DocumentStore {
  docs: Map<string, Buffer>;
  calls: { userId: string; ref: string }[];
  fail: Error | null;
}

function fakeGoogleStore(): FakeStore {
  const unused = (): never => {
    throw new Error('the snapshot job must only export');
  };
  const store: FakeStore = {
    docs: new Map(),
    calls: [],
    fail: null,
    registerExisting: unused,
    copyFrom: unused,
    readText: unused,
    applyEdits: unused,
    async exportFile(ctx, ref) {
      store.calls.push({ userId: ctx.userId, ref });
      if (store.fail !== null) throw store.fail;
      const bytes = store.docs.get(ref);
      if (bytes === undefined) throw new DocumentExportError('not_found');
      return { ok: true, bytes, mime: 'application/pdf', filename: `${ref}.pdf` };
    },
  };
  return store;
}

const google = fakeGoogleStore();
beforeEach(() => {
  google.docs.clear();
  google.calls.length = 0;
  google.fail = null;
});
const boot = useApi(() => ({ build: { documentStore: google } }));

async function seedOpportunity(app: FastifyInstance, c: TestClient): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
    title: `Senior Example Engineer ${newId().slice(-6)}`,
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({ stage: 'interested', atsJobRef: ATS_REF, postingState: 'confirmed' })
    .where(eq(opportunities.id, opp.id))
    .run();
  return opp.id;
}

/** A final resume in `store`; for google_doc, its export answers `bytes`. */
async function seedResume(
  app: FastifyInstance,
  c: TestClient,
  store: 'google_doc' | 'local_file' | 'reactive_resume' = 'google_doc',
  bytes: Buffer = pdf('resume one'),
): Promise<{ id: string; docRef: string }> {
  const docRef = store === 'local_file' ? `resumes/${newId()}.txt` : `doc-${newId()}`;
  const r = await insertResume(app.db, ctxOf(c), {
    kind: 'base',
    title: 'Example Resume',
    store,
    docRef,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, r.id)).run();
  if (store === 'google_doc') google.docs.set(docRef, bytes);
  return { id: r.id, docRef };
}

async function createDraft(c: TestClient, oppId: string, resumeId: string) {
  const res = await c.request({
    method: 'POST',
    url: `/api/v1/opportunities/${oppId}/submissions`,
    payload: { idempotencyKey: crypto.randomUUID(), resumeId },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; snapshotState: string };
}

const read = async (c: TestClient, id: string) => {
  const res = await c.request({ method: 'GET', url: `/api/v1/submissions/${id}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    snapshotState: string;
    snapshotError: string | null;
    resumeSha256: string | null;
    resumeTitle: string | null;
    resumeId: string | null;
    resumeAttachmentId: string | null;
  };
};

const download = (c: TestClient, id: string) =>
  c.request({ method: 'GET', url: `/api/v1/submissions/${id}/snapshot` });

const patchResume = (c: TestClient, id: string, resumeId: string) =>
  c.request({ method: 'PATCH', url: `/api/v1/submissions/${id}`, payload: { resumeId } });

/** A draft for a fresh opportunity with a Google resume, its snapshot taken. */
async function readyDraft(app: FastifyInstance, c: TestClient, bytes = pdf('resume one')) {
  const opp = await seedOpportunity(app, c);
  const resume = await seedResume(app, c, 'google_doc', bytes);
  const draft = await createDraft(c, opp, resume.id);
  await app.jobs.drain();
  return { opp, resume, id: draft.id };
}

async function snapshotJobs(app: FastifyInstance) {
  return await app.db.select().from(jobs).where(eq(jobs.kind, SNAPSHOT_JOB_KIND)).all();
}

describe('criterion 1: choosing a resume produces an immutable snapshot', () => {
  it('a new draft is pending, then ready with the PDF stored and its hash recorded', async () => {
    const { app, a } = await boot(ON);
    const bytes = pdf('resume one');
    const opp = await seedOpportunity(app, a);
    const resume = await seedResume(app, a, 'google_doc', bytes);
    const draft = await createDraft(a, opp, resume.id);
    expect(draft.snapshotState).toBe('pending');
    expect(await snapshotJobs(app)).toHaveLength(1);

    await app.jobs.drain();
    const after = await read(a, draft.id);
    expect(after).toMatchObject({
      snapshotState: 'ready',
      snapshotError: null,
      resumeSha256: sha(bytes),
      resumeTitle: 'Example Resume',
    });
    const file = await download(a, draft.id);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.rawPayload.equals(bytes)).toBe(true);
    // The stored row is an attachment of the opportunity, under its content hash.
    const rows = await app.db
      .select()
      .from(attachments)
      .where(eq(attachments.opportunityId, opp))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sha256: sha(bytes), mime: 'application/pdf' });
    // The UI finds the file's name and size in the opportunity's attachments by this id.
    expect(after.resumeAttachmentId).toBe(rows[0]?.id);
  });

  it('the snapshot, hash and title stay the same after the document is edited and deleted', async () => {
    const { app, a } = await boot(ON);
    const bytes = pdf('resume one');
    const { resume, id } = await readyDraft(app, a, bytes);
    const before = await read(a, id);

    // The document changes in Google, the resume is renamed, then deleted outright.
    google.docs.set(resume.docRef, pdf('resume one, edited later'));
    await app.db.update(resumes).set({ title: 'Renamed' }).where(eq(resumes.id, resume.id)).run();
    await app.jobs.drain();
    expect(await read(a, id)).toEqual(before);
    google.docs.delete(resume.docRef);
    await app.db.delete(resumes).where(eq(resumes.id, resume.id)).run();
    await app.jobs.drain();

    const after = await read(a, id);
    expect(after).toMatchObject({
      resumeId: null,
      snapshotState: 'ready',
      resumeSha256: sha(bytes),
      resumeTitle: 'Example Resume',
    });
    const file = await download(a, id);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(bytes)).toBe(true);
  });

  it('the download is a PDF attachment that is never cached or sniffed', async () => {
    const { app, a } = await boot(ON);
    const { id, resume } = await readyDraft(app, a);
    const file = await download(a, id);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toContain('attachment;');
    expect(file.headers['content-disposition']).toContain(`${resume.docRef}.pdf`);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('private, no-store');
  });

  it("exports the owner's own stored resume ref, never anything a request carried (sec)", async () => {
    const { app, a } = await boot(ON);
    const opp = await seedOpportunity(app, a);
    const resume = await seedResume(app, a);
    // A body cannot name a document: the strict schemas refuse any other key.
    const smuggled = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${opp}/submissions`,
      payload: { idempotencyKey: crypto.randomUUID(), resumeId: resume.id, docRef: 'doc-other' },
    });
    expect(smuggled.statusCode).toBe(422);
    const draft = await createDraft(a, opp, resume.id);
    const patched = await a.request({
      method: 'PATCH',
      url: `/api/v1/submissions/${draft.id}`,
      payload: { resumeId: resume.id, docRef: 'doc-other' },
    });
    expect(patched.statusCode).toBe(422);
    await app.jobs.drain();
    expect(google.calls).toEqual([{ userId: a.userId, ref: resume.docRef }]);
    // The job's payload carries the attempt's id and nothing of the resume.
    const [job] = await snapshotJobs(app);
    expect(job?.payload).toEqual({ submissionId: draft.id });
    expect(job?.userId).toBe(a.userId);
  });

  it('choosing another resume takes a new snapshot of it', async () => {
    const { app, a } = await boot(ON);
    const { id } = await readyDraft(app, a, pdf('resume one'));
    const two = pdf('resume two');
    const other = await seedResume(app, a, 'google_doc', two);
    const res = await patchResume(a, id, other.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ snapshotState: 'pending', resumeSha256: null });
    await app.jobs.drain();
    expect(await read(a, id)).toMatchObject({ snapshotState: 'ready', resumeSha256: sha(two) });
    expect((await download(a, id)).rawPayload.equals(two)).toBe(true);
  });

  it('a resume switched while the old one is exported never lands the old bytes (race)', async () => {
    const { app, a } = await boot(ON);
    const one = pdf('resume one');
    const two = pdf('resume two');
    const opp = await seedOpportunity(app, a);
    const first = await seedResume(app, a, 'google_doc', one);
    const second = await seedResume(app, a, 'google_doc', two);
    const draft = await createDraft(a, opp, first.id);

    // The job has exported the first resume and is about to write it.
    const pause = pauseAt('submissions.snapshot.beforeWrite');
    const running = app.jobs.drain();
    await pause.reached;
    const res = await patchResume(a, draft.id, second.id);
    expect(res.statusCode, res.body).toBe(200);
    pause.release();
    await running;
    await app.jobs.drain();

    expect(await read(a, draft.id)).toMatchObject({
      resumeId: second.id,
      snapshotState: 'ready',
      resumeSha256: sha(two),
    });
    expect((await download(a, draft.id)).rawPayload.equals(two)).toBe(true);
    // The first export's attachments row went with its dropped write.
    const firstRows = await app.db
      .select()
      .from(attachments)
      .where(eq(attachments.sha256, sha(one)))
      .all();
    expect(firstRows).toEqual([]);
    expect(google.calls.map((c) => c.ref)).toEqual([first.docRef, second.docRef]);
  });

  it('a draft cancelled while its resume is exported gets no snapshot (race)', async () => {
    const { app, a } = await boot(ON);
    const opp = await seedOpportunity(app, a);
    const resume = await seedResume(app, a);
    const draft = await createDraft(a, opp, resume.id);
    const pause = pauseAt('submissions.snapshot.beforeWrite');
    const running = app.jobs.drain();
    await pause.reached;
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/submissions/${draft.id}/cancel`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    pause.release();
    await running;
    const row = await read(a, draft.id);
    expect(row).toMatchObject({ snapshotState: 'pending', resumeSha256: null });
    expect(await app.db.select().from(attachments).all()).toEqual([]);
  });
});

describe('criterion 2: the attachment sweep keeps a snapshot a submission references', () => {
  it('survives a sweep long after the grace period, while an orphan in the same pass goes', async () => {
    const { app, a } = await boot(ON);
    const bytes = pdf('resume one');
    const { id } = await readyDraft(app, a, bytes);
    const orphan = await app.storage.writeAttachment(pdf('nobody references this'));

    const result = await sweepOrphanedAttachments(app.db, app.storage, {
      now: Date.now() + 10 * ATTACHMENT_SWEEP_GRACE_MS,
    });
    expect(result.deleted).toBe(1); // the sweep did run: the orphan is gone
    expect(await app.storage.attachmentMtime(orphan.storedPath)).toBeUndefined();
    const file = await download(a, id);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(bytes)).toBe(true);
  });
});

describe('criterion 3: a store that cannot export says so, with no hash and no text', () => {
  it.each(['local_file', 'reactive_resume'] as const)(
    'a %s resume is unsupported, with the reason and no file',
    async (store) => {
      const { app, a } = await boot(ON);
      const opp = await seedOpportunity(app, a);
      const resume = await seedResume(app, a, store);
      const draft = await createDraft(a, opp, resume.id);
      await app.jobs.drain();
      expect(await read(a, draft.id)).toMatchObject({
        snapshotState: 'unsupported',
        snapshotError: 'export_unsupported',
        resumeSha256: null,
        resumeAttachmentId: null,
      });
      const file = await download(a, draft.id);
      expect(file.statusCode).toBe(404);
      expect(file.json()).toMatchObject({ error: { code: 'no_snapshot' } });
      expect(await app.db.select().from(attachments).all()).toEqual([]);
      expect(google.calls).toEqual([]);
    },
  );
});

describe('criterion 4: export failures are retried, then the draft shows snapshot failed', () => {
  /**
   * Runs `n` more tries of the snapshot job, on a clock that moves past every backoff. Other
   * jobs the app queued at boot run too, as they come due; only the snapshot job's tries count.
   */
  let clock = 0;
  beforeEach(() => {
    clock = Date.now();
  });
  async function runAttempts(app: FastifyInstance, n: number) {
    const tries = async () => (await snapshotJobs(app))[0]?.attempts ?? 0;
    const target = (await tries()) + n;
    for (let step = 0; step < 50 && (await tries()) < target; step++) {
      clock += 2 * 60 * 60 * 1000;
      const t = clock;
      await runNextJob(app.db, { now: () => t, random: () => 0.5, services: app.jobs.services });
    }
    expect(await tries()).toBe(target);
  }

  it.each(['unavailable', 'rate_limited'] as const)(
    'a retryable %s is tried three times, then recorded failed; the job ends done',
    async (code) => {
      const { app, a } = await boot(ON);
      const opp = await seedOpportunity(app, a);
      const resume = await seedResume(app, a);
      const draft = await createDraft(a, opp, resume.id);
      google.fail = new DocumentExportError(code);

      await runAttempts(app, 2);
      expect((await read(a, draft.id)).snapshotState).toBe('pending');
      expect((await snapshotJobs(app))[0]?.status).toBe('pending');
      await runAttempts(app, 1);

      expect(google.calls).toHaveLength(3);
      expect(await read(a, draft.id)).toMatchObject({
        snapshotState: 'failed',
        snapshotError: code,
        resumeSha256: null,
      });
      const [job] = await snapshotJobs(app);
      expect(job?.status).toBe('done');
      // Still a draft: a failed export is not a failed application.
      const row = await app.db
        .select()
        .from(applicationSubmissions)
        .where(eq(applicationSubmissions.id, draft.id))
        .get();
      expect(row).toMatchObject({ status: 'draft', failureReason: null });
    },
  );

  it.each([
    'not_found',
    'no_access',
    'reauth_required',
    'too_large',
    'not_pdf',
    'rejected',
  ] as const satisfies readonly DocumentExportFailure[])(
    'a permanent %s is recorded failed on the first try',
    async (code) => {
      const { app, a } = await boot(ON);
      const opp = await seedOpportunity(app, a);
      const resume = await seedResume(app, a);
      const draft = await createDraft(a, opp, resume.id);
      google.fail = new DocumentExportError(code);
      await runAttempts(app, 1);
      expect(google.calls).toHaveLength(1);
      expect(await read(a, draft.id)).toMatchObject({
        snapshotState: 'failed',
        snapshotError: code,
      });
      expect((await snapshotJobs(app))[0]?.status).toBe('done');
    },
  );

  it('an unexpected error is retried too, and the last try still settles the draft', async () => {
    const { app, a } = await boot(ON);
    const opp = await seedOpportunity(app, a);
    const resume = await seedResume(app, a);
    const draft = await createDraft(a, opp, resume.id);
    google.fail = new TypeError('a bug of ours');
    await runAttempts(app, 3);
    expect(await read(a, draft.id)).toMatchObject({
      snapshotState: 'failed',
      snapshotError: 'unavailable',
    });
    expect((await snapshotJobs(app))[0]?.status).toBe('done');
  });

  it('a storage failure of ours is retried, and the last try still settles the draft', async () => {
    const { app, a } = await boot(ON);
    const opp = await seedOpportunity(app, a);
    const resume = await seedResume(app, a);
    const draft = await createDraft(a, opp, resume.id);
    const real = app.jobs.services.storage;
    app.jobs.services.storage = Object.assign(Object.create(real) as typeof real, {
      writeAttachment: async () => {
        throw new Error('disk full');
      },
    });
    try {
      await runAttempts(app, 3);
    } finally {
      app.jobs.services.storage = real;
    }
    expect(google.calls).toHaveLength(3);
    expect(await read(a, draft.id)).toMatchObject({
      snapshotState: 'failed',
      snapshotError: 'unavailable',
    });
    expect((await snapshotJobs(app))[0]?.status).toBe('done');
    expect(await app.db.select().from(attachments).all()).toEqual([]);
  });

  it('a resume deleted before its export is recorded failed, not_found, without an export', async () => {
    const { app, a } = await boot(ON);
    const opp = await seedOpportunity(app, a);
    const resume = await seedResume(app, a);
    const draft = await createDraft(a, opp, resume.id);
    await app.db.delete(resumes).where(eq(resumes.id, resume.id)).run();
    await app.jobs.drain();
    expect(await read(a, draft.id)).toMatchObject({
      resumeId: null,
      snapshotState: 'failed',
      snapshotError: 'not_found',
    });
    expect(google.calls).toEqual([]);
  });

  it('choosing the same resume again is the retry', async () => {
    const { app, a } = await boot(ON);
    const opp = await seedOpportunity(app, a);
    const bytes = pdf('resume one');
    const resume = await seedResume(app, a, 'google_doc', bytes);
    const draft = await createDraft(a, opp, resume.id);
    google.fail = new DocumentExportError('no_access');
    await app.jobs.drain();
    expect((await read(a, draft.id)).snapshotState).toBe('failed');

    google.fail = null; // the user shared the document again
    const res = await patchResume(a, draft.id, resume.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ snapshotState: 'pending', snapshotError: null });
    await app.jobs.drain();
    expect(await read(a, draft.id)).toMatchObject({
      snapshotState: 'ready',
      snapshotError: null,
      resumeSha256: sha(bytes),
    });
  });

  it('review waits for a pending or failed snapshot, and may go ahead when ready or unsupported', () => {
    expect(snapshotBlocksReview({ snapshotState: 'pending' })).toBe('snapshot_pending');
    expect(snapshotBlocksReview({ snapshotState: 'failed' })).toBe('snapshot_failed');
    expect(snapshotBlocksReview({ snapshotState: 'ready' })).toBeNull();
    expect(snapshotBlocksReview({ snapshotState: 'unsupported' })).toBeNull();
  });
});

describe('criterion 5: snapshot bytes are served only to the owner', () => {
  assertIsolated({
    name: 'submission snapshots (GET)',
    config: ON,
    build: { documentStore: google },
    create: async (c, app) => (await readyDraft(app, c)).id,
    read: (c, id) => download(c, id),
  });

  it('another user gets the same 404 as for an id that does not exist', async () => {
    const { app, a, b } = await boot(ON);
    const { id } = await readyDraft(app, a);
    const asOther = await download(b, id);
    const missing = await download(b, newId());
    expect(asOther.statusCode).toBe(404);
    expect(asOther.json()).toEqual(missing.json());
  });

  it('is behind the flag like every submission route', async () => {
    const { a } = await boot({ submissions: false });
    const res = await download(a, newId());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'feature_unavailable' } });
  });
});

describe('the snapshot job keeps to its own row', () => {
  it('does nothing for an attempt that is no longer a draft', async () => {
    const { app, a } = await boot(ON);
    const opp = await seedOpportunity(app, a);
    const resume = await seedResume(app, a);
    const draft = await createDraft(a, opp, resume.id);
    await app.db
      .update(applicationSubmissions)
      .set({ status: 'abandoned' })
      .where(and(eq(applicationSubmissions.id, draft.id)))
      .run();
    await app.jobs.drain();
    expect(google.calls).toEqual([]);
    expect(await app.db.select().from(attachments).all()).toEqual([]);
  });
});
