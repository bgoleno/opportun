import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { bodyTextOf, DEFAULT_GMAIL_QUERY, htmlToText } from '../src/adapters/gmail';
import { communications, jobs, settings, syncState } from '../src/db/schema';
import { CLASSIFY_JOB_KIND, GMAIL_SYNC_ALL_KIND, GMAIL_SYNC_KIND } from '../src/jobs/gmailSync';
import { enqueue } from '../src/jobs/runner';
import { MAIL_LABEL_SETTING } from '../src/adapters/gmail';
import { writeUserSetting } from '../src/repos/userSettings';
import { useApi } from './api';
import { connectGoogle, fakeGoogle, type FakeGoogle, type FakeMail } from './fakeGoogle';
import type { TestClient } from './isolation';
import { queryAll } from './db';

let google: FakeGoogle;
const boot = useApi(() => {
  google = fakeGoogle();
  return { build: { google } };
});

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const HOUR = 3_600_000;

function mail(n: number, extra: Partial<FakeMail> = {}): FakeMail {
  return {
    id: `msg-${n}`,
    threadId: `thread-${n}`,
    from: `Recruiter ${n} <r${n}@acme.example>`,
    to: ['me@example.com', '"Doe, Jane" <jane@example.com>'],
    subject: `Role ${n}`,
    text: `We are hiring. This is message ${n}.`,
    sentAt: T0 + n * HOUR,
    ...extra,
  };
}

async function setup(): Promise<{ app: FastifyInstance; a: TestClient; b: TestClient }> {
  const { app, a, b } = await boot();
  await connectGoogle(a, 'gmail', google);
  return { app, a, b };
}

async function sync(app: FastifyInstance, c: TestClient): Promise<void> {
  const res = await c.request({ method: 'POST', url: '/api/v1/integrations/gmail/sync' });
  expect(res.statusCode, res.body).toBe(202);
  await app.jobs.drain();
  const job = await app.db.select().from(jobs).where(eq(jobs.id, res.json().jobId)).get();
  expect(job?.status, job?.lastError ?? '').toBe('done');
}

async function rows(app: FastifyInstance, userId: string) {
  return await app.db.select().from(communications).where(eq(communications.userId, userId)).all();
}

async function classifyJobs(app: FastifyInstance) {
  return await app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).all();
}

async function cursorOf(app: FastifyInstance, userId: string): Promise<unknown> {
  return (
    await app.db
      .select()
      .from(syncState)
      .where(and(eq(syncState.userId, userId), eq(syncState.integration, 'gmail')))
      .get()
  )?.cursor;
}

