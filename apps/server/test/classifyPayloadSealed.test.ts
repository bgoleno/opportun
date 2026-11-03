// A message body exists only in the comms.classify job's payload until that job finishes
// (Plan 3 Task 1), and the runner clears it then. Cleared is not gone: on SQLite the old row
// image stays in the WAL and in free pages, readable with any tool that opens the file
// (https://github.com/bgoleno/opportun/issues/175). So the body is sealed with the instance's
// secretBox key before it is ever written, and only the job, holding that key, opens it.
import { runStructured } from '@opportun/ai';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { communications, jobs } from '../src/db/schema';
import type { ClassifyOutput } from '../src/jobs/classify';
import { CLASSIFY_JOB_KIND, enqueueClassify } from '../src/jobs/mailIngest';
import { enqueue, runDueJobs } from '../src/jobs/runner';
import { bindVaultKey, decryptSecret } from '../src/lib/secretBox';
import { useApi } from './api';
import { queryAll, testDialect } from './db';
import type { TestClient } from './isolation';

const boot = useApi();

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  // The classifier answers "other" (other tasks, such as mail triage, get nothing, as in
  // connectorMail.test.ts); what it was shown is in its calls.
  const other = {
    classification: 'other',
    outreachKind: null,
    mismatchReason: null,
    opportunityMatch: null,
    proposedTransition: null,
    confidence: 0.9,
    hardConstraintViolation: null,
  } satisfies ClassifyOutput;
  vi.mocked(runStructured).mockImplementation(async (_deps, task) =>
    task === 'comms.classify' ? (other as never) : (undefined as never),
  );
});

/** Whether the classifier was shown the sentinel, i.e. the whole body, not the snippet. */
const classifierSaw = (sentinel: string) =>
  vi
    .mocked(runStructured)
    .mock.calls.filter((call) => call[1] === 'comms.classify')
    .some((call) => JSON.stringify(call).includes(sentinel));
const PASSWORD = 'correct horse battery';

/** A body whose sentinel sits far past anything the stored snippet keeps. */
function bodyWith(sentinel: string): string {
  return `${'Thank you for applying. '.repeat(40)}\n${sentinel}\nBest regards, the hiring team.`;
}
const sentinelOf = () => `SENTINEL-${randomBytes(12).toString('hex')}`;

async function pushMessage(app: FastifyInstance, c: TestClient, body: string) {
  const minted = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'MacBook connector', scopes: ['mail:push'], password: PASSWORD },
  });
  expect(minted.statusCode, minted.body).toBe(201);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/connector/mail/batch',
    headers: { authorization: `Bearer ${minted.json<{ token: string }>().token}` },
    payload: {
      messages: [
        {
          externalId: 'apple-mail:sealed-1@mail.example',
          threadKey: 'thread-sealed-1',
          from: 'Recruiter <r1@initech.example>',
          to: ['me@example.com'],
          subject: 'Your application',
          snippet: 'Thank you for applying.',
          bodyText: body,
          sentAt: Date.now() - 60_000,
        },
      ],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const row = await app.db
    .select({ id: communications.id })
    .from(communications)
    .where(eq(communications.userId, c.userId))
    .get();
  return row!.id;
}

async function classifyJob(app: FastifyInstance) {
  return await app.db.select().from(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).get();
}

/** Every byte of the SQLite database and its WAL (and shared memory) as they are on disk. */
async function databaseBytes(sqliteDir: string): Promise<Buffer> {
  const names = (await readdir(sqliteDir)).filter((n) => /\.db(-wal|-shm)?$/.test(n));
  expect(names.some((n) => n.endsWith('.db'))).toBe(true);
  return Buffer.concat(await Promise.all(names.map((n) => readFile(join(sqliteDir, n)))));
}

