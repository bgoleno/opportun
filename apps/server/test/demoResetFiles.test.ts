// The demo's nightly reset leaves nothing of a visitor's behind, files included
// (https://github.com/bgoleno/opportun/issues/544, sec's lifetime condition on #542): no device
// token, submission, snapshot row, snapshot file or uploaded file of a demo user remains, and a
// token minted before the reset gets 401. The seed's own resume files are rewritten with the same
// content, so the same hashes, and must survive (sec on #544).
import { randomBytes } from 'node:crypto';
import { newId } from '@opportun/core';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DEMO_SEED_ACK_KEY, derivedId } from '../src/cli/seedDemo';
import {
  DEMO_IDENTITY_VALUES,
  DEMO_RESUME_BASE_ID,
  DEMO_RESUME_BASE_TEXT,
  DEMO_TAILORED_RESUMES,
  DEMO_USERS,
} from '../src/cli/seedDemoFixture';
import {
  applicationSubmissions,
  attachments,
  communications,
  deviceTokens,
  opportunities,
  profiles,
  users,
} from '../src/db/schema';
import { runDemoReset } from '../src/jobs/demoReset';
import { removeIfUnreferenced } from '../src/jobs/attachmentSweep';
import { isFixtureIdentity } from '../src/lib/demoOwnData';
import { createDeviceToken } from '../src/lib/deviceTokens';
import { createSubmissionDraft } from '../src/repos/submissions';
import { testApp } from './helpers';
import { requisition } from './submissionFixtures';

function demoEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
    OPPORTUN_BASE_URL: 'https://demo.example.com',
    DATA_DIR: dataDir,
    OPPORTUN_DEMO: '1',
    [DEMO_SEED_ACK_KEY]: '1',
    OPPORTUN_DEMO_ADMIN_PASSWORD: 'demo-admin-password-1',
    OPPORTUN_DEMO_USER1_PASSWORD: 'demo-user1-password-1',
    OPPORTUN_DEMO_USER2_PASSWORD: 'demo-user2-password-1',
    OPPORTUN_DEMO_USER3_PASSWORD: 'demo-user3-password-1',
    OPPORTUN_DEMO_USER4_PASSWORD: 'demo-user4-password-1',
    OPPORTUN_DEMO_AI_KEY: 'sk-test-demo-key',
  };
}

const ON_THE_DEMO = { demo: true, submissions: true, demoSubmissions: true } as const;

