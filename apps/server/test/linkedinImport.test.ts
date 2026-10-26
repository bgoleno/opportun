// LinkedIn data export import (Task 20, FR-C2, FR-M6 export part). The fixtures under
// fixtures/linkedin/ are synthetic (every person, company and URL is made up) but byte-for-byte
// in the real export layout: UTF-8 BOM, CRLF, a "Notes:" preamble before the Connections.csv
// header, quoted fields holding commas and doubled quotes, and connections without an email.
// The export ZIP upload is the only LinkedIn data path: nothing here (or in the app) fetches
// linkedin.com (C-1).
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { communications, companies, contacts, jobs } from '../src/db/schema';
import { enqueue, runNextJob } from '../src/jobs/runner';
import {
  LINKEDIN_IMPORT_JOB_KIND,
  legacyMessageExternalId,
  parseConnections,
} from '../src/lib/linkedinExport';
import { upsertInbound } from '../src/repos/communications';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';

const boot = useApi();
const FIXTURES = fileURLToPath(new URL('./fixtures/linkedin/', import.meta.url));
const JANE_URL = 'https://www.linkedin.com/in/jane-doe-synthetic-0a1b';
const CONVO_1 = '2-c3ludGhldGljLWNvbnZvLTE=';

async function fixture(name: string): Promise<Buffer> {
  return readFile(`${FIXTURES}${name}`);
}

async function exportZip(
  overrides: { connections?: string; messages?: string; omit?: string[] } = {},
): Promise<Buffer> {
  const files: Record<string, Uint8Array> = {
    'Connections.csv':
      overrides.connections === undefined
        ? await fixture('Connections.csv')
        : Buffer.from(overrides.connections),
    'messages.csv':
      overrides.messages === undefined
        ? await fixture('messages.csv')
        : Buffer.from(overrides.messages),
    // Other export files are ignored.
    'Profile.csv': Buffer.from('First Name,Last Name\r\nAlex,Tester\r\n'),
  };
  const omit = new Set(overrides.omit ?? []);
  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).filter(([n]) => !omit.has(n)))),
  );
}