describe('the classify job carries the body sealed (#175)', () => {
  it('the queued payload holds no plaintext body, only a sealed one that opens to it', async () => {
    const { app, a } = await boot();
    const sentinel = sentinelOf();
    const body = bodyWith(sentinel);
    const id = await pushMessage(app, a, body);
    const job = await classifyJob(app);
    expect(job?.payload).toMatchObject({ communicationId: id });
    expect(JSON.stringify(job?.payload)).not.toContain(sentinel);
    expect(job?.payload).not.toHaveProperty('body');
    const sealed = (job?.payload as { bodySealed?: string }).bodySealed;
    expect(typeof sealed).toBe('string');
    expect(decryptSecret(app.db, sealed!)).toBe(body);
  });

  it('the job still classifies on the whole body it was handed', async () => {
    const { app, a } = await boot();
    const sentinel = sentinelOf();
    await pushMessage(app, a, bodyWith(sentinel));
    await app.jobs.drain();
    const job = await classifyJob(app);
    expect(job?.status, job?.lastError ?? '').toBe('done');
    expect(job?.result).toMatchObject({ status: 'classified', bodySource: 'payload' });
    expect(classifierSaw(sentinel)).toBe(true);
    expect(job?.payload).not.toHaveProperty('bodySealed');
    expect(job?.payload).not.toHaveProperty('body');
  });

  // The raw file is the point of #175: SQLite only. On Postgres the same sealing means a dead
  // tuple or a WAL segment holds ciphertext; that is read from the code path, not from disk here.
  it.runIf(testDialect === 'sqlite')(
    'no plaintext body is in the database file or its WAL, before or after the job, or after a checkpoint',
    async () => {
      const { app, a, dataDir } = await boot();
      const sentinel = sentinelOf();
      await pushMessage(app, a, bodyWith(sentinel));
      expect((await databaseBytes(dataDir)).includes(sentinel)).toBe(false);
      await app.jobs.drain();
      expect((await classifyJob(app))?.status).toBe('done');
      expect((await databaseBytes(dataDir)).includes(sentinel)).toBe(false);
      // Moves every WAL frame, old row images included, into the main file's pages.
      const [checkpoint] = await queryAll<{ busy: number }>(app, 'PRAGMA wal_checkpoint(TRUNCATE)');
      expect(checkpoint?.busy).toBe(0);
      expect((await databaseBytes(dataDir)).includes(sentinel)).toBe(false);
    },
  );

  it('a key that cannot open the body fails the job, and nothing logged or kept holds the body', async () => {
    const { app, a } = await boot();
    const sentinel = sentinelOf();
    const id = await pushMessage(app, a, bodyWith(sentinel));
    // As after a master key change with jobs still queued under the old one.
    bindVaultKey(app.db, randomBytes(32));
    const logged: string[] = [];
    const record =
      (level: string) =>
      (...args: unknown[]) =>
        logged.push(`${level} ${inspect(args, { depth: 8 })}`);
    const log = { info: record('info'), warn: record('warn'), error: record('error') };
    let now = Date.now();
    for (let i = 0; i < 5 && (await classifyJob(app))?.status !== 'dead'; i += 1) {
      await runDueJobs(app.db, {
        services: { ...app.jobs.services, log: log as never },
        now: () => now,
      });
      now += 24 * 60 * 60 * 1000; // past any retry's backoff
    }
    const job = await classifyJob(app);
    expect(job?.status).toBe('dead');
    expect(job?.lastError).toMatch(/could not be decrypted/);
    expect(job?.payload).toEqual({ communicationId: id });
    expect(logged.length).toBeGreaterThan(0);
    expect(vi.mocked(runStructured).mock.calls.some((c) => c[1] === 'comms.classify')).toBe(false);
    for (const line of [...logged, job?.lastError ?? '', JSON.stringify(job)]) {
      expect(line).not.toContain(sentinel);
    }
  });

  // https://github.com/bgoleno/opportun/issues/176 item 3 (qa on #177): the failure names the
  // problem in its own words; the cipher's message, whatever it is, reaches neither the job row
  // nor any log line.
  it("keeps none of the cipher's own error message, in the job row or the log", async () => {
    const { app, a } = await boot();
    await pushMessage(app, a, bodyWith(sentinelOf()));
    const sealed = ((await classifyJob(app))?.payload as { bodySealed: string }).bodySealed;
    bindVaultKey(app.db, randomBytes(32));
    // What the cipher itself says about this payload under the wrong key.
    let cipherMessage = '';
    try {
      decryptSecret(app.db, sealed);
    } catch (err) {
      cipherMessage = (err as Error).message;
    }
    expect(cipherMessage).not.toBe('');
    const logged: string[] = [];
    const record =
      (level: string) =>
      (...args: unknown[]) =>
        logged.push(`${level} ${inspect(args, { depth: 8 })}`);
    const log = { info: record('info'), warn: record('warn'), error: record('error') };
    let now = Date.now();
    for (let i = 0; i < 5 && (await classifyJob(app))?.status !== 'dead'; i += 1) {
      await runDueJobs(app.db, {
        services: { ...app.jobs.services, log: log as never },
        now: () => now,
      });
      now += 24 * 60 * 60 * 1000; // past any retry's backoff
    }
    const job = await classifyJob(app);
    expect(job?.status).toBe('dead');
    expect(logged.length).toBeGreaterThan(0);
    for (const line of [...logged, job?.lastError ?? '', JSON.stringify(job)]) {
      expect(line).not.toContain(cipherMessage);
    }
  });

  it('a job queued before this change, with a plaintext body, still runs and is cleared', async () => {
    const { app, a } = await boot();
    const sentinel = sentinelOf();
    const id = await pushMessage(app, a, 'placeholder');
    // The row an older version wrote: the body in the clear.
    await app.db.delete(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).run();
    await app.db
      .update(communications)
      .set({ classification: null })
      .where(eq(communications.id, id))
      .run();
    await enqueue(
      app.db,
      CLASSIFY_JOB_KIND,
      { communicationId: id, body: bodyWith(sentinel) },
      {
        userId: a.userId,
      },
    );
    await app.jobs.drain();
    const job = await classifyJob(app);
    expect(job?.status, job?.lastError ?? '').toBe('done');
    expect(job?.result).toMatchObject({ status: 'classified', bodySource: 'payload' });
    expect(classifierSaw(sentinel)).toBe(true);
    expect(JSON.stringify(job?.payload)).not.toContain(sentinel);
  });

  it('enqueueClassify without a body writes no body field at all', async () => {
    const { app, a } = await boot();
    const id = await pushMessage(app, a, 'placeholder');
    await app.db.delete(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).run();
    await enqueueClassify(app.db, { userId: a.userId, isAdmin: false }, id);
    expect((await classifyJob(app))?.payload).toEqual({ communicationId: id });
  });
});