async function read(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

describe('the demo reset removes a visitor’s files too (#544)', () => {
  it('a visitor’s upload and snapshot file are gone, the seeded resume’s file stays, and an old token gets 401', async () => {
    const { app, dataDir } = await testApp(ON_THE_DEMO, {});
    try {
      await runDemoReset(app.db, demoEnv(dataDir));
      const visitor = DEMO_USERS[1]!;
      const ctx = { userId: visitor.id, isAdmin: false };

      // What a visitor leaves: an uploaded file, a snapshot's file, a draft and a device token.
      const opp = (await app.db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(eq(opportunities.userId, visitor.id))
        .get())!;
      await app.db
        .update(opportunities)
        .set({ stage: 'interested', atsJobRef: requisition(), postingState: 'confirmed' })
        .where(eq(opportunities.id, opp.id))
        .run();
      const files = [];
      for (const [name, text] of [
        ['upload.pdf', 'a visitor upload'],
        ['snapshot.pdf', 'a submission snapshot'],
      ] as const) {
        const file = await app.storage.writeAttachment(Buffer.from(`${text} ${newId()}`));
        await app.db
          .insert(attachments)
          .values({
            id: newId(),
            userId: visitor.id,
            opportunityId: opp.id,
            filename: name,
            mime: 'application/pdf',
            bytes: file.bytes,
            sha256: file.sha256,
            storedPath: file.storedPath,
            createdAt: Date.now(),
          })
          .run();
        files.push(file.storedPath);
      }
      await createSubmissionDraft(
        app.db,
        ctx,
        opp.id,
        { idempotencyKey: crypto.randomUUID() },
        {
          demo: true,
        },
      );
      const { token } = await createDeviceToken(app.db, ctx, {
        name: 'Chrome',
        scopes: ['apply:assist'],
      });
      const seededFile = (await app.db
        .select({ path: attachments.storedPath })
        .from(attachments)
        .where(eq(attachments.id, derivedId(`${DEMO_RESUME_BASE_ID}:attachment`, 1)))
        .get())!.path;
      for (const path of [...files, seededFile]) {
        expect(await app.storage.attachmentMtime(path), path).toBeDefined();
      }

      await runDemoReset(app.db, demoEnv(dataDir));

      for (const path of files)
        expect(await app.storage.attachmentMtime(path), path).toBeUndefined();
      expect(await app.storage.attachmentMtime(seededFile)).toBeDefined();
      expect(await read(await app.storage.openAttachment(seededFile))).toBe(DEMO_RESUME_BASE_TEXT);
      const demoIds = DEMO_USERS.map((u) => u.id);
      expect(
        await app.db
          .select()
          .from(applicationSubmissions)
          .where(inArray(applicationSubmissions.userId, demoIds))
          .all(),
      ).toEqual([]);
      expect(
        await app.db.select().from(deviceTokens).where(inArray(deviceTokens.userId, demoIds)).all(),
      ).toEqual([]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/connector/apply/current?url=https%3A%2F%2Fboards.greenhouse.io%2Fx%2Fjobs%2F1',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('an email body stored for a visitor goes too, and a file a communication still references stays (tl on #550)', async () => {
    const { app, dataDir } = await testApp(ON_THE_DEMO, {});
    try {
      await runDemoReset(app.db, demoEnv(dataDir));
      const visitor = DEMO_USERS[3]!;
      const body = await app.storage.writeAttachment(Buffer.from(`an email body ${newId()}`));
      const communication = (stored: string) => ({
        id: newId(),
        userId: visitor.id,
        channel: 'gmail' as const,
        externalId: newId(),
        from: 'someone@example.com',
        sentAt: Date.now(),
        bodyRef: stored,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await app.db.insert(communications).values(communication(body.storedPath)).run();

      await runDemoReset(app.db, demoEnv(dataDir));
      expect(await app.storage.attachmentMtime(body.storedPath)).toBeUndefined();

      // The removal reads both tables: a file only a communication points at is kept.
      const kept = await app.storage.writeAttachment(Buffer.from(`another body ${newId()}`));
      await app.db.insert(communications).values(communication(kept.storedPath)).run();
      expect(await removeIfUnreferenced(app.db, app.storage, kept.storedPath)).toBe(false);
      expect(await app.storage.attachmentMtime(kept.storedPath)).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

describe('the fixture identity list covers every identity value the seed writes (tl on #544)', () => {
  it('each seeded account’s email and name, each profile value, and the candidate in the resume text', async () => {
    const { app, dataDir } = await testApp(ON_THE_DEMO, {});
    try {
      await runDemoReset(app.db, demoEnv(dataDir));
      const seen: string[] = [];
      for (const u of await app.db.select().from(users).all()) seen.push(u.email, u.displayName);
      for (const p of await app.db.select().from(profiles).all()) {
        for (const v of [p.fullName, p.email, p.phone, p.location, ...p.links.map((l) => l.url)]) {
          if (v !== null && v !== undefined) seen.push(v);
        }
      }
      // The resume's own header: the candidate's name, and every email anywhere in its text.
      seen.push(DEMO_RESUME_BASE_TEXT.split('\n')[0]!);
      seen.push(...(DEMO_RESUME_BASE_TEXT.match(/\S+@\S+/g) ?? []));
      for (const t of DEMO_TAILORED_RESUMES) {
        seen.push(...(t.summary.match(/\S+@\S+/g) ?? []));
      }
      expect(seen.length).toBeGreaterThan(10);
      for (const value of seen) expect(isFixtureIdentity('any', value), value).toBe(true);
      expect(DEMO_IDENTITY_VALUES.length).toBe(DEMO_USERS.length * 2 + 2);
    } finally {
      await app.close();
    }
  });
});
