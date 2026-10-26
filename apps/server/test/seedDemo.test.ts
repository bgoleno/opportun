import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalFileStore } from '../src/adapters/localFile';
import {
  DEMO_MARKER_KEY,
  DEMO_SEED_ACK_KEY,
  DemoAiKeyFileError,
  DemoFlagNotSetError,
  DemoOverlayNotAckedError,
  MissingDemoMarkerError,
  UnexpectedUsersError,
  credsFromEnv,
  derivedId,
  seedDemo,
  type SeedDemoCredentials,
} from '../src/cli/seedDemo';
import {
  DEMO_COMMUNICATIONS,
  DEMO_COMPANIES,
  DEMO_MATCH_REPORTS,
  DEMO_OPPORTUNITIES,
  DEMO_RESUME_BASE_ID,
  DEMO_RESUME_BASE_SUMMARY,
  DEMO_RESUME_BASE_TEXT,
  DEMO_TAILORED_RESUMES,
  DEMO_USERS,
} from '../src/cli/seedDemoFixture';
import type { Db } from '../src/db/client';
import {
  communications,
  companies,
  opportunities,
  resumeMatchReports,
  resumes,
  secrets,
  settings,
  users,
} from '../src/db/schema';
import { createStorage } from '../src/lib/storage';
import type { UserCtx } from '../src/repos/base';
import { openTestDb } from './helpers';

const CREDS: SeedDemoCredentials = {
  adminPassword: 'demo admin password 1!',
  userPasswords: [
    'demo user1 password 1!',
    'demo user2 password 1!',
    'demo user3 password 1!',
    'demo user4 password 1!',
  ],
  aiApiKey: 'sk-ant-demo-fixture-key',
};

let close: () => Promise<void>;
let db: Db;
let dataDir: string;

// A literal object, never process.env: seedDemo takes its env as a parameter precisely so
// tests can do this. Vitest runs test files concurrently in the same process, so mutating
// process.env here (even with save/restore around each test) would leak into whichever other
// file happens to be running at the same moment -- a real flake this suite hit once, not a
// hypothetical. 64 hex characters for the master key: loadMasterKey's own format requirement,
// checked in config.test.ts, not re-litigated here. DATA_DIR is set fresh per test, below: the
// resume fixtures (#284) make seedDemo construct its own Storage from cfg.dataDir, which must
// point at openTestDb's own temp directory, not the default (./data relative to wherever the
// test runner's cwd happens to be) -- otherwise every test run would write real files there.
let TEST_ENV: NodeJS.ProcessEnv;

beforeEach(async () => {
  const opened = await openTestDb();
  close = opened.close;
  db = opened.handle.db;
  dataDir = opened.dataDir;
  TEST_ENV = {
    OPPORTUN_MASTER_KEY: 'ab'.repeat(32),
    OPPORTUN_DEMO: '1',
    [DEMO_SEED_ACK_KEY]: '1',
    OPPORTUN_BASE_URL: 'http://localhost:8080',
    DATA_DIR: opened.dataDir,
  };
});

afterEach(async () => {
  await close();
});