function multipart(name: string, content: Buffer) {
  const boundary = `----opportun${randomBytes(8).toString('hex')}`;
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
          'Content-Type: application/zip\r\n\r\n',
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function upload(c: TestClient, zip: Buffer, name = 'Basic_LinkedInDataExport_10-15-2026.zip') {
  return c.request({ method: 'POST', url: '/api/v1/imports/linkedin', ...multipart(name, zip) });
}

interface Report {
  created: number;
  updated: number;
  skipped: number;
  /** Messages the ingestion window left out (issue #53). */
  outsideWindow?: number;
  /** Connections LinkedIn itself stripped of every identity field (issue #132). */
  strippedConnections?: number;
  errors: { line: number; message: string }[];
}

async function importAndRun(app: FastifyInstance, c: TestClient, zip: Buffer) {
  const res = await upload(c, zip);
  expect(res.statusCode, res.body).toBe(202);
  const { jobId } = res.json() as { jobId: string };
  await app.jobs.drain();
  const status = await c.request({ method: 'GET', url: `/api/v1/imports/${jobId}` });
  expect(status.statusCode, status.body).toBe(200);
  const body = status.json() as { status: string; report: Report | null };
  expect(body.status).toBe('done');
  return { jobId, report: body.report as Report };
}

async function rowCounts(app: FastifyInstance, userId: string) {
  const n = async (t: typeof contacts | typeof communications | typeof companies) =>
    (await app.db.select({ n: count() }).from(t).where(eq(t.userId, userId)).get())?.n ?? 0;
  return {
    contacts: await n(contacts),
    communications: await n(communications),
    companies: await n(companies),
  };
}

async function contactsOf(app: FastifyInstance, userId: string) {
  return await app.db.select().from(contacts).where(eq(contacts.userId, userId)).all();
}

async function linkedinComms(app: FastifyInstance, userId: string) {
  return await app.db
    .select()
    .from(communications)
    .where(and(eq(communications.userId, userId), eq(communications.channel, 'linkedin')))
    .all();
}

describe('linkedin export fixtures', () => {
  it('really are in the export layout (BOM, CRLF, Notes: preamble)', async () => {
    const conn = await fixture('Connections.csv');
    expect([...conn.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = conn.toString('utf8').slice(1);
    expect(text.startsWith('Notes:\r\n"')).toBe(true);
    expect(text).toContain(
      '\r\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\r\n',
    );
    expect(text).not.toMatch(/[^\r]\n/);
    const msgs = (await fixture('messages.csv')).toString('utf8');
    expect(msgs.charCodeAt(0)).toBe(0xfeff);
    expect(msgs).toContain('CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,');
  });
});

describe('linkedin export parsing (Review Focus 4)', () => {
  it('parses BOM + Notes: preamble + quoted commas + CRLF + a missing email', async () => {
    const rows = parseConnections((await fixture('Connections.csv')).toString('utf8'));
    expect(rows.errors).toEqual([]);
    expect(rows.rows).toEqual([
      {
        line: 5,
        name: 'Jane Doe',
        linkedinUrl: JANE_URL,
        email: 'jane.doe@initech.example',
        company: 'Initech',
        position: 'Director, Platform Engineering',
      },
      {
        line: 6,
        name: 'Sam Lee',
        linkedinUrl: 'https://www.linkedin.com/in/sam-lee-synthetic-2c3d',
        email: null,
        company: 'Hooli, Inc.',
        position: 'Engineering Manager',
      },
      {
        line: 7,
        name: 'Priya Shah',
        linkedinUrl: null,
        email: null,
        company: 'Globex',
        position: 'Senior "Staff" Recruiter',
      },
      {
        line: 8,
        name: 'Chen Wu',
        // Trailing slash normalized away, so the key is stable.
        linkedinUrl: 'https://www.linkedin.com/in/chen-wu-synthetic-4e5f',
        email: null,
        company: null,
        position: null,
      },
      {
        line: 9,
        name: 'Ana Ruiz',
        linkedinUrl: 'https://www.linkedin.com/in/ana-ruiz-synthetic-6a7b',
        email: 'ana.ruiz@globex.example',
        company: 'Globex',
        position: 'Product Lead',
      },
    ]);
  });
});

describe('connections LinkedIn itself stripped of every identity field (issue #132)', () => {
  it('counts a connection with no name, URL, email, company or position as stripped, not an error', () => {
    const csv =
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On\r\n' +
      ',,,,,,15 Aug 2025\r\n';
    const { rows, errors, stripped } = parseConnections(csv);
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
    expect(stripped).toBe(1);
  });

  it('still reports a missing name as an error when any other identity field is present', () => {
    const csv =
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On\r\n' +
      ',,,,Initech,,01 Jan 2024\r\n';
    const { rows, errors, stripped } = parseConnections(csv);
    expect(rows).toEqual([]);
    expect(stripped).toBe(0);
    expect(errors).toEqual([{ line: 2, message: 'Connections.csv: a name is required' }]);
  });
});

describe('POST /imports/linkedin', () => {
  it('imports connections as contacts and messages as linkedin communications', async () => {
    const { app, a } = await boot();
    const { report } = await importAndRun(app, a, await exportZip());
    expect(report).toEqual({ created: 8, updated: 0, skipped: 0, errors: [] });

    const people = (await contactsOf(app, a.userId)).sort((x, y) => x.name.localeCompare(y.name));
    expect(people.map((p) => p.name)).toEqual([
      'Ana Ruiz',
      'Chen Wu',
      'Jane Doe',
      'Priya Shah',
      'Sam Lee',
    ]);
    for (const p of people) expect(p.source).toBe('linkedin_export');
    const jane = people.find((p) => p.name === 'Jane Doe')!;
    expect(jane).toMatchObject({
      emails: ['jane.doe@initech.example'],
      linkedinUrl: JANE_URL,
      history: [
        { company: 'Initech', title: 'Director, Platform Engineering', from: null, to: null },
      ],
    });
    const sam = people.find((p) => p.name === 'Sam Lee')!;
    expect(sam.emails).toEqual([]);
    const chen = people.find((p) => p.name === 'Chen Wu')!;
    expect(chen.currentCompanyId).toBeNull();
    expect(chen.history).toEqual([]);
    const names = (
      await app.db
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.userId, a.userId))
        .all()
    )
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(['Globex', 'Hooli, Inc.', 'Initech']);

    // Messages: channel linkedin, thread = conversation id, no stored body, unclassified, and
    // one comms.classify job queued per new message.
    const comms = (await linkedinComms(app, a.userId)).sort((x, y) => x.sentAt - y.sentAt);
    expect(comms).toHaveLength(3);
    const janeMsg = comms.find((m) => m.from === 'Jane Doe')!;
    expect(janeMsg).toMatchObject({
      threadKey: CONVO_1,
      to: ['Alex Tester'],
      sentAt: Date.parse('2026-09-14T16:02:11Z'),
      classification: null,
      contactId: jane.id,
    });
    expect(janeMsg.externalId.startsWith(`${CONVO_1}:`)).toBe(true);
    expect(janeMsg.snippet).toBe(
      'Hi Alex, Initech is hiring a Staff Platform Engineer. Happy to refer you, just send your resume.',
    );
    // No body is kept, here or anywhere (issue #53); the text reaches the classifier in the
    // classify job's payload and the row keeps the snippet.
    expect(janeMsg.bodyRef).toBeNull();
    const samMsg = comms.find((m) => m.from === 'Sam Lee')!;
    expect(samMsg.subject).toBe('Engineering roles at Hooli');
    expect(new Set(comms.map((m) => m.externalId)).size).toBe(3);

    const classify = await app.db.select().from(jobs).where(eq(jobs.kind, 'comms.classify')).all();
    expect(
      classify.map((j) => (j.payload as { communicationId: string }).communicationId).sort(),
    ).toEqual(comms.map((m) => m.id).sort());
    for (const m of await linkedinComms(app, a.userId)) expect(m.classification).toBeNull();
  });

  it('re-import creates zero duplicates and keeps message external ids stable', async () => {
    const { app, a } = await boot();
    const zip = await exportZip();
    await importAndRun(app, a, zip);
    const before = await rowCounts(app, a.userId);
    const idsBefore = (await linkedinComms(app, a.userId))
      .map((m) => `${m.id}|${m.externalId}`)
      .sort();
    const classifyBefore = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, 'comms.classify'))
      .all();

    const { report } = await importAndRun(app, a, zip);
    expect(report).toEqual({ created: 0, updated: 0, skipped: 8, errors: [] });
    expect(await rowCounts(app, a.userId)).toEqual(before);
    expect(before).toEqual({ contacts: 5, communications: 3, companies: 3 });
    expect(
      (await linkedinComms(app, a.userId)).map((m) => `${m.id}|${m.externalId}`).sort(),
    ).toEqual(idsBefore);
    // No new classification work for messages already stored.
    expect(
      await app.db.select().from(jobs).where(eq(jobs.kind, 'comms.classify')).all(),
    ).toHaveLength(classifyBefore.length);
  });

  it('upserts on linkedin_url, else name + company, and appends history on a move', async () => {
    const { app, a } = await boot();
    // A contact the user added by hand, with the same profile URL (trailing slash and case differ).
    const manual = await a.request({
      method: 'POST',
      url: '/api/v1/contacts',
      payload: {
        name: 'Jane D.',
        linkedinUrl: `${JANE_URL.toUpperCase().replace('HTTPS', 'https')}/`,
      },
    });
    expect(manual.statusCode).toBe(201);
    await importAndRun(app, a, await exportZip());
    expect((await rowCounts(app, a.userId)).contacts).toBe(5);
    const janeRow = (await contactsOf(app, a.userId)).find((p) => p.id === manual.json().id)!;
    // Matched by URL: the user's own name and source are kept; the export fills the gaps.
    expect(janeRow).toMatchObject({
      name: 'Jane D.',
      source: 'manual',
      emails: ['jane.doe@initech.example'],
    });

    // A later export: Jane moved to Hooli, Priya (no URL) gained an email.
    const conn = (await fixture('Connections.csv'))
      .toString('utf8')
      .replace(
        'jane.doe@initech.example,Initech,"Director, Platform Engineering"',
        'jane.doe@initech.example,"Hooli, Inc.",VP Engineering',
      )
      .replace('Priya,Shah,,,Globex', 'Priya,Shah,,priya@globex.example,Globex');
    const { report } = await importAndRun(app, a, await exportZip({ connections: conn }));
    expect(report).toEqual({ created: 0, updated: 2, skipped: 6, errors: [] });
    expect((await rowCounts(app, a.userId)).contacts).toBe(5);

    const moved = (await contactsOf(app, a.userId)).find((p) => p.id === manual.json().id)!;
    expect(moved.history).toEqual([
      { company: 'Initech', title: 'Director, Platform Engineering', from: null, to: null },
      { company: 'Hooli, Inc.', title: 'VP Engineering', from: null, to: null },
    ]);
    const hooli = (await app.db
      .select()
      .from(companies)
      .where(and(eq(companies.userId, a.userId), eq(companies.name, 'Hooli, Inc.')))
      .get())!;
    expect(moved.currentCompanyId).toBe(hooli.id);
    const priya = (await contactsOf(app, a.userId)).find((p) => p.name === 'Priya Shah')!;
    expect(priya.emails).toEqual(['priya@globex.example']);
  });

  it('accepts an export holding only one of the two files, and reports bad rows', async () => {
    const { app, a } = await boot();
    const conn =
      '﻿Notes:\r\n"x"\r\n\r\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\r\n' +
      // Every identity field blank, only Connected On set: LinkedIn itself stripped this one
      // (issue #132), so it is counted apart from a genuine problem rather than as an error.
      ',,,,,,15 Aug 2025\r\n' +
      // Blank name but a company present: still a real problem, since there is something here
      // the import could have used.
      ',,,,Initech,,01 Jan 2024\r\n' +
      'Ok,Person,ftp://bad.example/x,,Initech,PM,01 Jan 2024\r\n';
    const { report } = await importAndRun(
      app,
      a,
      await exportZip({ connections: conn, omit: ['messages.csv'] }),
    );
    expect(report.created).toBe(1);
    expect(report.strippedConnections).toBe(1);
    expect(report.errors).toEqual([{ line: 6, message: 'Connections.csv: a name is required' }]);
    // A non-http(s) URL is dropped (metadata only), the row still imports.
    expect((await contactsOf(app, a.userId))[0]).toMatchObject({
      name: 'Ok Person',
      linkedinUrl: null,
    });

    const msgs =
      'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,DATE,SUBJECT,CONTENT\r\n' +
      'c-1,,Sam,,Alex,not a date,,hello\r\n';
    const second = await importAndRun(
      app,
      a,
      await exportZip({ messages: msgs, omit: ['Connections.csv'] }),
    );
    expect(second.report.errors).toEqual([
      { line: 2, message: 'messages.csv: DATE is not a date' },
    ]);
  });

  it('rejects uploads that are not a LinkedIn export zip', async () => {
    const { a } = await boot();
    const notZip = await upload(a, Buffer.from('First Name,Last Name\n'), 'Connections.csv');
    expect(notZip.statusCode).toBe(422);
    const empty = await upload(a, Buffer.from(zipSync({ 'Profile.csv': Buffer.from('x') })));
    expect(empty.statusCode).toBe(422);
    const badHeader = await upload(
      a,
      Buffer.from(zipSync({ 'Connections.csv': Buffer.from('Name,Company\r\nJane,Initech\r\n') })),
    );
    expect(badHeader.statusCode).toBe(422);
    expect(badHeader.json().error).toMatchObject({ code: 'invalid_pack' });
    expect(badHeader.json().error.message).toMatch(/Connections\.csv/);
    const notMultipart = await a.request({ method: 'POST', url: '/api/v1/imports/linkedin' });
    expect(notMultipart.statusCode).toBe(415);
  });

  it("imports into the uploader's account only", async () => {
    const { app, a, b } = await boot();
    await importAndRun(app, a, await exportZip());
    expect(await rowCounts(app, b.userId)).toEqual({
      contacts: 0,
      communications: 0,
      companies: 0,
    });
    // B importing the same export gets its own rows; A's are untouched.
    await importAndRun(app, b, await exportZip());
    expect(await rowCounts(app, b.userId)).toEqual({
      contacts: 5,
      communications: 3,
      companies: 3,
    });
    expect(await rowCounts(app, a.userId)).toEqual({
      contacts: 5,
      communications: 3,
      companies: 3,
    });
  });
});

