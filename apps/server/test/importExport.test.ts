// Import pipeline and data export (FR-I1, I2, I3). The fixture pack under
// fixtures/import/ is synthetic: every company, person, address and URL in it is made up.
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { DocumentStore } from '../src/adapters/documentStore';
import {
  activities,
  companies,
  contacts,
  jobs,
  opportunities,
  resumes,
  secrets,
  stageHistory,
  users,
} from '../src/db/schema';
import { formatCsv, parseCsv, unguardFormula } from '../src/lib/csv';
import { EXPORT_EXCLUDED_TABLES } from '../src/lib/exporter';
import { IMPORT_JOB_KIND, packFromZip } from '../src/lib/importer';
import { enqueue, runNextJob } from '../src/jobs/runner';
import { useApi } from './api';
import { fakeReactiveResume, RR_BASE_ID, RR_ORIGIN } from './fakeReactiveResume';
import { assertIsolated, type TestClient } from './isolation';
import { listTables, queryOne } from './db';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/import', import.meta.url));
const HEADER =
  'company,title,stage,posting_url,location,source,applied_at,dismissed_reason,notes_file,resume_doc_ref';

/** Registers any doc id except ones starting with "missing" (an unreadable document). */
function fakeDocumentStore(): DocumentStore & { registered: string[] } {
  const registered: string[] = [];
  const fail = async (): Promise<never> => {
    throw new Error('not used in import tests');
  };
  return {
    registered,
    async registerExisting(_ctx, ref) {
      if (ref.startsWith('missing')) throw new Error('document not found or not shared');
      registered.push(ref);
      return { docRef: ref, title: `Doc ${ref}`, url: `https://docs.google.com/document/d/${ref}` };
    },
    copyFrom: fail,
    readText: fail,
    applyEdits: fail,
  };
}

let docs: ReturnType<typeof fakeDocumentStore>;
const boot = useApi(() => {
  docs = fakeDocumentStore();
  return { build: { documentStore: docs } };
});

async function fixtureFiles(): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out[relative(FIXTURE_DIR, abs).split('\\').join('/')] = await readFile(abs);
    }
  }
  await walk(FIXTURE_DIR);
  return out;
}

const fixtureZip = async (): Promise<Buffer> => Buffer.from(zipSync(await fixtureFiles()));

/** multipart/form-data with one file part per entry (filename keeps its relative path). */
function multipart(files: { name: string; content: Buffer | string; mime?: string }[]) {
  const boundary = `----opportun${randomBytes(8).toString('hex')}`;
  const parts = files.map((f) =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\n` +
          `Content-Type: ${f.mime ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content),
      Buffer.from('\r\n'),
    ]),
  );
  return {
    payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function uploadZip(c: TestClient, zip: Buffer) {
  return c.request({
    method: 'POST',
    url: '/api/v1/imports',
    ...multipart([{ name: 'pack.zip', content: zip, mime: 'application/zip' }]),
  });
}

interface ImportStatus {
  id: string;
  status: string;
  progress: { processed: number; total: number } | null;
  report: {
    created: number;
    updated: number;
    skipped: number;
    errors: { line: number; message: string }[];
  } | null;
}

/** Uploads, runs the queued import job, and returns the finished status. */
async function importAndRun(
  app: FastifyInstance,
  c: TestClient,
  zip: Buffer,
): Promise<ImportStatus> {
  const res = await uploadZip(c, zip);
  expect(res.statusCode, res.body).toBe(202);
  const { jobId } = res.json() as { jobId: string };
  await app.jobs.drain();
  const status = await c.request({ method: 'GET', url: `/api/v1/imports/${jobId}` });
  expect(status.statusCode).toBe(200);
  return status.json() as ImportStatus;
}

const csvZip = (csv: string, extra: Record<string, string> = {}): Buffer =>
  Buffer.from(
    zipSync({
      'opportunities.csv': Buffer.from(csv),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, Buffer.from(v)])),
    }),
  );

