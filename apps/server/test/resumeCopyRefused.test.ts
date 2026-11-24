// A create that copies a resume leaves no document behind
// (https://github.com/bgoleno/opportun/issues/962): everything that can refuse it is asked before the
// copy, and what goes while the copy is made is left out of the resume, as it would be had it gone a
// moment later. Nothing is ever removed from a resume store.
import { AsyncResource } from 'node:async_hooks';
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { onSlowTransaction } from '../src/db/gate';
import { attachments, obsSpans, opportunities, resumes, users } from '../src/db/schema';
import { USER_MESSAGE_MAX } from '../src/lib/errors';
import { setRaceHook } from '../src/lib/racePoints';
import { setCollecting } from '../src/obs';
import { flushSpans } from '../src/obs/tracing';
import { deleteOpportunity } from '../src/repos/opportunities';
import { deleteResume, insertResume } from '../src/repos/resumes';
import type { UserCtx } from '../src/repos/base';
import { useApi } from './api';
import { testDialect, withFailingInsert } from './db';
import { connectGoogle, fakeGoogle, type FakeGoogle } from './fakeGoogle';
import { fakeReactiveResume, RR_BASE_ID, RR_ORIGIN, type FakeRr } from './fakeReactiveResume';
import { captureLogs } from './helpers';
import type { TestClient } from './isolation';
import { heldOpen, someoneBlocked } from './race';
import { BASE_DOC_ID, BASE_TEXT, createOpportunity } from './resumeFixtures';

const RR_KEY = 'rr-key-alice-0123456789';
let google: FakeGoogle;
let rr: FakeRr;
let logs = captureLogs();
const boot = useApi(() => {
  google = fakeGoogle({ [BASE_DOC_ID]: { title: 'Jane Base Resume', text: BASE_TEXT } });
  rr = fakeReactiveResume();
  rr.keys.set(RR_KEY, 'alice');
  rr.seed('alice', { id: RR_BASE_ID });
  logs = captureLogs();
  return { build: { google, rrFetch: rr.fetch }, logStream: logs };
});
afterEach(() => setCollecting(false));

type Store = 'local_file' | 'google_doc' | 'reactive_resume';
const STORES: Store[] = ['local_file', 'google_doc', 'reactive_resume'];
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