describe('derivedId', () => {
  it('is deterministic against a committed expected value, not just a second call', () => {
    // Computed once, offline, and pinned here: a same-process second call would still pass
    // even if the algorithm changed underneath it, which is exactly what this guards against.
    expect(derivedId('test-template-id', 0)).toBe('4f019362-431a-8e54-a23d-e54234e12eec');
    expect(derivedId('test-template-id', 1)).toBe('7c259a2d-3c8b-8068-9d49-a1e511dbac7d');
    expect(derivedId('01a16262-25da-7993-b4a8-f4657997972a', 2)).toBe(
      '20ffddfa-5110-8a92-8b4a-669d0942a307',
    );
  });

  it('sets the version-8 and variant nibbles correctly on every output', () => {
    for (let i = 0; i < 5; i++) {
      const id = derivedId('some-template', i);
      expect(id[14]).toBe('8'); // version nibble
      expect('89ab').toContain(id[19]); // variant nibble (RFC 9562 10xx)
    }
  });

  it('has no collisions across the real fixture template x user-index matrix', () => {
    const templates = [
      ...DEMO_USERS.map((u) => u.id),
      ...DEMO_COMPANIES.map((c) => c.id),
      ...DEMO_OPPORTUNITIES.map((o) => o.id),
    ];
    const seen = new Set<string>();
    for (const template of templates) {
      for (let userIndex = 0; userIndex < DEMO_USERS.length; userIndex++) {
        const id = derivedId(template, userIndex);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });
});

describe('seedDemo', () => {
  it('refuses when OPPORTUN_DEMO is not set to 1', async () => {
    const env = { ...TEST_ENV, OPPORTUN_DEMO: undefined };
    await expect(seedDemo(db, CREDS, undefined, env)).rejects.toThrow(DemoFlagNotSetError);
  });

  it(
    'refuses to seed an empty database when OPPORTUN_DEMO is set without the overlay ack, ' +
      'and writes nothing (a real, never-demo deployment on its first boot is also empty)',
    async () => {
      const envWithoutAck = { ...TEST_ENV };
      delete envWithoutAck[DEMO_SEED_ACK_KEY];
      await expect(seedDemo(db, CREDS, undefined, envWithoutAck)).rejects.toThrow(
        DemoOverlayNotAckedError,
      );
      const userRows = await db.select({ id: users.id }).from(users).all();
      expect(userRows).toHaveLength(0);
      const settingsRows = await db.select().from(settings).all();
      expect(settingsRows).toHaveLength(0);
    },
  );

  it('refuses when a non-pinned user already exists, even with the flag set', async () => {
    await db
      .insert(users)
      .values({
        id: 'not-one-of-the-five',
        email: 'owner@example.com',
        passwordHash: 'x',
        displayName: 'Owner',
        isAdmin: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    await expect(seedDemo(db, CREDS, undefined, TEST_ENV)).rejects.toThrow(UnexpectedUsersError);
    // Nothing seeded: the refusal happens before anything is written.
    const count = await db.select({ id: users.id }).from(users).all();
    expect(count).toHaveLength(1);
  });

  it('seeds five accounts, admin first, with company and opportunity data per user', async () => {
    const report = await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    expect(report.deletedExisting).toBe(false);
    expect(report.userIds).toHaveLength(5);

    const rows = await db.select().from(users).orderBy(users.createdAt).all();
    expect(rows).toHaveLength(5);
    expect(rows[0]!.isAdmin).toBe(true);
    expect(rows[0]!.email).toBe('demo-admin@opportun-demo.example');
    expect(rows.slice(1).every((u) => !u.isAdmin)).toBe(true);

    for (let i = 0; i < DEMO_USERS.length; i++) {
      const userId = DEMO_USERS[i]!.id;
      const theirCompanies = await db
        .select()
        .from(companies)
        .where(eq(companies.userId, userId))
        .all();
      expect(theirCompanies).toHaveLength(DEMO_COMPANIES.length);
      const theirOpportunities = await db
        .select()
        .from(opportunities)
        .where(eq(opportunities.userId, userId))
        .all();
      expect(theirOpportunities).toHaveLength(DEMO_OPPORTUNITIES.length);
      // Every stage the issue asks for is actually represented.
      const stages = new Set<string>(theirOpportunities.map((o) => o.stage));
      for (const stage of [
        'discovered',
        'interested',
        'preparing',
        'applied',
        'in_process',
        'offer',
        'dismissed',
        'closed',
      ]) {
        expect(stages.has(stage)).toBe(true);
      }
      const key = await db
        .select()
        .from(secrets)
        .where(and(eq(secrets.userId, userId), eq(secrets.kind, 'ai_api_key')))
        .get();
      expect(key?.label).toBe('anthropic');
    }

    const marker = await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, DEMO_MARKER_KEY), isNull(settings.userId)))
      .get();
    expect(marker?.value).toBe(true);
  });

  it('writes an explicit ai_budget well under the $5 default for every account', async () => {
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    for (const user of DEMO_USERS) {
      const row = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, `ai_budget:${user.id}`))
        .get();
      expect(row?.value).toEqual({ perTaskDailyUsd: 0.25 });
    }
  });

  it('every demo company is followed, so it is reachable in the Discovery > Companies UI', async () => {
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    for (const user of DEMO_USERS) {
      const theirCompanies = await db
        .select({ status: companies.status })
        .from(companies)
        .where(eq(companies.userId, user.id))
        .all();
      expect(theirCompanies).toHaveLength(DEMO_COMPANIES.length);
      expect(theirCompanies.every((c) => c.status === 'followed')).toBe(true);
    }
  });

  it('an unlinked solicitation needs review; linked communications do not (#280 acceptance)', async () => {
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    for (const user of DEMO_USERS) {
      const theirComms = await db
        .select()
        .from(communications)
        .where(eq(communications.userId, user.id))
        .all();
      expect(theirComms).toHaveLength(DEMO_COMMUNICATIONS.length);
      for (const fixture of DEMO_COMMUNICATIONS) {
        const row = theirComms.find(
          (c) => c.id === derivedId(fixture.id, DEMO_USERS.indexOf(user)),
        );
        expect(row).toBeDefined();
        // Unlinked and job-related (the solicitation) needs review, exactly the row that
        // was invisible in every inbox tab before this was fixed; linked ones do not,
        // since they already surface via the Linked tab.
        expect(row?.needsReview).toBe(fixture.opportunityId === null);
      }
    }
  });

  it('re-seeding is idempotent: same pinned ids, same row counts, not doubled', async () => {
    const first = await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    expect(first.deletedExisting).toBe(false);
    const second = await seedDemo(db, CREDS, Date.UTC(2026, 9, 2), TEST_ENV);
    expect(second.deletedExisting).toBe(true);
    expect(second.userIds).toEqual(first.userIds);

    const rows = await db.select({ id: users.id }).from(users).all();
    expect(rows).toHaveLength(5);
    for (const user of DEMO_USERS) {
      const theirOpportunities = await db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.userId, user.id))
        .all();
      expect(theirOpportunities).toHaveLength(DEMO_OPPORTUNITIES.length);
    }
  });

  it('a bookmarked opportunity id survives a reset unchanged', async () => {
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    const adminId = DEMO_USERS[0]!.id;
    const before = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.userId, adminId))
      .all();
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 2), TEST_ENV);
    const after = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.userId, adminId))
      .all();
    expect(new Set(after.map((o) => o.id))).toEqual(new Set(before.map((o) => o.id)));
  });

  it('seeds a base resume and a tailored variant per opportunity it names, readable and correctly linked', async () => {
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    const storage = createStorage(dataDir, dataDir);

    for (const user of DEMO_USERS) {
      const theirResumes = await db.select().from(resumes).where(eq(resumes.userId, user.id)).all();
      expect(theirResumes).toHaveLength(1 + DEMO_TAILORED_RESUMES.length);

      const base = theirResumes.find((r) => r.kind === 'base');
      expect(base).toBeDefined();
      expect(base?.store).toBe('local_file');
      expect(base?.opportunityId).toBeNull();
      expect(base?.parentResumeId).toBeNull();
      const ctx: UserCtx = { userId: user.id, isAdmin: false };
      const store = createLocalFileStore({ storage, db });
      expect(await store.readText(ctx, base!.docRef)).toBe(DEMO_RESUME_BASE_TEXT);

      for (const tailored of DEMO_TAILORED_RESUMES) {
        const row = theirResumes.find(
          (r) => r.id === derivedId(tailored.id, DEMO_USERS.indexOf(user)),
        );
        expect(row).toBeDefined();
        expect(row?.kind).toBe('tailored');
        expect(row?.store).toBe('local_file');
        expect(row?.parentResumeId).toBe(base!.id);
        expect(row?.opportunityId).toBe(
          derivedId(tailored.opportunityId, DEMO_USERS.indexOf(user)),
        );
        expect(row?.status).toBe(tailored.status);
        if (tailored.status === 'submitted') {
          expect(row?.submittedTo).toBe(tailored.submittedTo);
          expect(row?.submittedAt).not.toBeNull();
        } else {
          expect(row?.submittedTo).toBeNull();
        }
        const text = await store.readText(ctx, row!.docRef);
        expect(text).toContain(tailored.summary);
        expect(text).not.toContain(DEMO_RESUME_BASE_SUMMARY);
      }
    }
  });

  it('seeds a match report for every tailored resume, scored against the right opportunity', async () => {
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    for (const user of DEMO_USERS) {
      const userIndex = DEMO_USERS.indexOf(user);
      const reports = await db
        .select()
        .from(resumeMatchReports)
        .where(eq(resumeMatchReports.userId, user.id))
        .all();
      expect(reports).toHaveLength(DEMO_MATCH_REPORTS.length);
      for (const expected of DEMO_MATCH_REPORTS) {
        const row = reports.find((r) => r.resumeId === derivedId(expected.resumeId, userIndex));
        expect(row).toBeDefined();
        expect(row?.opportunityId).toBe(derivedId(expected.opportunityId, userIndex));
        expect(row?.report).toEqual({
          score: expected.score,
          missingKeywords: expected.missingKeywords,
          weakAreas: expected.weakAreas,
          summary: expected.summary,
        });
      }
    }
  });

  it('a bookmarked resume id survives a reset unchanged', async () => {
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    const adminId = DEMO_USERS[0]!.id;
    const before = await db
      .select({ id: resumes.id })
      .from(resumes)
      .where(eq(resumes.userId, adminId))
      .all();
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 2), TEST_ENV);
    const after = await db
      .select({ id: resumes.id })
      .from(resumes)
      .where(eq(resumes.userId, adminId))
      .all();
    expect(new Set(after.map((r) => r.id))).toEqual(new Set(before.map((r) => r.id)));
    // The base resume's own pinned id, specifically: this is the one a bookmarked demo URL
    // would actually name.
    expect(after.map((r) => r.id)).toContain(derivedId(DEMO_RESUME_BASE_ID, 0));
  });

  it('re-seeding does not duplicate resumes or match reports', async () => {
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 1), TEST_ENV);
    await seedDemo(db, CREDS, Date.UTC(2026, 9, 2), TEST_ENV);
    for (const user of DEMO_USERS) {
      const theirResumes = await db
        .select({ id: resumes.id })
        .from(resumes)
        .where(eq(resumes.userId, user.id))
        .all();
      expect(theirResumes).toHaveLength(1 + DEMO_TAILORED_RESUMES.length);
      const theirReports = await db
        .select({ resumeId: resumeMatchReports.resumeId })
        .from(resumeMatchReports)
        .where(eq(resumeMatchReports.userId, user.id))
        .all();
      expect(theirReports).toHaveLength(DEMO_MATCH_REPORTS.length);
    }
  });

  it('refuses to delete pinned ids that exist without the marker (not a database this seeded)', async () => {
    // Simulates a real user id coinciding with a pinned one -- astronomically unlikely with
    // UUIDs, but the point of this check was never to catch the likely case.
    await db
      .insert(users)
      .values({
        id: DEMO_USERS[0]!.id,
        email: 'coincidence@example.com',
        passwordHash: 'x',
        displayName: 'Not Actually Demo',
        isAdmin: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    await expect(seedDemo(db, CREDS, undefined, TEST_ENV)).rejects.toThrow(MissingDemoMarkerError);
    const row = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, DEMO_USERS[0]!.id))
      .get();
    expect(row?.email).toBe('coincidence@example.com');
  });
});