async function rowCounts(app: FastifyInstance, userId: string): Promise<Record<string, number>> {
  const n = async (table: typeof opportunities | typeof companies | typeof activities) =>
    (await app.db.select({ n: count() }).from(table).where(eq(table.userId, userId)).get())?.n ?? 0;
  const m = async (table: typeof stageHistory | typeof resumes | typeof contacts) =>
    (await app.db.select({ n: count() }).from(table).where(eq(table.userId, userId)).get())?.n ?? 0;
  return {
    opportunities: await n(opportunities),
    companies: await n(companies),
    activities: await n(activities),
    stageHistory: await m(stageHistory),
    resumes: await m(resumes),
    contacts: await m(contacts),
  };
}

async function oppsOf(app: FastifyInstance, userId: string) {
  return await app.db
    .select({
      company: companies.name,
      title: opportunities.title,
      location: opportunities.location,
      stage: opportunities.stage,
      id: opportunities.id,
      postingUrl: opportunities.postingUrl,
      sourceKind: opportunities.sourceKind,
      sourceRef: opportunities.sourceRef,
      dismissedReason: opportunities.dismissedReason,
    })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(eq(opportunities.userId, userId))
    .all();
}

const signature = (
  rows: { company: string; title: string; location: string | null; stage: string }[],
) => rows.map((r) => `${r.company}|${r.title}|${r.location ?? ''}|${r.stage}`).sort();

async function createOpp(
  c: TestClient,
  companyName: string,
  title: string,
  location: string | null,
  stage?: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName, title, location, sourceKind: 'manual' },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  if (stage !== undefined) {
    const moved = await c.request({
      method: 'POST',
      url: `/api/v1/opportunities/${id}/stage`,
      payload: { to: stage, ...extra },
    });
    expect(moved.statusCode, moved.body).toBe(200);
  }
  return id;
}