async function scene(store: Store) {
  const { app, a, b } = await boot({ logLevel: 'debug' });
  onSlowTransaction(() => undefined); // parked on purpose
  let docRef = BASE_DOC_ID;
  if (store === 'google_doc') await connectGoogle(a);
  if (store === 'reactive_resume') {
    docRef = RR_BASE_ID;
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/integrations/reactive-resume',
      payload: { baseUrl: RR_ORIGIN, apiKey: RR_KEY },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  if (store === 'local_file') {
    const { storedPath, sha256, bytes } = await app.storage.writeAttachment(Buffer.from(BASE_TEXT));
    docRef = newId();
    await app.db
      .insert(attachments)
      .values({
        id: docRef,
        userId: a.userId,
        opportunityId: null,
        filename: 'Base.txt',
        mime: 'text/plain',
        bytes,
        sha256,
        storedPath,
        createdAt: Date.now(),
      })
      .run();
  }
  const base = await insertResume(app.db, ctxOf(a), {
    kind: 'base',
    title: 'Base',
    store,
    docRef,
    opportunityId: null,
    parentResumeId: null,
  });
  const oppId = await createOpportunity(a);
  /** The documents the store has, by id. */
  const documents = async (): Promise<string[]> =>
    store === 'google_doc'
      ? [...google.docs.keys()]
      : store === 'reactive_resume'
        ? [...rr.resumes.keys()]
        : (await app.db.select({ id: attachments.id }).from(attachments).all()).map((r) => r.id);
  const before = await documents();
  const made = async () => (await documents()).filter((id) => !before.includes(id));
  /** What was asked of the store: every request but a read. */
  const asked = (): string[] => [
    ...google.copies.map((c) => `copy ${c.fileId}`),
    ...google.batchUpdates.map((u) => `update ${u.documentId}`),
    ...rr.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
  ];
  const create = (payload = { baseResumeId: base.id, opportunityId: oppId }) =>
    a.request({ method: 'POST', url: '/api/v1/resumes', payload });
  const tailored = async () =>
    (await app.db.select().from(resumes).where(eq(resumes.userId, a.userId)).all()).filter(
      (r) => r.kind === 'tailored',
    );
  return { app, a, b, ctx: ctxOf(a), base, oppId, made, asked, create, tailored };
}
type Scene = Awaited<ReturnType<typeof scene>>;

/** Once, when the copy has been made and before its row is written. */
function onceCopied(doit: () => Promise<unknown>): void {
  let done = false;
  setRaceHook(async (point) => {
    if (point !== 'resumes.copied' || done) return;
    done = true;
    await doit();
  });
}
const failAt = (point: string, err: () => Error) =>
  setRaceHook(async (reached) => {
    if (reached === point) throw err();
  });
const merged = (s: Scene, other: string) =>
  s.a.request({
    method: 'POST',
    url: `/api/v1/opportunities/${other}/merge`,
    payload: { otherId: s.oppId },
  });

describe.each(STORES)('a copy in %s', (store) => {
  type Case = [string, (s: Scene) => Promise<unknown>, { opportunity: boolean; base: boolean }];
  const CASES: Case[] = [
    ['nothing', async () => undefined, { opportunity: true, base: true }],
    [
      'the opportunity',
      (s) => deleteOpportunity(s.app.db, s.ctx, s.oppId),
      { opportunity: false, base: true },
    ],
    [
      'the base',
      (s) => deleteResume(s.app.db, s.ctx, s.base.id),
      { opportunity: true, base: false },
    ],
    [
      'both',
      async (s) => {
        await deleteOpportunity(s.app.db, s.ctx, s.oppId);
        await deleteResume(s.app.db, s.ctx, s.base.id);
      },
      { opportunity: false, base: false },
    ],
    [
      'the opportunity, into another by a merge,',
      async (s) => {
        const other = await createOpportunity(s.a, 'Another Job');
        const res = await merged(s, other);
        expect(res.statusCode, res.body).toBe(200);
      },
      { opportunity: false, base: true },
    ],
  ];
  it.each(CASES)('%s gone meanwhile: it is the new resume’s', async (_w, meanwhile, stays) => {
    const s = await scene(store);
    onceCopied(() => meanwhile(s));
    const res = await s.create();
    expect(res.statusCode, res.body).toBe(201);
    const row = (await s.tailored())[0]!;
    expect(await s.tailored()).toHaveLength(1);
    expect(row).toMatchObject({
      store,
      opportunityId: stays.opportunity ? s.oppId : null,
      parentResumeId: stays.base ? s.base.id : null,
    });
    expect(res.json()).toMatchObject({
      id: row.id,
      docRef: row.docRef,
      opportunityId: row.opportunityId,
      parentResumeId: row.parentResumeId,
    });
    // One new document, and it is this resume's; nothing else was asked of the store.
    expect(await s.made()).toEqual([row.docRef]);
    expect(s.asked()).toHaveLength(store === 'local_file' ? 0 : 1);
  });

  it.each<[string, (s: Scene) => Promise<unknown>]>([
    ['an opportunity that has gone already', (s) => deleteOpportunity(s.app.db, s.ctx, s.oppId)],
    ['a base that has gone already', (s) => deleteResume(s.app.db, s.ctx, s.base.id)],
  ])('%s: refused before the copy', async (_w, first) => {
    const s = await scene(store);
    await first(s);
    expect((await s.create()).statusCode).toBe(404);
    expect([await s.made(), s.asked(), await s.tailored()]).toEqual([[], [], []]);
  });

  it('another user’s opportunity, or base: refused before the copy', async () => {
    const s = await scene(store);
    const theirs = await createOpportunity(s.b);
    const theirBase = await insertResume(s.app.db, ctxOf(s.b), {
      kind: 'base',
      title: 'Theirs',
      store,
      docRef: s.base.docRef,
      opportunityId: null,
      parentResumeId: null,
    });
    for (const payload of [
      { baseResumeId: s.base.id, opportunityId: theirs },
      { baseResumeId: theirBase.id, opportunityId: s.oppId },
    ]) {
      expect((await s.create(payload)).statusCode).toBe(404);
    }
    expect([await s.made(), s.asked(), await s.tailored()]).toEqual([[], [], []]);
  });

  // Postgres: the insert waits for the row, and then it is gone.
  it.runIf(testDialect === 'postgres').each(['opportunity', 'base'] as const)(
    'a delete that has the %s’s row first is waited for',
    async (which) => {
      const s = await scene(store);
      let held: ReturnType<typeof heldOpen> | undefined;
      onceCopied(async () => {
        held = heldOpen(s.app, (tx) =>
          which === 'opportunity'
            ? tx.delete(opportunities).where(eq(opportunities.id, s.oppId)).run()
            : tx.delete(resumes).where(eq(resumes.id, s.base.id)).run(),
        );
        await held.reached;
      });
      const creating = s.create();
      expect(await someoneBlocked(s.app)).toBe(true);
      held!.go();
      await held!.done;
      const res = await creating;
      expect(res.statusCode, res.body).toBe(201);
      const row = (await s.tailored())[0]!;
      expect([row.opportunityId, row.parentResumeId]).toEqual(
        which === 'opportunity' ? [null, s.base.id] : [s.oppId, null],
      );
      expect(await s.made()).toEqual([row.docRef]);
    },
  );

  it.runIf(testDialect === 'postgres')(
    'a delete beside the insert waits for it, and takes the link off',
    async () => {
      const s = await scene(store);
      let deleting: Promise<unknown> | undefined;
      // Another request's, not a part of the transaction it is met in.
      const blocked = AsyncResource.bind(() => someoneBlocked(s.app));
      const remove = AsyncResource.bind(() => deleteOpportunity(s.app.db, s.ctx, s.oppId));
      setRaceHook(async (point) => {
        if (point !== 'resumes.copied.held' || deleting !== undefined) return;
        deleting = remove();
        expect(await blocked()).toBe(true);
      });
      const res = await s.create();
      expect(res.statusCode, res.body).toBe(201);
      await deleting;
      expect((await s.tailored())[0]).toMatchObject({ opportunityId: null });
      expect(await s.made()).toEqual([res.json<{ docRef: string }>().docRef]);
    },
  );

  describe('the row cannot be written', () => {
    const NAME = 'isolation-a@example.com-Acme-senior_platform_engineer_go_k8s';
    const WHERE = { google_doc: 'Google Docs', reactive_resume: 'Reactive Resume', local_file: '' };
    const sentence = `The resume may not have been saved. Look in Resumes: if it is not there, the copy named "${NAME}" was left in ${WHERE[store]}.`;

    it.each<[string, (s: Scene) => Promise<unknown>]>([
      [
        'the connection is cut',
        async () =>
          failAt('resumes.copied.held', () => new Error('Connection terminated unexpectedly')),
      ],
      ['the database refuses it', (s) => withFailingInsert(s.app, 'resumes')],
    ])('%s: the answer says where the copy is, and nothing is removed', async (_w, first) => {
      const s = await scene(store);
      await setCollecting(true);
      await first(s);
      const res = await s.create();
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toEqual(
        store === 'local_file'
          ? { code: 'internal', message: 'Internal server error' }
          : { code: 'resume_not_saved', message: sentence },
      );
      const left = await s.made();
      expect(left).toHaveLength(1);
      expect(s.asked()).toHaveLength(store === 'local_file' ? 0 : 1);
      expect(await s.tailored()).toEqual([]);
      // The cause is in the log, as for any error; the copy is in no line or span.
      expect(logs.lines.filter((l) => l.includes('"unhandled error"'))).toHaveLength(1);
      await flushSpans();
      const spans = JSON.stringify(await s.app.db.select().from(obsSpans).all());
      for (const text of [logs.text(), spans]) {
        expect(text).not.toContain(left[0]!);
        expect(text).not.toContain(NAME);
        expect(text).not.toContain('senior_platform');
      }
    });
  });
});

it('the copy’s name is cut and cleaned before it is said, so that the sentence is whole', async () => {
  const s = await scene('google_doc');
  // The name begins with the user's own. What the store answers for it is not said.
  const displayName = `A${String.fromCharCode(0x202e, 7, 10)}${'\u{1f600}x'.repeat(300)}`;
  await s.app.db.update(users).set({ displayName }).where(eq(users.id, s.a.userId)).run();
  const real = google.copyFile.bind(google);
  google.copyFile = async (client, fileId, name) => ({
    ...(await real(client, fileId, name)),
    name: 'What Google answered',
  });
  failAt('resumes.copied.held', () => new Error('Connection terminated unexpectedly'));
  const res = await s.create();
  const { message } = res.json<{ error: { message: string } }>().error;
  expect(message.length).toBeLessThan(USER_MESSAGE_MAX);
  expect(message).toMatch(/^The resume may not have been saved\. .* was left in Google Docs\.$/u);
  expect(message).not.toMatch(/\p{Cc}|\p{Cf}|\p{Cs}/u);
  expect(message).toContain('"A\u{1f600}x');
});

describe('a store that answers the base’s own document', () => {
  it('Google Docs: the create fails, and no row shares it', async () => {
    const s = await scene('google_doc');
    google.copyFile = async (_c, fileId, name) => ({ id: fileId, name });
    const res = await s.create();
    expect([res.statusCode, res.json().error.code]).toEqual([502, 'resume_copy_failed']);
    expect([await s.made(), await s.tailored()]).toEqual([[], []]);
  });

  it('Reactive Resume: the same', async () => {
    const s = await scene('reactive_resume');
    const real = rr.deps.request;
    rr.deps.request = async (target, signal) => {
      const answer = await real(target, signal);
      if (!target.url.pathname.endsWith('/copies')) return answer;
      return {
        ...answer,
        body: (async function* () {
          yield Buffer.from(JSON.stringify(RR_BASE_ID));
        })(),
      };
    };
    const res = await s.create();
    expect([res.statusCode, res.json().error.code]).toEqual([502, 'resume_copy_failed']);
    expect(await s.tailored()).toEqual([]);
  });
});

it('control: a resume registered for an opportunity that has gone is still not found', async () => {
  const s = await scene('google_doc');
  await deleteOpportunity(s.app.db, s.ctx, s.oppId);
  await expect(
    insertResume(s.app.db, s.ctx, {
      kind: 'tailored',
      title: 'Registered',
      store: 'google_doc',
      docRef: 'AnotherDoc_0123456789',
      opportunityId: s.oppId,
      parentResumeId: null,
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
});
