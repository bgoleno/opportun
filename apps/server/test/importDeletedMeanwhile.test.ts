// An import row whose opportunity is deleted while the import runs says so and the rest is imported,
// with nothing written for it (https://github.com/bgoleno/opportun/issues/934). Each order is forced:
// the import is parked where it has read the opportunity, and the delete runs, or is let wait, there.
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentStore } from '../src/adapters/documentStore';
import { onSlowTransaction } from '../src/db/gate';
import { activities, jobs, opportunities, resumes, stageHistory } from '../src/db/schema';
import { packFromZip, runImport, type ImportReport } from '../src/lib/importer';
import { setRaceHook } from '../src/lib/racePoints';
import { useApi } from './api';
import { queryAll, testDialect, withFailingWrite } from './db';
import type { TestClient } from './isolation';
import { someoneBlocked } from './race';

const HEADER =
  'company,title,stage,posting_url,location,source,applied_at,dismissed_reason,notes_file,resume_doc_ref';
const GONE = 'the opportunity was deleted while the import ran';
const DOC = 'doc-1';

let onRegister: () => Promise<void> = async () => undefined;
const fail = async (): Promise<never> => {
  throw new Error('not used here');
};
const documentStore: DocumentStore = {
  async registerExisting(_ctx, ref) {
    await onRegister();
    return { docRef: ref, title: `Doc ${ref}`, url: `https://docs.google.com/document/d/${ref}` };
  },
  copyFrom: fail,
  readText: fail,
  applyEdits: fail,
  exportFile: fail,
};
const boot = useApi(() => ({ build: { documentStore } }));
afterEach(() => {
  setRaceHook(undefined);
  onRegister = async () => undefined;
});

const remove = async (a: TestClient, id: string) => {
  const res = await a.request({ method: 'DELETE', url: `/api/v1/opportunities/${id}` });
  expect(res.statusCode, res.body).toBe(204);
};
const idOf = async (app: FastifyInstance, title: string) =>
  (
    await app.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.title, title))
      .get()
  )?.id;