describe('import payload purge (issue #2)', () => {
  it('drops the stored pack once the import finishes, keeping the report', async () => {
    const { app, a } = await boot();
    const zip = await exportZip();
    const res = await upload(a, zip);
    expect(res.statusCode, res.body).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const row = async () => {
      const r = await app.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (r === undefined) throw new Error('job missing');
      return r;
    };
    // Queued: the whole pack (both CSVs, base64-encoded in the zip upload's parsed form) is
    // in the row.
    expect(JSON.stringify((await row()).payload).length).toBeGreaterThan(500);

    await app.jobs.drain();
    const done = await row();
    expect(done.status).toBe('done');
    expect(done.payload).toMatchObject({ purged: true });
    expect(JSON.stringify(done.payload).length).toBeLessThan(200);
    const status = await a.request({ method: 'GET', url: `/api/v1/imports/${jobId}` });
    expect(status.json()).toMatchObject({
      status: 'done',
      report: { created: 8, updated: 0, skipped: 0, errors: [] },
    });
  });

  it('purges the stored pack once an import job gives up for good, not before', async () => {
    // Every content-driven failure in this pipeline is caught per row and reported in `errors`,
    // so there is no export a user could upload to reach this state. What does reach it is a
    // failure from outside row processing; `run`'s own "no user" guard is one such path already
    // in the code, and it behaves exactly like any other job-fatal error for this purpose, so it
    // stands in for that class here without inventing a new failure mode (mirrors issue #2's
    // generic-importer test in importExport.test.ts).
    const { app } = await boot();
    const marker = 'Never Purged Corp, Synthetic Division';
    const id = await enqueue(app.db, LINKEDIN_IMPORT_JOB_KIND, {
      pack: { connectionsCsv: marker },
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
    expect(dead.lastError).toContain('linkedin import job has no user');
    expect(JSON.stringify(dead.payload)).not.toContain(marker);
    expect(dead.payload).toMatchObject({ purged: true });
  });
});

// Issue #53. Plan 3 Task 1 stopped the mail ingest path writing message bodies, and this path
// went on writing them, because the rule was implemented in the callers rather than in the writer
// they share. Nothing but the first real import could show that, since the channel had no rows.
//
// So the assertion is per channel rather than per function: after an import of any kind, no
// communications row holds a body, whoever wrote it. A per-function test is what missed this.
describe('an import keeps no message body (issue #53)', () => {
  const filesUnder = async (dir: string): Promise<string[]> => {
    const { readdir } = await import('node:fs/promises');
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  };

  /**
   * Runs the import job and stops, leaving the classify jobs it queued still waiting. A full
   * drain would run them too, and the runner clears the body from a finished job's payload, so
   * the payload has to be read while the job it belongs to is still pending.
   */
  async function importOnly(app: FastifyInstance, c: TestClient, zip: Buffer): Promise<void> {
    const res = await upload(c, zip);
    expect(res.statusCode, res.body).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    for (let i = 0; i < 20; i += 1) {
      await runNextJob(app.db, { services: app.jobs.services });
      const row = await app.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (row?.status === 'done') return;
      expect(row?.status, row?.lastError ?? '').not.toBe('dead');
    }
    throw new Error('the import job did not finish');
  }

  it('writes no body to storage, and hands the text to the classifier in the payload', async () => {
    const { app, a, dataDir } = await boot();

    await importOnly(app, a, await exportZip());

    const rows = await app.db
      .select()
      .from(communications)
      .where(eq(communications.userId, a.userId))
      .all();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.bodyRef !== null)).toEqual([]);
    expect(await filesUnder(`${dataDir}/attachments`)).toEqual([]);

    // The classifier is the one consumer that needs the whole message, so it travels in the
    // payload, which the runner clears when the job finishes.
    const jane = rows.find((r) => r.from === 'Jane Doe')!;
    const job = (
      await app.db.select().from(jobs).where(eq(jobs.kind, 'comms.classify')).all()
    ).find((j) => (j.payload as { communicationId: string }).communicationId === jane.id);
    expect((job?.payload as { body?: string }).body).toContain('Happy to refer you');
  });

  it('leaves nothing on disk once the classify jobs have run', async () => {
    const { app, a, dataDir } = await boot();

    await importAndRun(app, a, await exportZip());

    expect(await filesUnder(`${dataDir}/attachments`)).toEqual([]);
    const classify = await app.db.select().from(jobs).where(eq(jobs.kind, 'comms.classify')).all();
    expect(classify).toHaveLength(3);
    for (const job of classify) expect(job.payload).not.toHaveProperty('body');
  });

  it('keeps the snippet, so the row still says what the message was', async () => {
    const { app, a } = await boot();

    await importAndRun(app, a, await exportZip());

    const jane = (await linkedinComms(app, a.userId)).find((m) => m.from === 'Jane Doe')!;
    expect(jane.snippet).toBe(
      'Hi Alex, Initech is hiring a Staff Platform Engineer. Happy to refer you, just send your resume.',
    );
  });
});