describe('credsFromEnv (issue #314: OPPORTUN_DEMO_AI_KEY_FILE)', () => {
  // The five passwords are never at issue here, so held fixed across every case below; only
  // the two AI-key variables change from one test to the next.
  const BASE_ENV: NodeJS.ProcessEnv = {
    OPPORTUN_DEMO_ADMIN_PASSWORD: 'demo admin password 1!',
    OPPORTUN_DEMO_USER1_PASSWORD: 'demo user1 password 1!',
    OPPORTUN_DEMO_USER2_PASSWORD: 'demo user2 password 1!',
    OPPORTUN_DEMO_USER3_PASSWORD: 'demo user3 password 1!',
    OPPORTUN_DEMO_USER4_PASSWORD: 'demo user4 password 1!',
  };

  it('reads the key from OPPORTUN_DEMO_AI_KEY alone', () => {
    const creds = credsFromEnv({ ...BASE_ENV, OPPORTUN_DEMO_AI_KEY: 'sk-ant-inline' });
    expect(creds?.aiApiKey).toBe('sk-ant-inline');
  });

  it('reads the key from OPPORTUN_DEMO_AI_KEY_FILE alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opportun-demo-ai-key-'));
    try {
      const file = join(dir, 'demo-ai.key');
      await writeFile(file, 'sk-ant-from-file\n');
      const creds = credsFromEnv({ ...BASE_ENV, OPPORTUN_DEMO_AI_KEY_FILE: file });
      expect(creds?.aiApiKey).toBe('sk-ant-from-file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers the file over the inline value when both are set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opportun-demo-ai-key-'));
    try {
      const file = join(dir, 'demo-ai.key');
      await writeFile(file, 'sk-ant-from-file');
      const creds = credsFromEnv({
        ...BASE_ENV,
        OPPORTUN_DEMO_AI_KEY: 'sk-ant-inline',
        OPPORTUN_DEMO_AI_KEY_FILE: file,
      });
      expect(creds?.aiApiKey).toBe('sk-ant-from-file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when neither is set', () => {
    expect(credsFromEnv(BASE_ENV)).toBeUndefined();
  });

  it('returns undefined when OPPORTUN_DEMO_AI_KEY_FILE is set but empty', () => {
    expect(credsFromEnv({ ...BASE_ENV, OPPORTUN_DEMO_AI_KEY_FILE: '' })).toBeUndefined();
  });

  it('throws, rather than falling back, when the file is set but unreadable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opportun-demo-ai-key-'));
    try {
      const missing = join(dir, 'nope.key');
      expect(() =>
        credsFromEnv({
          ...BASE_ENV,
          OPPORTUN_DEMO_AI_KEY: 'sk-ant-inline',
          OPPORTUN_DEMO_AI_KEY_FILE: missing,
        }),
      ).toThrow(DemoAiKeyFileError);
      expect(() => credsFromEnv({ ...BASE_ENV, OPPORTUN_DEMO_AI_KEY_FILE: missing })).toThrow(
        /OPPORTUN_DEMO_AI_KEY_FILE could not be read/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