async function tracked(a: TestClient): Promise<string> {
  const res = await a.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName: 'Initech', title: 'Gone', sourceKind: 'manual' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** The row under test, and one after it. */
const pack = (stage: string, rest: { applied?: string; notes?: string; resume?: string } = {}) =>
  packFromZip(
    zipSync({
      'opportunities.csv': strToU8(
        [
          HEADER,
          `Initech,Gone,${stage},,,,${rest.applied ?? ''},,${rest.notes ?? ''},${rest.resume ?? ''}`,
          'Globex,Kept,applied,,,,2026-09-01,,,',
        ].join('\n'),
      ),
      'n.md': strToU8('A note'),
    }),
  );

const run = async (app: FastifyInstance, a: TestClient, p: ReturnType<typeof pack>) =>
  (await runImport(app.db, { userId: a.userId, isAdmin: false }, p, { documentStore })).report;

/** Nothing of the deleted one is left, and the row after it is whole. */
async function settled(app: FastifyInstance, report: ImportReport): Promise<void> {
  expect(report.errors).toEqual([{ line: 2, message: GONE }]);
  expect(report).toMatchObject({ created: 1, updated: 0, skipped: 0 });
  const kept = await idOf(app, 'Kept');
  expect(await idOf(app, 'Gone')).toBeUndefined();
  for (const table of [activities, stageHistory, resumes]) {
    const rows = await app.db.select({ of: table.opportunityId }).from(table).all();
    expect(rows.filter((r) => r.of !== kept)).toEqual([]);
  }
  expect((await app.db.select({ n: count() }).from(resumes).get())?.n).toBe(0);
  expect((await app.db.select({ n: count() }).from(activities).get())?.n).toBe(1);
  // The search rows: the kept opportunity's and its one activity's.
  const of = (kind: string) =>
    queryAll<{ id: string }>(
      app,
      'SELECT entity_id AS id FROM search_index WHERE entity_kind = ?',
      kind,
    );
  expect((await of('opportunity')).map((r) => r.id)).toEqual([kept]);
  expect(await of('activity')).toHaveLength(1);
}

/** Runs `act` the first time the import reaches `point`. */
function at(point: string, act: () => Promise<void>): void {
  let done = false;
  setRaceHook(async (reached) => {
    if (reached !== point || done) return;
    done = true;
    await act();
  });
}

describe('deleted between the read and the stage move', () => {
  it('the delete done: the row says so, and the rest is imported', async () => {
    const { app, a } = await boot();
    const id = await tracked(a);
    at('import.row.matched', () => remove(a, id));
    await settled(app, await run(app, a, pack('applied')));
  });

  it('the delete under way, the move waiting for it', async () => {
    const { app, a } = await boot();
    const id = await tracked(a);
    onSlowTransaction(() => undefined);
    let parked!: () => void;
    const held = new Promise<void>((r) => (parked = r));
    let go!: () => void;
    const released = new Promise<void>((r) => (go = r));
    let deleting: Promise<void> | undefined;
    setRaceHook(async (reached) => {
      if (reached === 'opportunities.delete.locked') {
        parked();
        await released;
      } else if (reached === 'import.row.matched' && deleting === undefined) {
        deleting = remove(a, id);
        await held;
      }
    });
    const importing = run(app, a, pack('applied'));
    await held;
    const blocked = await someoneBlocked(app);
    go();
    const report = await importing;
    await deleting;
    expect(blocked, `the move waits (${testDialect})`).toBe(true);
    await settled(app, report);
  });

  it('control: nobody deletes it, and it is moved', async () => {
    const { app, a } = await boot();
    const id = await tracked(a);
    const report = await run(app, a, pack('applied'));
    expect(report).toEqual({ created: 1, updated: 1, skipped: 0, errors: [] });
    const history = await app.db
      .select({ to: stageHistory.toStage })
      .from(stageHistory)
      .where(eq(stageHistory.opportunityId, id))
      .all();
    expect(history.map((h) => h.to)).toContain('applied');
  });
});

describe('one the import has just made, deleted before the rest of its row', () => {
  it.each(['discovered', 'applied', 'dismissed'])('at %s', async (stage) => {
    const { app, a } = await boot();
    at('import.row.created', async () => remove(a, (await idOf(app, 'Gone'))!));
    await settled(app, await run(app, a, pack(stage)));
  });
});

describe('deleted after its stage, before what else the row has', () => {
  it.each([
    ['a note', { notes: 'n.md' }],
    ['when it was applied to', { applied: '2026-09-02' }],
    ['a resume', { resume: DOC }],
    ['all three', { notes: 'n.md', applied: '2026-09-02', resume: DOC }],
  ])('%s', async (_what, rest) => {
    const { app, a } = await boot();
    const id = await tracked(a);
    at('import.row.moved', () => remove(a, id));
    await settled(app, await run(app, a, pack('applied', rest)));
  });

  it('a resume, while its store answers', async () => {
    const { app, a } = await boot();
    const id = await tracked(a);
    onRegister = () => remove(a, id);
    await settled(app, await run(app, a, pack('applied', { resume: DOC })));
  });

  it('control: a resume the store refuses is still said as it was, and the row is kept', async () => {
    const { app, a } = await boot();
    await tracked(a);
    onRegister = async () => {
      throw new Error('document not found or not shared');
    };
    const report = await run(app, a, pack('applied', { resume: DOC }));
    expect(report).toMatchObject({ created: 1, updated: 1 });
    expect(report.errors).toEqual([
      { line: 2, message: 'resume_doc_ref: document not found or not shared' },
    ]);
  });
});

it('control: a write that fails is not said to be a deletion', async () => {
  const { app, a } = await boot();
  await tracked(a);
  await withFailingWrite(app, 'activities', { on: 'INSERT', message: 'boom' });
  // Drizzle's own words on Postgres, the driver's on SQLite: the database's error, either way.
  await expect(run(app, a, pack('applied', { notes: 'n.md' }))).rejects.toThrow(/boom|activities/);
});

it('the job is done at its first try, with the row in its report', async () => {
  const { app, a } = await boot();
  const id = await tracked(a);
  at('import.row.matched', () => remove(a, id));
  const boundary = 'importDeletedMeanwhile';
  const zip = Buffer.from(
    zipSync({
      'opportunities.csv': strToU8(
        [HEADER, 'Initech,Gone,applied,,,,,,,', 'Globex,Kept,applied,,,,,,,'].join('\n'),
      ),
    }),
  );
  const res = await a.request({
    method: 'POST',
    url: '/api/v1/imports',
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="pack.zip"\r\n` +
          'Content-Type: application/zip\r\n\r\n',
      ),
      zip,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  expect(res.statusCode, res.body).toBe(202);
  const { jobId } = res.json() as { jobId: string };
  await app.jobs.drain();
  const job = await app.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  expect(job).toMatchObject({ status: 'done', attempts: 1 });
  const status = await a.request({ method: 'GET', url: `/api/v1/imports/${jobId}` });
  expect(status.json()).toMatchObject({
    status: 'done',
    progress: { processed: 2, total: 2 },
    report: { created: 1, errors: [{ line: 2, message: GONE }] },
  });
});