describe('import', () => {
  it('imports the fixture pack with the expected counts, notes, applications and resumes', async () => {
    const { app, a } = await boot();
    const upload = await uploadZip(a, await fixtureZip());
    expect(upload.statusCode).toBe(202);
    const { jobId } = upload.json();
    const queued = await a.request({ method: 'GET', url: `/api/v1/imports/${jobId}` });
    expect(queued.json()).toMatchObject({ id: jobId, status: 'pending' });

    await app.jobs.drain();
    const done = (await a.request({ method: 'GET', url: `/api/v1/imports/${jobId}` })).json();
    expect(done.status).toBe('done');
    expect(done.progress).toEqual({ processed: 9, total: 9 });
    expect(done.report).toEqual({
      created: 8,
      updated: 0,
      skipped: 0,
      errors: [{ line: 7, message: expect.stringMatching(/stage/) }],
    });

    const opps = await oppsOf(app, a.userId);
    expect(signature(opps)).toEqual(
      signature([
        {
          company: 'Acme Robotics',
          title: 'Staff Software Engineer',
          location: 'Remote',
          stage: 'applied',
        },
        {
          company: 'Globex, Inc.',
          title: 'Engineering Manager',
          location: 'Austin, TX',
          stage: 'interested',
        },
        { company: 'Initech', title: 'Platform Engineer', location: 'Remote', stage: 'discovered' },
        {
          company: 'Umbrella Labs',
          title: 'Principal Engineer',
          location: 'Remote',
          stage: 'dismissed',
        },
        {
          company: 'Hooli',
          title: 'Senior Site Reliability Engineer',
          location: 'Palo Alto, CA',
          stage: 'in_process',
        },
        {
          company: 'Stark Labs',
          title: 'Engineer, "Developer Tools"',
          location: null,
          stage: 'closed',
        },
      ]),
    );
    const acme = opps.find((o) => o.company === 'Acme Robotics')!;
    expect(acme).toMatchObject({
      postingUrl: 'https://jobs.example.com/acme/101',
      sourceKind: 'import',
      sourceRef: 'LinkedIn',
    });
    expect(opps.find((o) => o.company === 'Umbrella Labs')!.dismissedReason).toBe('compensation');

    const acmeActs = await app.db
      .select()
      .from(activities)
      .where(eq(activities.opportunityId, acme.id))
      .all();
    expect(acmeActs.find((x) => x.kind === 'note')!.bodyMd).toContain(
      'Recruiter screen went well.',
    );
    expect(acmeActs.find((x) => x.kind === 'application')!.occurredAt).toBe(Date.UTC(2026, 8, 1));

    const history = (
      await app.db.select().from(stageHistory).where(eq(stageHistory.opportunityId, acme.id)).all()
    ).map((h) => [h.fromStage, h.toStage]);
    expect(history).toEqual([
      [null, 'discovered'],
      ['discovered', 'applied'],
    ]);

    const tailored = await app.db.select().from(resumes).where(eq(resumes.userId, a.userId)).all();
    expect(tailored).toHaveLength(1);
    expect(tailored[0]).toMatchObject({
      kind: 'tailored',
      docRef: 'doc-acme-tailored',
      opportunityId: acme.id,
      store: 'google_doc',
    });

    const people = await app.db.select().from(contacts).where(eq(contacts.userId, a.userId)).all();
    expect(people.map((p) => p.name).sort()).toEqual(['Jordan Example', 'Sam Sample']);
    const jordan = people.find((p) => p.name === 'Jordan Example')!;
    expect(jordan.emails).toEqual(['jordan@example.com']);
    expect(jordan.notes).toBe('Recruiter for platform roles.\nMet at a meetup.');
    expect(jordan.currentCompanyId).toBe(
      (await app.db.select().from(companies).where(eq(companies.name, 'Acme Robotics')).get())!.id,
    );
  });

  it('importing the same pack twice yields created=0 updated=0 and identical row counts', async () => {
    const { app, a } = await boot();
    const zip = await fixtureZip();
    const first = await importAndRun(app, a, zip);
    expect(first.report).toMatchObject({ created: 8, updated: 0 });
    const before = await rowCounts(app, a.userId);

    const second = await importAndRun(app, a, zip);
    expect(second.status).toBe('done');
    expect(second.report).toEqual({
      created: 0,
      updated: 0,
      skipped: 8,
      errors: first.report!.errors,
    });
    expect(await rowCounts(app, a.userId)).toEqual(before);
    // The document store was asked once: the second run found the tracked resume.
    expect(docs.registered).toEqual(['doc-acme-tailored']);
  });

  it('accepts a directory upload (one part per file, under a top-level folder)', async () => {
    const { app, a } = await boot();
    const files = Object.entries(await fixtureFiles()).map(([name, content]) => ({
      name: `my-pack/${name}`,
      content: Buffer.from(content),
    }));
    const res = await a.request({ method: 'POST', url: '/api/v1/imports', ...multipart(files) });
    expect(res.statusCode, res.body).toBe(202);
    await app.jobs.drain();
    const status = await a.request({ method: 'GET', url: `/api/v1/imports/${res.json().jobId}` });
    expect(status.json().report).toMatchObject({ created: 8, updated: 0, skipped: 0 });
  });

  it('moves stages only forward and never out of closed or dismissed', async () => {
    const { app, a } = await boot();
    const csv = [
      HEADER,
      'Acme,Backend Engineer,applied,,Remote,,,,,',
      'Initech,Platform Engineer,discovered,,Remote,,,,,',
      'Hooli,SRE,offer,,,,,,,',
      'Globex,Manager,offer,,,,,,,',
      'Stark,Engineer,in_process,,,,,,,',
    ].join('\n');
    await createOpp(a, 'Acme', 'Backend Engineer', 'Remote', 'interested');
    await createOpp(a, 'Initech', 'Platform Engineer', 'Remote', 'applied');
    await createOpp(a, 'Hooli', 'SRE', null, 'dismissed', { dismissedReason: 'location' });
    await createOpp(a, 'Globex', 'Manager', null, 'closed', { closedReason: 'rejected' });
    await createOpp(a, 'Stark', 'Engineer', null, 'offer');

    const status = await importAndRun(app, a, csvZip(csv));
    expect(status.report).toEqual({ created: 0, updated: 1, skipped: 4, errors: [] });
    const stages = Object.fromEntries(
      (await oppsOf(app, a.userId)).map((o) => [o.company, o.stage]),
    );
    expect(stages).toEqual({
      Acme: 'applied',
      Initech: 'applied',
      Hooli: 'dismissed',
      Globex: 'closed',
      Stark: 'offer',
    });
    expect(await oppsOf(app, a.userId)).toHaveLength(5);
  });

  it('reports invalid rows by line without aborting the others', async () => {
    const { app, a } = await boot();
    const csv = [
      HEADER,
      'Good One,Engineer,applied,,,,,,,',
      'Bad Stage,Engineer,hired,,,,,,,',
      'Bad Url,Engineer,applied,javascript:alert(1),,,,,,',
      ',No Company,applied,,,,,,,',
      'Bad Date,Engineer,applied,,,,yesterday,,,',
      'Bad Reason,Engineer,dismissed,,,,,bored,,',
      '"Multi',
      'Line Co",Engineer,interested,,,,,,,',
      'Missing Notes,Engineer,applied,,,,,,notes/none.md,',
      'Good Two,Engineer,interested,,,,,,,',
    ].join('\r\n');
    const status = await importAndRun(app, a, csvZip(csv));
    expect(status.status).toBe('done');
    expect(status.report!.created).toBe(4);
    expect(status.report!.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7, 10]);
    expect(status.report!.errors[0]!.message).toMatch(/stage/);
    expect(status.report!.errors[5]!.message).toMatch(/notes_file/);
    expect((await oppsOf(app, a.userId)).map((o) => o.company).sort()).toEqual([
      'Good One',
      'Good Two',
      'Missing Notes',
      'Multi\nLine Co',
    ]);
  });

  it('imports a row whose resume registration fails and reports the failure', async () => {
    const { app, a } = await boot();
    const csv = [HEADER, 'Acme,Engineer,applied,,,,,,,missing-doc-1'].join('\n');
    const status = await importAndRun(app, a, csvZip(csv));
    expect(status.report).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      errors: [{ line: 2, message: expect.stringMatching(/resume_doc_ref.*not found/) }],
    });
    expect(await oppsOf(app, a.userId)).toHaveLength(1);
    expect(await app.db.select().from(resumes).all()).toHaveLength(0);
  });

  it('rejects a pack without opportunities.csv, with a wrong header, or with no files', async () => {
    const { a } = await boot();
    const missing = await uploadZip(a, Buffer.from(zipSync({ 'other.csv': Buffer.from('x') })));
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe('invalid_pack');
    const header = await uploadZip(a, csvZip('company,title\nAcme,Engineer'));
    expect(header.statusCode).toBe(422);
    expect(header.json().error.message).toMatch(/header/);
    const junk = await uploadZip(a, Buffer.from('PK\u0003\u0004 not really a zip'));
    expect(junk.statusCode).toBe(422);
    const json = await a.request({ method: 'POST', url: '/api/v1/imports', payload: { x: 1 } });
    expect(json.statusCode).toBe(415);
  });

  it('ignores zip entries that try to escape the pack', async () => {
    const { app, a } = await boot();
    const csv = [HEADER, 'Acme,Engineer,applied,,,,,,../../evil.md,'].join('\n');
    const status = await importAndRun(app, a, csvZip(csv, { '../../evil.md': 'pwned' }));
    expect(status.report!.created).toBe(1);
    expect(status.report!.errors).toEqual([
      { line: 2, message: expect.stringMatching(/notes_file/) },
    ]);
    expect((await app.db.select().from(activities).all()).some((x) => x.bodyMd === 'pwned')).toBe(
      false,
    );
  });

  it("imports into the caller's data only", async () => {
    const { app, a, b } = await boot();
    const bOpp = await createOpp(b, 'Acme Robotics', 'Staff Software Engineer', 'Remote');
    const before = await rowCounts(app, b.userId);
    await importAndRun(app, a, await fixtureZip());
    expect(await rowCounts(app, b.userId)).toEqual(before);
    const bRow = (await app.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, bOpp))
      .get())!;
    expect(bRow.stage).toBe('discovered');
    expect(await oppsOf(app, a.userId)).toHaveLength(6);
  });

  assertIsolated({
    name: 'import job status',
    build: { documentStore: fakeDocumentStore() },
    create: async (c) => {
      const res = await uploadZip(c, csvZip([HEADER, 'Acme,Engineer,applied,,,,,,,'].join('\n')));
      return res.json().jobId as string;
    },
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/imports/${id}` }),
  });
});

describe('import registers a resume_doc_ref through the signed-in user document store', () => {
  const RR_KEY = 'rr-key-alice-0123456789';
  let rr: ReturnType<typeof fakeReactiveResume>;
  const bootRr = useApi(() => {
    rr = fakeReactiveResume();
    rr.keys.set(RR_KEY, 'alice');
    rr.seed('alice', { id: RR_BASE_ID });
    return { build: { rrFetch: rr.fetch } };
  });

  async function preferReactiveResume(c: TestClient): Promise<void> {
    const connected = await c.request({
      method: 'PUT',
      url: '/api/v1/integrations/reactive-resume',
      payload: { baseUrl: RR_ORIGIN, apiKey: RR_KEY },
    });
    expect(connected.statusCode, connected.body).toBe(200);
    const pref = await c.request({
      method: 'PUT',
      url: '/api/v1/settings/document-store',
      payload: { store: 'reactive_resume' },
    });
    expect(pref.statusCode, pref.body).toBe(200);
  }

  it('registers through Reactive Resume, not Google, when that is the preference (#19)', async () => {
    const { app, a } = await bootRr();
    await preferReactiveResume(a);

    const csv = [HEADER, `Acme,Engineer,applied,,,,,,,${RR_BASE_ID}`].join('\n');
    const status = await importAndRun(app, a, csvZip(csv));
    expect(status.report).toEqual({ created: 1, updated: 0, skipped: 0, errors: [] });

    const rows = await app.db.select().from(resumes).where(eq(resumes.userId, a.userId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store: 'reactive_resume', docRef: RR_BASE_ID });
    expect(rr.calls).toEqual([
      expect.objectContaining({ method: 'GET', path: `/api/openapi/resumes/${RR_BASE_ID}` }),
    ]);
  });
});

describe('import hardening', () => {
  it('a partly overlapping pack creates only the new rows and skips the old ones', async () => {
    const { app, a } = await boot();
    const first = [
      HEADER,
      'Acme,Engineer,applied,,Remote,,,,,',
      'Globex,Manager,interested,,,,,,,',
    ];
    const one = await importAndRun(app, a, csvZip(first.join('\n')));
    expect(one.report).toMatchObject({ created: 2, updated: 0, skipped: 0, errors: [] });
    const idsBefore = (await oppsOf(app, a.userId)).map((o) => o.id).sort();
    const before = await rowCounts(app, a.userId);

    const overlap = [...first, 'Initech,Platform Engineer,discovered,,Remote,,,,,'];
    const two = await importAndRun(app, a, csvZip(overlap.join('\n')));
    expect(two.report).toEqual({ created: 1, updated: 0, skipped: 2, errors: [] });

    const after = await rowCounts(app, a.userId);
    expect(after.opportunities).toBe((before.opportunities ?? 0) + 1);
    expect(after.companies).toBe((before.companies ?? 0) + 1);
    const opps = await oppsOf(app, a.userId);
    // The two existing rows are the same rows, untouched; one new row joined them.
    expect(
      opps
        .map((o) => o.id)
        .filter((id) => idsBefore.includes(id))
        .sort(),
    ).toEqual(idsBefore);
    expect(signature(opps)).toEqual([
      'Acme|Engineer|Remote|applied',
      'Globex|Manager||interested',
      'Initech|Platform Engineer|Remote|discovered',
    ]);
  });

  it('rejects a zip with more than 2000 entries', async () => {
    const { a } = await boot();
    const files: Record<string, Uint8Array> = { 'opportunities.csv': Buffer.from(HEADER) };
    for (let i = 0; i < 2000; i++) files[`notes/n${i}.md`] = Buffer.from('x');
    const res = await uploadZip(a, Buffer.from(zipSync(files)));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/too many entries/);
  });

  it('rejects a zip whose entries declare more than 20 MB unpacked', async () => {
    const { a } = await boot();
    const big = new Uint8Array(11 * 1024 * 1024).fill(0x20);
    const zip = Buffer.from(
      zipSync({ 'opportunities.csv': Buffer.from(HEADER), 'notes/a.md': big, 'notes/b.md': big }),
    );
    // Highly compressible: the upload itself is tiny, only the unpacked size is over.
    expect(zip.length).toBeLessThan(1024 * 1024);
    const res = await uploadZip(a, zip);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/larger than 20 MB/);
  });

  it('a lying originalSize header cannot unpack past what it declared', () => {
    // 25 MB of real content declared as 100 bytes in both the local and central headers.
    const real = new Uint8Array(25 * 1024 * 1024).fill(0x61);
    const csv = [HEADER, 'Acme,Engineer,applied,,,,,,notes/big.md,'].join('\n');
    const zip = zipSync({ 'opportunities.csv': Buffer.from(csv), 'notes/big.md': real });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const name = Buffer.from('notes/big.md');
    for (let i = 0; i + 4 <= zip.length; i++) {
      const sig = view.getUint32(i, true);
      const local =
        sig === 0x04034b50 && Buffer.from(zip.subarray(i + 30, i + 30 + name.length)).equals(name);
      const central =
        sig === 0x02014b50 && Buffer.from(zip.subarray(i + 46, i + 46 + name.length)).equals(name);
      if (local) view.setUint32(i + 22, 100, true);
      if (central) view.setUint32(i + 24, 100, true);
    }
    const pack = packFromZip(zip);
    const unpacked = Object.values(pack.notes).reduce((n, v) => n + v.length, 0);
    expect(unpacked).toBeLessThanOrEqual(100);
    expect(pack.notes['notes/big.md']).toBe('a'.repeat(100));
  });

  it('drops the stored pack once the import finishes, keeping the report', async () => {
    const { app, a } = await boot();
    const marker = 'Payload Marker Corp';
    const csv = [HEADER, `${marker},Engineer,applied,,,,,,notes/x.md,`].join('\n');
    const res = await uploadZip(a, csvZip(csv, { 'notes/x.md': 'n'.repeat(50_000) }));
    const { jobId } = res.json() as { jobId: string };
    const payload = async () =>
      (
        (await queryOne(app, 'SELECT payload FROM jobs WHERE id = ?', jobId)) as {
          payload: string;
        }
      ).payload;
    // Queued: the whole pack is in the row.
    expect(await payload()).toContain(marker);
    expect((await payload()).length).toBeGreaterThan(50_000);

    await app.jobs.drain();
    const stored = await payload();
    expect(stored).not.toContain(marker);
    expect(stored.length).toBeLessThan(500);
    expect(JSON.parse(stored)).toEqual({
      purged: true,
      files: { opportunitiesCsvBytes: csv.length, contactsCsvBytes: 0, notes: 1 },
    });
    const status = await a.request({ method: 'GET', url: `/api/v1/imports/${jobId}` });
    expect(status.json()).toMatchObject({
      status: 'done',
      report: { created: 1, updated: 0, skipped: 0, errors: [] },
    });
  });

  it('purges the stored pack once an import job gives up for good, not before (issue #2)', async () => {
    // Every content-driven failure in this pipeline is caught per row and reported in `errors`
    // (RowError, or an HttpError whose code becomes the row's message) — there is no CSV row
    // that kills the whole job, so there is no pack a user could upload to reach this state.
    // What does reach it is a failure from outside row processing (a lost database connection,
    // an unhandled exception in a dependency); `run`'s own "import job has no user" guard is one
    // such path already in the code, and it behaves exactly like any other job-fatal error for
    // this purpose, so it stands in for that class here without inventing a new failure mode.
    const { app } = await boot();
    const marker = 'Never Purged Corp';
    const csv = [HEADER, `${marker},Engineer,applied,,,,,,,`].join('\n');
    const id = await enqueue(app.db, IMPORT_JOB_KIND, {
      pack: { opportunitiesCsv: csv, notes: {} },
    });
    const row = async () => {
      const r = await app.db.select().from(jobs).where(eq(jobs.id, id)).get();
      if (r === undefined) throw new Error('job missing');
      return r;
    };
    let now = 1_800_000_000_000;
    const opts = { now: () => now, random: () => 0.5, services: app.jobs.services };

    // Attempts 1 and 2 of 3: still pending for a retry, so the pack must still be there.
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(await runNextJob(app.db, opts)).toBe(true);
      const r = await row();
      expect(r.status).toBe('pending');
      expect(r.attempts).toBe(attempt);
      expect(JSON.stringify(r.payload)).toContain(marker);
      now = r.runAt;
    }

    // Attempt 3 of 3: it gives up, and the pack goes with it, not just the status.
    expect(await runNextJob(app.db, opts)).toBe(true);
    const dead = await row();
    expect(dead.status).toBe('dead');
    expect(dead.lastError).toContain('import job has no user');
    expect(JSON.stringify(dead.payload)).not.toContain(marker);
    expect(dead.payload).toMatchObject({ purged: true });
  });
});

describe('csv formula guard', () => {
  /** Leading characters a spreadsheet runs as a formula when it opens the file. */
  const LEADS = ['=', '+', '-', '@', '\t', '\r'];

  it('prefixes every formula lead with an apostrophe and reads the value back unchanged', () => {
    for (const lead of LEADS) {
      const value = `${lead}HYPERLINK("http://evil.example","click me")`;
      const cell = parseCsv(formatCsv([['company'], [value]]))[1]!.fields[0]!;
      expect(cell.startsWith("'"), JSON.stringify(cell)).toBe(true);
      // parseCsv folds a CR into an LF (its CRLF tolerance), so that lead reads back as one.
      expect(unguardFormula(cell)).toBe(lead === '\r' ? value.replace('\r', '\n') : value);
    }
  });

  it('leaves ordinary values alone, including an apostrophe that guards nothing', () => {
    const row = ['Acme Robotics', "O'Brien & Co", "'Tis the season", 'a,b "c"', '', '2026-09-01'];
    const cells = parseCsv(formatCsv([row]))[0]!.fields;
    expect(cells).toEqual(row);
    expect(cells.map(unguardFormula)).toEqual(row);
  });

  it('guards a value already starting with an apostrophe, so one strip gives it back', () => {
    for (const value of ["'=1+1", "''=1+1"]) {
      const cell = parseCsv(formatCsv([[value]]))[0]!.fields[0]!;
      expect(cell).toBe(`'${value}`);
      expect(unguardFormula(cell)).toBe(value);
    }
  });
});