// Issue #53, the window. An export is a whole archive, not a feed: Brian's held messages from
// 2006 onward, and every one of them became a row. The lookback window the Gmail sync has always
// had is the biggest single cut, and it is one setting for every channel rather than a second
// knob per channel, so it has to bound the import too. Gmail applies it inside its query; an
// archive handed over in one piece has it applied as a date predicate here.
describe('an import obeys the ingestion window (issue #53)', () => {
  const HEADER =
    '﻿CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,' +
    'RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER\r\n';

  const messageRow = (date: string, content: string, convo = '2-b2xkLWNvbnZv'): string =>
    [
      convo,
      '',
      'Jane Doe',
      JANE_URL,
      'Alex Tester',
      'https://www.linkedin.com/in/alex-tester-synthetic-9z9z',
      date,
      '',
      `"${content}"`,
      'INBOX',
    ].join(',') + '\r\n';

  const daysAgo = (days: number): string => {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return `${d.toISOString().slice(0, 10)} 12:00:00 UTC`;
  };

  it('stores a message inside the window and not one older than it', async () => {
    const { app, a } = await boot();
    const messages =
      HEADER +
      messageRow(daysAgo(5), 'Recent: we are hiring a staff platform engineer.', '2-cmVjZW50') +
      messageRow(daysAgo(900), 'Ancient: we are hiring a staff platform engineer.', '2-b2xk');

    const { report } = await importAndRun(app, a, await exportZip({ messages }));

    const stored = await linkedinComms(app, a.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.snippet).toContain('Recent');
    // Not an error and not a duplicate: the user is told how much of their archive the window
    // left out, because otherwise an import of twenty years that yields four rows looks broken.
    expect(report.outsideWindow).toBe(1);
  });

  it('uses the window the user set, not the default', async () => {
    const { app, a } = await boot();
    const res = await a.request({
      method: 'PUT',
      url: '/api/v1/integrations/gmail/lookback',
      payload: { days: 30 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const messages =
      HEADER +
      messageRow(daysAgo(10), 'Inside thirty days: hiring a staff platform engineer.', '2-aW4=') +
      messageRow(daysAgo(60), 'Outside thirty days: hiring a staff platform engineer.', '2-b3V0');

    const { report } = await importAndRun(app, a, await exportZip({ messages }));

    const stored = await linkedinComms(app, a.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.snippet).toContain('Inside thirty days');
    expect(report.outsideWindow).toBe(1);
  });
});

// Issue #14: the external id used to hash the DATE column's raw text, so a later export that
// formats the same instant differently would fork every message's id and duplicate the whole
// history on re-import. It now hashes the parsed sentAt instead.
describe('message external_id survives a date format change (issue #14)', () => {
  const HEADER =
    '﻿CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,' +
    'RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER\r\n';

  const messageRow = (date: string, content: string, convo = '2-ZXh0ZXJuYWwtaWQ='): string =>
    [
      convo,
      '',
      'Jane Doe',
      JANE_URL,
      'Alex Tester',
      'https://www.linkedin.com/in/alex-tester-synthetic-9z9z',
      date,
      '',
      `"${content}"`,
      'INBOX',
    ].join(',') + '\r\n';

  it('does not duplicate a message when the same instant is written differently', async () => {
    const { app, a } = await boot();
    const content = 'We are hiring a staff platform engineer.';
    const first = HEADER + messageRow('2026-09-14 16:02:11 UTC', content);
    // The same instant LinkedIn could plausibly write a different way in a later export.
    const second = HEADER + messageRow('2026-09-14T16:02:11Z', content);

    const omit = ['Connections.csv'];
    await importAndRun(app, a, await exportZip({ messages: first, omit }));
    const { report } = await importAndRun(app, a, await exportZip({ messages: second, omit }));

    expect(report).toMatchObject({ created: 0, skipped: 1 });
    expect(await linkedinComms(app, a.userId)).toHaveLength(1);
  });

  it('does not duplicate a row already stored under the pre-fix id', async () => {
    // Simulates a row imported before this fix shipped: content and the raw DATE string are not
    // retained once stored (issue #53), so there is no way to migrate a stored row to the new
    // id — only to recognize it, from the row currently being imported, under the old one too.
    const { app, a } = await boot();
    const row = {
      line: 1,
      conversationId: '2-cHJlLWZpeC1yb3c=',
      conversationTitle: null,
      from: 'Jane Doe',
      senderUrl: JANE_URL,
      to: 'Alex Tester',
      date: '2026-09-14 16:02:11 UTC',
      sentAt: Date.parse('2026-09-14T16:02:11Z'),
      subject: null,
      content: 'We are hiring a staff platform engineer.',
    };
    await upsertInbound(app.db, { userId: a.userId, isAdmin: false }, 'linkedin', {
      externalId: legacyMessageExternalId(row, 1),
      threadKey: row.conversationId,
      from: row.from,
      to: [row.to],
      subject: '',
      snippet: row.content,
      bodyText: row.content,
      sentAt: row.sentAt,
    });

    const messages = HEADER + messageRow(row.date, row.content, row.conversationId);
    const { report } = await importAndRun(
      app,
      a,
      await exportZip({ messages, omit: ['Connections.csv'] }),
    );

    expect(report).toMatchObject({ created: 0, skipped: 1 });
    expect(await linkedinComms(app, a.userId)).toHaveLength(1);
  });

  it('still creates a message that was never imported under either id', async () => {
    const { app, a } = await boot();
    const messages =
      HEADER + messageRow('2026-09-14 16:02:11 UTC', 'We are hiring a staff platform engineer.');

    const { report } = await importAndRun(
      app,
      a,
      await exportZip({ messages, omit: ['Connections.csv'] }),
    );

    expect(report).toMatchObject({ created: 1, skipped: 0 });
    expect(await linkedinComms(app, a.userId)).toHaveLength(1);
  });
});

assertIsolated({
  name: 'linkedin import job status',
  create: async (c) => {
    const res = await upload(c, await exportZip());
    expect(res.statusCode, res.body).toBe(202);
    return (res.json() as { jobId: string }).jobId;
  },
  read: (c, id) => c.request({ method: 'GET', url: `/api/v1/imports/${id}` }),
});