describe('gmail sync', () => {
  it('initial sync stores every message with its fields, bodies in storage, and the cursor', async () => {
    const { app, a } = await setup();
    for (let n = 1; n <= 5; n++) google.gmail.add(mail(n));
    google.gmail.add(
      mail(6, {
        text: undefined,
        html: '<html><head><style>p{}</style></head><body><p>Hi &amp; welcome</p><script>x()</script><br>Line two: we are hiring</body></html>',
      }),
    );
    google.gmail.add(mail(7, { labelIds: ['SPAM'] }));
    const historyAtStart = google.gmail.historyId;

    await sync(app, a);

    const stored = await rows(app, a.userId);
    expect(stored).toHaveLength(6);
    expect(google.gmail.queries).toEqual([
      DEFAULT_GMAIL_QUERY,
      DEFAULT_GMAIL_QUERY,
      DEFAULT_GMAIL_QUERY,
    ]);
    const m1 = stored.find((r) => r.externalId === 'msg-1')!;
    expect(m1).toMatchObject({
      channel: 'gmail',
      threadKey: 'thread-1',
      from: 'Recruiter 1 <r1@acme.example>',
      to: ['me@example.com', '"Doe, Jane" <jane@example.com>'],
      subject: 'Role 1',
      snippet: 'We are hiring. This is message 1.',
      sentAt: T0 + HOUR,
      classification: null,
      needsReview: false,
    });
    // The body is in neither the row nor on disk (Plan 3 Task 1). It travelled in the classify
    // job's payload, which this helper has already drained and which clears the field when it
    // finishes, so by now the only copy of the message is the one in the user's mailbox.
    //
    // What the row keeps is the provider's snippet. Note what that means for an html message:
    // the careful html-to-text extraction (covered in packages/core mailText tests) now reaches
    // the classifier and nothing else, and the kept text is Gmail's own snippet, crude markup
    // leftovers included. Worth revisiting in Task 3, where the snippet becomes what the user
    // reads in place of the message.
    expect(m1.bodyRef).toBeNull();
    const m6 = stored.find((r) => r.externalId === 'msg-6')!;
    expect(m6.bodyRef).toBeNull();
    expect(m6.snippet).toContain('Hi & welcome');

    expect(await cursorOf(app, a.userId)).toEqual({
      phase: 'incremental',
      historyId: String(historyAtStart),
    });
    const status = await a.request({ method: 'GET', url: '/api/v1/integrations/gmail' });
    expect(status.json()).toMatchObject({ connected: true, count: 6, status: 'ok' });
    expect(status.json().lastSyncAt).toEqual(expect.any(Number));

    // One classification job per new message, for the owner.
    const queued = await classifyJobs(app);
    expect(queued).toHaveLength(6);
    expect(
      new Set(queued.map((j) => (j.payload as { communicationId: string }).communicationId)),
    ).toEqual(new Set(stored.map((r) => r.id)));
    expect(queued.every((j) => j.userId === a.userId)).toBe(true);
  });

  it('incremental sync honors the label scope, not just the first backfill', async () => {
    // C3: the 15-minute cron runs the incremental path. Scoping only the initial listing would
    // leave the steady state pulling the whole mailbox, which is the opposite of what the
    // settings page promises ("mail outside this label is never fetched").
    const { app, a } = await setup();
    google.gmail.add(mail(1, { labelIds: ['INBOX', 'JobSearch'] }));
    await sync(app, a);
    await writeUserSetting(
      app.db,
      { userId: a.userId, isAdmin: false },
      MAIL_LABEL_SETTING,
      'JobSearch',
    );
    google.gmail.calls.length = 0;

    google.gmail.add(mail(2, { labelIds: ['INBOX', 'JobSearch'] }));
    google.gmail.add(mail(3, { labelIds: ['INBOX'] })); // outside the label
    await sync(app, a);

    const stored = await rows(app, a.userId);
    expect(stored.map((r) => r.externalId).sort()).toEqual(['msg-1', 'msg-2']);
  });

  it('learns the mailbox address from the profile, for the deep link back', async () => {
    // Review Focus 4: /u/0 means the browser's first Google account, which need not be the
    // mailbox Opportun syncs. The address comes from the profile call the sync already makes.
    const { app, a } = await setup();
    google.gmail.add(mail(1));

    await sync(app, a);

    const status = await a.request({ method: 'GET', url: '/api/v1/integrations/gmail' });
    expect(status.json().accountEmail).toBe('mailbox@gmail.test');
  });

  it('reports no address before a sync has read the profile', async () => {
    const { a } = await setup();
    const status = await a.request({ method: 'GET', url: '/api/v1/integrations/gmail' });
    expect(status.json().accountEmail).toBeNull();
  });

  it('incremental sync follows history and adds only the new messages', async () => {
    const { app, a } = await setup();
    for (let n = 1; n <= 3; n++) google.gmail.add(mail(n));
    await sync(app, a);
    expect(await rows(app, a.userId)).toHaveLength(3);
    google.gmail.calls.length = 0;

    for (let n = 4; n <= 6; n++) google.gmail.add(mail(n));
    google.gmail.add(mail(7, { labelIds: ['TRASH'] }));
    await sync(app, a);

    expect(google.gmail.calls).not.toContain('messages.list');
    expect(google.gmail.calls).toContain('history.list');
    // Only the three new messages are fetched (the trashed one is skipped from history).
    expect(google.gmail.calls.filter((c) => c === 'messages.get')).toHaveLength(3);
    const stored = await rows(app, a.userId);
    expect(stored.map((r) => r.externalId).sort()).toEqual(
      ['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6'].sort(),
    );
    expect(await classifyJobs(app)).toHaveLength(6);
    expect(await cursorOf(app, a.userId)).toEqual({
      phase: 'incremental',
      historyId: String(google.gmail.historyId),
    });

    // Nothing new: the next sync stores nothing and queues nothing.
    await sync(app, a);
    expect(await rows(app, a.userId)).toHaveLength(6);
    expect(await classifyJobs(app)).toHaveLength(6);
  });

  it('REVIEW FOCUS: an expired history id (404) runs a full resync with no duplicates and no re-classification', async () => {
    const { app, a } = await setup();
    for (let n = 1; n <= 5; n++) google.gmail.add(mail(n));
    await sync(app, a);
    const before = await rows(app, a.userId);
    expect(before).toHaveLength(5);
    // Classification has run for every message.
    await app.db.update(jobs).set({ status: 'done' }).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).run();
    await app.db
      .update(communications)
      .set({ classification: 'solicitation', outreachKind: 'targeted', confidence: 0.9 })
      .where(eq(communications.userId, a.userId))
      .run();
    const jobsBefore = (await classifyJobs(app)).length;

    google.gmail.historyExpired = true;
    google.gmail.calls.length = 0;
    await sync(app, a);

    expect(google.gmail.calls[0]).toBe('history.list');
    expect(google.gmail.calls).toContain('messages.list');
    const after = await rows(app, a.userId);
    expect(after).toHaveLength(before.length);
    const dupes = await queryAll(
      app,
      `SELECT channel, external_id, count(*) AS n FROM communications
          GROUP BY user_id, channel, external_id HAVING count(*) > 1`,
    );
    expect(dupes).toEqual([]);
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(before.map((r) => r.id)));
    // Classification survives the resync and no job was queued again.
    expect(after.every((r) => r.classification === 'solicitation')).toBe(true);
    expect(await classifyJobs(app)).toHaveLength(jobsBefore);
    expect((await classifyJobs(app)).every((j) => j.status === 'done')).toBe(true);
    // The cursor restarts from the mailbox's current history id.
    expect(await cursorOf(app, a.userId)).toEqual({
      phase: 'incremental',
      historyId: String(google.gmail.historyId),
    });

    // A message that arrives later is picked up incrementally and classified once.
    google.gmail.historyExpired = false;
    google.gmail.add(mail(6));
    await sync(app, a);
    expect(await rows(app, a.userId)).toHaveLength(6);
    expect(await classifyJobs(app)).toHaveLength(jobsBefore + 1);
  });

  it('uses the user query setting and resumes an interrupted initial listing', async () => {
    const { app, a } = await setup();
    await app.db
      .insert(settings)
      .values({
        key: `gmail_query:${a.userId}`,
        userId: a.userId,
        value: 'label:jobs newer_than:30d',
        updatedAt: Date.now(),
      })
      .run();
    for (let n = 1; n <= 5; n++) google.gmail.add(mail(n));
    // A crash part way through: the cursor says page 2 of an initial listing.
    await app.db
      .insert(syncState)
      .values({
        userId: a.userId,
        integration: 'gmail',
        cursor: { phase: 'initial', historyId: '1003', pageToken: '2' },
      })
      .run();
    await sync(app, a);
    expect(google.gmail.queries[0]).toBe('label:jobs newer_than:30d');
    expect(google.gmail.calls).not.toContain('profile');
    // Pages from index 2 on: msg-3, msg-2, msg-1 (newest first).
    expect((await rows(app, a.userId)).map((r) => r.externalId).sort()).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
    ]);
    expect(await cursorOf(app, a.userId)).toEqual({ phase: 'incremental', historyId: '1003' });
  });

  it('lookback setting rewrites the query, resets the cursor and shows in status', async () => {
    const { app, a } = await setup();
    for (let n = 1; n <= 2; n++) google.gmail.add(mail(n));
    await sync(app, a);
    expect(await cursorOf(app, a.userId)).toMatchObject({ phase: 'incremental' });

    const put = await a.request({
      method: 'PUT',
      url: '/api/v1/integrations/gmail/lookback',
      payload: { days: 60 },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({ lookbackDays: 60 });
    // The cursor reset makes the next sync re-list the whole new window.
    expect(await cursorOf(app, a.userId)).toBeNull();
    const status = await a.request({ method: 'GET', url: '/api/v1/integrations/gmail' });
    expect(status.json().lookbackDays).toBe(60);

    await sync(app, a);
    expect(google.gmail.queries.at(-1)).toBe('newer_than:60d -in:spam -in:trash');
    // Upserts keep the re-listed messages single.
    expect(await rows(app, a.userId)).toHaveLength(2);

    // Out-of-range values are refused; a hand-edited query reads as null.
    const bad = await a.request({
      method: 'PUT',
      url: '/api/v1/integrations/gmail/lookback',
      payload: { days: 0 },
    });
    expect(bad.statusCode).toBe(400);
    await app.db
      .update(settings)
      .set({ value: 'label:jobs newer_than:30d' })
      .where(eq(settings.key, `gmail_query:${a.userId}`))
      .run();
    const custom = await a.request({ method: 'GET', url: '/api/v1/integrations/gmail' });
    expect(custom.json().lookbackDays).toBeNull();
  });

  it('only ever issues read calls, and asks for gmail.readonly alone', async () => {
    const { app, a } = await boot();
    await a.request({
      method: 'POST',
      url: '/api/v1/integrations/google/client',
      payload: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-value' },
    });
    const res = await a.request({
      method: 'GET',
      url: '/api/v1/integrations/google/connect?scopes=gmail',
    });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().authUrl as string);
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');

    await connectGoogle(a, 'gmail', google);
    for (let n = 1; n <= 3; n++) google.gmail.add(mail(n));
    await sync(app, a);
    google.gmail.add(mail(4));
    await sync(app, a);
    const READS = new Set(['profile', 'messages.list', 'messages.get', 'history.list']);
    expect(google.gmail.calls.every((c) => READS.has(c))).toBe(true);
  });

  it('refuses to sync without the gmail grant and scopes status and sync to the caller', async () => {
    const { app, a, b } = await setup();
    const gmailA = google.gmail;
    const none = await b.request({ method: 'POST', url: '/api/v1/integrations/gmail/sync' });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('gmail_not_connected');
    const docsOnly = await boot();
    await connectGoogle(docsOnly.a);
    const refused = await docsOnly.a.request({
      method: 'POST',
      url: '/api/v1/integrations/gmail/sync',
    });
    expect(refused.statusCode).toBe(409);

    for (let n = 1; n <= 2; n++) gmailA.add(mail(n));
    // A second request while the first is queued returns the same job.
    const first = await a.request({ method: 'POST', url: '/api/v1/integrations/gmail/sync' });
    const second = await a.request({ method: 'POST', url: '/api/v1/integrations/gmail/sync' });
    expect(second.json().jobId).toBe(first.json().jobId);
    await app.jobs.drain();
    const syncJob = await app.db.select().from(jobs).where(eq(jobs.kind, GMAIL_SYNC_KIND)).get();
    expect(syncJob?.userId).toBe(a.userId);

    const statusB = await b.request({ method: 'GET', url: '/api/v1/integrations/gmail' });
    expect(statusB.json()).toEqual({
      connected: false,
      lastSyncAt: null,
      count: 0,
      status: null,
      lookbackDays: 180,
      // The other user's mailbox address is not theirs to learn either.
      accountEmail: null,
    });
    expect(await rows(app, b.userId)).toHaveLength(0);
    const statusA = await a.request({ method: 'GET', url: '/api/v1/integrations/gmail' });
    expect(statusA.json()).toMatchObject({ connected: true, count: 2 });
  });
});