describe('export', () => {
  async function exportZip(c: TestClient): Promise<Record<string, string>> {
    const res = await c.request({ method: 'GET', url: '/api/v1/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="opportun-export-\d{8}\.zip"$/,
    );
    const files = unzipSync(new Uint8Array(res.rawPayload));
    return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
  }

  it('contains every user-owned table, markdown summaries, and no secrets or ciphertext', async () => {
    const { app, a, b } = await boot();
    await importAndRun(app, a, await fixtureZip());
    const secretValue = 'sk-live-THIS-MUST-NOT-LEAK-0001';
    const put = await a.request({
      method: 'POST',
      url: '/api/v1/secrets',
      payload: { kind: 'ai_api_key', label: 'Provider', value: secretValue },
    });
    expect(put.statusCode).toBe(201);
    await createOpp(b, 'B Only Corp', 'Hidden Role', null);

    const files = await exportZip(a);
    const data = JSON.parse(files['export.json']!) as {
      format: string;
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(data.format).toBe('opportun-export/1');
    const tables = data.tables;

    // Every table with a user_id column is exported or deliberately excluded.
    const userTables = await listTables(app, 'user_id');
    for (const t of userTables) {
      expect(t in tables || EXPORT_EXCLUDED_TABLES.includes(t), `table ${t}`).toBe(true);
    }
    expect(Object.keys(tables)).toEqual(
      expect.arrayContaining(['users', 'opportunities', 'contacts']),
    );
    for (const excluded of ['secrets', 'sessions', 'oauth_accounts']) {
      expect(tables).not.toHaveProperty(excluded);
    }

    expect(tables.opportunities).toHaveLength(6);
    expect(tables.users).toEqual([expect.objectContaining({ id: a.userId })]);
    expect(tables.users![0]).not.toHaveProperty('passwordHash');
    expect(tables.users![0]).not.toHaveProperty('totpSecret');
    for (const rows of Object.values(tables)) {
      for (const row of rows) {
        if ('userId' in row) expect(row.userId).toBe(a.userId);
      }
    }

    const everything = Object.values(files).join('\n');
    expect(everything).not.toContain(secretValue);
    expect(everything).not.toContain('B Only Corp');
    const stored = await app.db.select().from(secrets).all();
    expect(stored.length).toBeGreaterThan(0);
    for (const s of stored) {
      expect(everything).not.toContain(s.ciphertext);
    }
    const hash = (await app.db.select().from(users).where(eq(users.id, a.userId)).get())!
      .passwordHash;
    expect(everything).not.toContain(hash);

    const summaries = Object.keys(files).filter((k) => k.startsWith('opportunities/'));
    expect(summaries).toHaveLength(6);
    expect(summaries).toContain('opportunities/Acme-Robotics-Staff-Software-Engineer.md');
    const acme = files['opportunities/Acme-Robotics-Staff-Software-Engineer.md']!;
    expect(acme).toContain('# Staff Software Engineer');
    expect(acme).toContain('Acme Robotics');
    expect(acme).toContain('Recruiter screen went well.');
  });

  it('sanitizes summary filenames so zip entries cannot traverse', async () => {
    const { a } = await boot();
    await createOpp(a, '../../etc', 'pass/wd\\x:y', null);
    await createOpp(a, '..', '..', 'Remote');
    await createOpp(a, '..', '..', 'Berlin');
    const files = await exportZip(a);
    const summaries = Object.keys(files).filter((k) => k.startsWith('opportunities/'));
    expect(summaries).toHaveLength(3);
    for (const name of Object.keys(files)) {
      expect(name).toMatch(/^(export\.json|opportunities\.csv|opportunities\/[^/\\]+\.md)$/);
      expect(name.split('/')).not.toContain('..');
      expect(name).not.toMatch(/^\.|\/\./);
    }
    expect(new Set(summaries).size).toBe(3);
  });

  it('round-trips through the importer (opportunities)', async () => {
    const { app, a, b } = await boot();
    await importAndRun(app, a, await fixtureZip());
    await createOpp(a, 'Wayne Enterprises', 'Security, "Red Team"', 'Gotham', 'offer');
    const res = await a.request({ method: 'GET', url: '/api/v1/export' });
    const zip = Buffer.from(res.rawPayload);

    const intoB = await importAndRun(app, b, zip);
    expect(intoB.report).toMatchObject({ created: 7, updated: 0, errors: [] });
    expect(signature(await oppsOf(app, b.userId))).toEqual(signature(await oppsOf(app, a.userId)));

    const intoA = await importAndRun(app, a, zip);
    expect(intoA.report).toMatchObject({ created: 0, updated: 0, skipped: 7, errors: [] });
    expect(
      (await app.db
        .select({ n: count() })
        .from(opportunities)
        .where(and(eq(opportunities.userId, a.userId)))
        .get())!.n,
    ).toBe(7);
  });

  it('writes no cell a spreadsheet would run, and the guarded cells still re-import', async () => {
    const { app, a, b } = await boot();
    // Company, title and location can hold third-party text (a discovery posting, recruiter mail).
    await createOpp(a, "=cmd|'/C calc'!A0", '+Staff Platform Engineer', '-Remote');
    await createOpp(a, '@Globex', '=1+1', '@Austin, TX');
    const res = await a.request({ method: 'GET', url: '/api/v1/export' });
    expect(res.statusCode).toBe(200);
    const zip = Buffer.from(res.rawPayload);
    const csv = strFromU8(unzipSync(new Uint8Array(zip))['opportunities.csv']!);
    for (const rec of parseCsv(csv)) {
      for (const field of rec.fields) expect(field).not.toMatch(/^[=+\-@\t\r]/);
    }
    expect(csv).toContain("'=cmd|'/C calc'!A0");

    // The guard is the importer's to remove: user b ends up with exactly user a's values.
    const intoB = await importAndRun(app, b, zip);
    expect(intoB.report).toMatchObject({ created: 2, updated: 0, errors: [] });
    expect(signature(await oppsOf(app, b.userId))).toEqual(signature(await oppsOf(app, a.userId)));
  });

  it('requires a session', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/v1/export' });
    expect(res.statusCode).toBe(401);
  });
});