describe('periodic sync', () => {
  it('queues a sync for each user who synced before and still holds the grant', async () => {
    const { app, a, b } = await setup();
    google.gmail.add(mail(1));
    await sync(app, a);
    // b once synced but has no Gmail grant now: nothing is queued for b.
    await app.db.insert(syncState).values({ userId: b.userId, integration: 'gmail' }).run();
    await enqueue(app.db, GMAIL_SYNC_ALL_KIND, {});
    await app.jobs.drain();
    const syncs = await app.db.select().from(jobs).where(eq(jobs.kind, GMAIL_SYNC_KIND)).all();
    expect(syncs.map((j) => j.userId)).toEqual([a.userId, a.userId]);

    // A queued sync for a user without the grant finishes without retrying.
    await enqueue(app.db, GMAIL_SYNC_KIND, {}, { userId: b.userId });
    await app.jobs.drain();
    const bJob = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, GMAIL_SYNC_KIND), eq(jobs.userId, b.userId)))
      .get();
    expect(bJob).toMatchObject({
      status: 'done',
      attempts: 1,
      result: { skipped: 'google_not_configured' },
    });
  });
});

describe('body extraction', () => {
  it('prefers text/plain, falls back to stripped html, and ignores attachments', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    // Real shape (issue #69): multipart/mixed wrapping multipart/alternative with a sibling
    // attachment is the ordinary case for an ATS notification with a logo or a calendar invite,
    // and it is the only shape here that exercises both recursion into nested parts and the
    // attachment-skip branch together. fakeGoogle.ts's flat single-level fixtures never produce
    // this, which is why nothing had run it before.
    expect(
      await bodyTextOf({
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('attached') } },
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/html', body: { data: b64('<b>html</b>') } },
              { mimeType: 'text/plain', body: { data: b64('plain\r\nbody') } },
            ],
          },
        ],
      }),
    ).toBe('plain\nbody');
    expect(htmlToText('<div>A&nbsp;&#39;quoted&#x27;</div><div>B</div><!-- c -->')).toBe(
      "A 'quoted'\nB",
    );
    expect(await bodyTextOf({ mimeType: 'text/plain' })).toBe('');
  });

  it('reads a non-multipart message, body.data directly on the payload', async () => {
    // Real shape (issue #69): an ordinary single-part message has no .parts array at all, body
    // on the payload itself. findPart checks the part it is given before recursing, so this
    // should already work; nothing before this exercised the shape to prove it.
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    expect(
      await bodyTextOf({ mimeType: 'text/plain', body: { data: b64('A short confirmation.') } }),
    ).toBe('A short confirmation.');
  });

  it('reads a part too large to inline through the attachment fetcher it is given', async () => {
    // Real shape (issue #69): Gmail omits body.data and sets body.attachmentId instead once a
    // part is large enough. findPart previously checked body?.data only, so this part resolved
    // to undefined and the caller fell through to the next candidate (then the snippet) with no
    // error and no signal — the sharpest version of the "succeeds with the wrong text" failure
    // mode, because the messages this happens to are the ones most worth getting right.
    const fetched: string[] = [];
    const body = await bodyTextOf(
      { mimeType: 'text/plain', body: { attachmentId: 'att-1', size: 50_000 } },
      async (attachmentId) => {
        fetched.push(attachmentId);
        return Buffer.from('The full posting, too long for Gmail to inline.').toString('base64url');
      },
    );
    expect(body).toBe('The full posting, too long for Gmail to inline.');
    expect(fetched).toEqual(['att-1']);
  });

  it('treats a part too large to inline as not found when no fetcher is given', async () => {
    // The honest fallback (condition 1): without a way to ask for it, this is indistinguishable
    // from an empty part, not a wrong answer dressed up as a right one.
    expect(
      await bodyTextOf({ mimeType: 'text/plain', body: { attachmentId: 'att-1', size: 50_000 } }),
    ).toBe('');
  });

  it('never hands an attachmentId to the fetcher for a named (real) attachment', async () => {
    // isAttachment (a filename) is checked before the mime/attachmentId branch, so a genuine
    // file attachment — a PDF, an image — is skipped rather than read as text, same as it always
    // was for inline attachments with a filename and body.data.
    const fetchAttachment = vi.fn(async () => Buffer.from('binary').toString('base64url'));
    const body = await bodyTextOf(
      {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'application/pdf', filename: 'resume.pdf', body: { attachmentId: 'pdf-1' } },
          { mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64url') } },
        ],
      },
      fetchAttachment,
    );
    expect(body).toBe('hi');
    expect(fetchAttachment).not.toHaveBeenCalled();
  });

  // A posting link is the single most useful thing an HTML mail carries (FR-D7 resolves an
  // opportunity's posting from it), and stripping tags used to throw every href away.
  it('keeps hyperlinks when asked, as "text (url)"', () => {
    expect(
      htmlToText('<p>Apply <a href="https://job-boards.greenhouse.io/acme/jobs/1">here</a></p>', {
        keepLinks: true,
      }),
    ).toBe('Apply here (https://job-boards.greenhouse.io/acme/jobs/1)');
  });

  it('decodes entities in a href so the query survives', () => {
    expect(
      htmlToText('<a href="https://x.example/job?gh_jid=42&amp;board=acme">Role</a>', {
        keepLinks: true,
      }),
    ).toBe('Role (https://x.example/job?gh_jid=42&board=acme)');
  });

  it('does not repeat a link the text already shows', () => {
    expect(
      htmlToText('<a href="https://x.example/job/1">https://x.example/job/1</a>', {
        keepLinks: true,
      }),
    ).toBe('https://x.example/job/1');
  });

  it('emits the bare link for an anchor with no text', () => {
    expect(
      htmlToText('<a href="https://x.example/job/1"><img src="b.png"></a>', { keepLinks: true }),
    ).toBe('(https://x.example/job/1)');
  });

  it('drops links that cannot be followed but keeps their text', () => {
    expect(
      htmlToText(
        '<a href="javascript:go()">A</a> <a href="/careers">B</a> <a href="mailto:x@y.example">C</a>',
        { keepLinks: true },
      ),
    ).toBe('A B C');
  });

  it('leaves links out unless asked', () => {
    expect(htmlToText('<a href="https://x.example/job/1">here</a>')).toBe('here');
  });

  it('keeps links in an html-only message body', async () => {
    const b64 = (v: string) => Buffer.from(v).toString('base64url');
    const body = await bodyTextOf({
      mimeType: 'text/html',
      body: {
        data: b64(
          '<div>Next steps: <a href="https://www.brightforge.example/careers/job?gh_jid=5550003003&amp;board=brightforge">the role</a></div>',
        ),
      },
    });
    expect(body).toContain('gh_jid=5550003003&board=brightforge');
  });
});
