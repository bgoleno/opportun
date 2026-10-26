// Seeds (or re-seeds) the invitation-only demo instance (issue #280):
//
//   OPPORTUN_DEMO=1 OPPORTUN_DEMO_SEED_ACK=1 OPPORTUN_DEMO_ADMIN_PASSWORD=...
//   OPPORTUN_DEMO_USER1_PASSWORD=... [...USER2..USER4] OPPORTUN_DEMO_AI_KEY=...
//   node --import tsx src/cli/seedDemo.ts
//
// OPPORTUN_DEMO_SEED_ACK=1 is normally set by deploy/compose.demo.yml itself, not typed by
// hand; running this CLI directly (local dev, no compose overlay) needs it on the command
// line like everything else above. See requireDemoOverlay below for why it exists.
//
// OPPORTUN_DEMO_AI_KEY_FILE (a path to a file holding the key) is accepted in place of
// OPPORTUN_DEMO_AI_KEY, and wins when both are set (issue #314); see demoAiKeyFromEnv below.
//
// Five accounts (one admin, four demo users), each with its own independent copy of the same
// invented dataset -- opportunities.id and every other row id is a single global primary key,
// not scoped per user, so "the same dataset per user" means five copies with five different
// sets of ids, not one dataset five accounts share.
//
// Idempotent by design, because the reset job (#280 PR2) calls this exact function on a
// schedule and a human re-running it by hand (any time an operator wants a clean demo) must
// not collide on the pinned ids from the previous run.
//
// Three gates stand before anything is seeded, and they answer different questions. OPPORTUN_DEMO
// declares intent: this deployment means to behave as a demo, which a real deployment simply
// never claims. The pinned-ids check proves it structurally: a demo instance's user set is
// always a subset of the five pinned ids (empty before the first seed, exactly those five
// after), so any OTHER user existing -- the owner's own account, on his real instance -- fails
// it immediately, with nothing to misconfigure and nothing to forget. Neither gate alone was
// enough: the flag can be set by mistake, and skipping the pinned-ids check would have let a
// bare OPPORTUN_DEMO=1 inject five demo accounts into a real database and mark it, which would
// then make the NEXT run's delete path trust it.
//
// Those two gates still share one gap: a real, never-demo deployment on its very first boot is
// also empty, so "no non-pinned user exists" passes for it exactly as it does for a genuine
// demo's first seed. OPPORTUN_DEMO=1 cannot close that gap by itself, because it is exactly the
// kind of stray flag that could survive a copy-paste from .env.demo.example into a real
// deployment's own .env. requireDemoOverlay (DEMO_SEED_ACK_KEY) is the third gate, closing it by
// construction rather than by trusting the flag harder: deploy/compose.demo.yml hardcodes that
// variable as a literal in its own environment block, never interpolated from .env, so it is
// present in the container if and only if the demo overlay was actually applied. A deployment
// that never applied it cannot silently become a self-wiping demo, no matter what else its own
// .env says.
//
// A fourth, narrower check guards the delete specifically, once the three gates above have
// already established this is meant to be the demo and that only demo-shaped users exist: if
// the pinned ids are already present, the in-database marker (a settings row with userId: null,
// written only by this function) must also be present, or this refuses to delete rather than
// trusting a coincidence. With pinned UUIDs a collision with a real account is effectively
// impossible, but the check costs nothing.
//
// Hashing happens before any transaction opens: Argon2id is deliberate CPU work with no
// database involvement, and holding the write gate across five of them would only slow down
// whatever else is trying to write at the time. Everything else -- the pinned-ids check, the
// delete, all five accounts, their data, the marker -- is one withTransaction, specifically so
// the pinned-ids check and the delete it guards cannot be separated by a window in which some
// other writer inserts a stray user between them: the write gate from BEGIN IMMEDIATE to
// COMMIT/ROLLBACK (db/client.ts's withTransaction) closes that gap by construction, rather than
// relying on the check having already run recently enough. That is what makes the stated
// failure mode true rather than aspirational: a failed FIRST seed rolls back to zero rows, so
// there is nothing for a human to clean up by hand. A failed RESET is different and does not
// need the same help: the marker is a settings row with no FK to any user, so it survives the
// delete, and a reset that fails after deleting but before finishing the reseed leaves a
// database with partial demo rows and a still-valid marker -- which the next run's pinned-ids
// and marker checks both still pass, so it simply deletes whatever partial rows exist and
// reseeds cleanly. Self-healing, not a case to build recovery machinery for.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq, inArray, notInArray } from 'drizzle-orm';
import { companyMatchKey, dedupeKey } from '@opportun/core';
import { loadConfig, loadSqliteDir } from '../config';
import { closeDatabase, connectDatabase, withTransaction, type Db, type Exec } from '../db/client';
import {
  activities,
  attachments,
  companies,
  nextSteps,
  opportunities,
  resumeMatchReports,
  resumeRules,
  resumes,
  roleTargets,
  settings,
  stageHistory,
  users,
  communications,
} from '../db/schema';
import { budgetKey, writeSetting } from '../lib/ai';
import { bindVaultKey, putSecretIn } from '../lib/secretBox';
import { hashPassword } from '../lib/passwords';
import { REGISTRATION_OPEN_KEY, registerUser } from '../lib/registration';
import { createStorage, readOperatorFile, type Storage } from '../lib/storage';
import type { UserCtx } from '../repos/base';
import { needsReviewFor } from '../repos/communications';
import {
  DEMO_ACTIVITIES,
  DEMO_COMMUNICATIONS,
  DEMO_COMPANIES,
  DEMO_MATCH_REPORTS,
  DEMO_NEXT_STEPS,
  DEMO_OPPORTUNITIES,
  DEMO_RESUME_BASE_ID,
  DEMO_RESUME_BASE_SUMMARY,
  DEMO_RESUME_BASE_TEXT,
  DEMO_RESUME_BASE_TITLE,
  DEMO_TAILORED_RESUMES,
  DEMO_USERS,
} from './seedDemoFixture';

export const DEMO_MARKER_KEY = 'demo_mode';
const AI_PROVIDER = 'anthropic';
const PER_TASK_DAILY_USD = 0.25;

export interface SeedDemoCredentials {
  adminPassword: string;
  /** Index 0 is user1's password, ... index 3 is user4's. */
  userPasswords: readonly [string, string, string, string];
  aiApiKey: string;
}

export interface SeedDemoReport {
  deletedExisting: boolean;
  userIds: readonly string[];
  companiesPerUser: number;
  opportunitiesPerUser: number;
  /** The base resume plus every tailored variant (#284). */
  resumesPerUser: number;
}

export class DemoFlagNotSetError extends Error {}
export class UnexpectedUsersError extends Error {}
export class MissingDemoMarkerError extends Error {}
export class DemoOverlayNotAckedError extends Error {}

/**
 * Deterministic, not random: stable across every seed and every nightly reset, so a
 * bookmarked opportunity URL survives one, unlike newId()'s uuidv7 which is fresh every call.
 * A pure function of (templateId, userIndex) with a fixed algorithm (SHA-256 over a literal
 * string, truncated into the UUID layout) is stable forever: nothing environmental, nothing
 * from a library whose output could change across a major version.
 *
 * RFC 9562 version 8 ("custom") rather than a deterministic v7: this matters, not just a style
 * choice. v7 encodes a timestamp in its own bits, and this fixture's timestamps are relative
 * to seed time, so a fixed v7 prefix baked in here would permanently disagree with whatever
 * createdAt a given seed run actually computes for that row. v8 has no embedded time to
 * disagree with anything. The trade-off this accepts: v8 ids are not chronologically sortable
 * the way newId()'s v7 ids are, so a derived id's sort position carries no meaning (checked:
 * every orderBy(...id) in this codebase uses id only as a tiebreak after a real timestamp
 * column, except jobs/classifyBackfill.ts's keyset pagination, which does not apply to seeded
 * rows -- their classification is written directly, never null, so that job has nothing of
 * theirs to page through).
 */
export function derivedId(templateId: string, userIndex: number): string {
  const digest = createHash('sha256').update(`${templateId}:${userIndex}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ctxFor(userId: string, isAdmin: boolean): UserCtx {
  return { userId, isAdmin };
}

function requireDemoFlag(env: NodeJS.ProcessEnv): void {
  if (env.OPPORTUN_DEMO !== '1') {
    throw new DemoFlagNotSetError(
      'OPPORTUN_DEMO is not set to 1. This script declares a deployment as a demo instance; ' +
        'it does not run against one that has not said so.',
    );
  }
}

/** The literal env var deploy/compose.demo.yml's own environment block hardcodes (never read
 *  from an operator's .env, unlike every other variable in this file). See requireDemoOverlay. */
export const DEMO_SEED_ACK_KEY = 'OPPORTUN_DEMO_SEED_ACK';

/**
 * A real, never-demo deployment that is still empty (its very first boot) looks identical to a
 * genuine demo's first seed: requireOnlyPinnedUsers passes either way, because "no non-pinned
 * user exists" is trivially true when no user exists at all. OPPORTUN_DEMO=1 alone cannot
 * disambiguate the two, because it is exactly the kind of stray flag that could survive a
 * copy-paste from .env.demo.example into a real deployment's own .env.
 *
 * DEMO_SEED_ACK_KEY closes that gap by construction rather than by trusting intent harder:
 * deploy/compose.demo.yml sets it as a literal value in its own environment block, not
 * interpolated from .env. It is therefore present in the container if and only if that overlay
 * was actually applied (`-f deploy/compose.yml -f deploy/compose.demo.yml`); a deployment
 * running compose.yml alone never has it, no matter what an operator's own .env says.
 */
function requireDemoOverlay(env: NodeJS.ProcessEnv): void {
  if (env[DEMO_SEED_ACK_KEY] !== '1') {
    throw new DemoOverlayNotAckedError(
      `${DEMO_SEED_ACK_KEY} is not set to 1. deploy/compose.demo.yml sets this itself; it is ` +
        "not something to add by hand to a deployment's own .env. Seeing OPPORTUN_DEMO=1 " +
        'without it usually means that flag was carried over by mistake (e.g. from ' +
        '.env.demo.example into a real deployment) rather than genuinely requested: refusing ' +
        'to seed, rather than silently turning this deployment into one that wipes itself ' +
        'nightly.',
    );
  }
}

/** A demo instance's user set is always a subset of the five pinned ids: empty before the
 *  first seed, exactly those five after. Any other user existing means this is not a demo
 *  instance, structurally, with nothing to misconfigure and nothing to forget.
 *
 *  Takes `Exec`, not `Db`: called from inside seedDemo's own transaction (passing `tx`), so the
 *  check and the delete it guards run under the same write lock, with no gap between them for
 *  another writer to insert a stray user into. */
async function requireOnlyPinnedUsers(db: Exec, pinnedIds: readonly string[]): Promise<void> {
  const stray = await db
    .select({ id: users.id })
    .from(users)
    .where(notInArray(users.id, [...pinnedIds]))
    .limit(1)
    .get();
  if (stray !== undefined) {
    throw new UnexpectedUsersError(
      `refusing to seed: a user exists (${stray.id}) that is not one of the five pinned demo ` +
        `ids. A demo instance's users are always a subset of those five; this is not one.`,
    );
  }
}

async function deleteExistingDemoUsers(tx: Exec, userIds: readonly string[]): Promise<boolean> {
  const existing = await tx
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, [...userIds]))
    .all();
  if (existing.length === 0) return false;
  const marker = await tx
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, DEMO_MARKER_KEY))
    .get();
  if (marker === undefined) {
    throw new MissingDemoMarkerError(
      `refusing to delete: ${existing.length} of the pinned demo user id(s) already exist, ` +
        `but ${DEMO_MARKER_KEY} is not set. This does not look like a database seedDemo ` +
        `created; not touching it.`,
    );
  }
  await tx
    .delete(users)
    .where(inArray(users.id, [...userIds]))
    .run();
  return true;
}

async function seedOneUserAccount(
  tx: Exec,
  user: (typeof DEMO_USERS)[number],
  passwordHash: string,
  now: number,
): Promise<void> {
  await registerUser(tx, {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    passwordHash,
    now: now + user.createdAtOffsetMs,
  });
}

/** Company name for dedupeKey(company, title, location): looked up from the fixture rather
 *  than passing the id, since dedupeKey hashes the human-readable name, not a row id. */
function companyNameFor(companyId: string): string {
  const company = DEMO_COMPANIES.find((c) => c.id === companyId);
  if (company === undefined) throw new Error(`fixture bug: no company with id ${companyId}`);
  return company.name;
}

async function seedOneUserData(
  db: Db,
  tx: Exec,
  ctx: UserCtx,
  userIndex: number,
  aiApiKey: string,
  now: number,
): Promise<{ companies: number; opportunities: number }> {
  await writeSetting(tx, ctx, budgetKey(ctx.userId), { perTaskDailyUsd: PER_TASK_DAILY_USD });
  // putSecretIn, not putSecret: the vault key is bound to the outer db handle (bindVaultKey,
  // called once above), not to a transaction handle, so sealing the value needs `db`
  // specifically while the write itself runs on `tx` and commits or rolls back with it.
  await putSecretIn(tx, db, ctx, 'ai_api_key', AI_PROVIDER, aiApiKey);

  for (const company of DEMO_COMPANIES) {
    await tx
      .insert(companies)
      .values({
        id: derivedId(company.id, userIndex),
        userId: ctx.userId,
        name: company.name,
        domain: company.domain,
        careersUrl: company.careersUrl,
        // Every demo company is meant to show up as a followed one with its ats_kind
        // visible (Discovery > Companies). The schema default, 'none', is what the real
        // follow path always overwrites before a company is ever user-visible there
        // (routes/companies.ts); a raw insert that skips it leaves every card unreachable
        // (#280 acceptance).
        status: 'followed',
        atsKind: company.atsKind,
        atsRef: company.atsRef,
        companyMatchKey: companyMatchKey(company.name),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  for (const opp of DEMO_OPPORTUNITIES) {
    const oppId = derivedId(opp.id, userIndex);
    const key =
      opp.possibleDuplicateOf == null
        ? dedupeKey(companyNameFor(opp.companyId), opp.title, opp.location)
        : null;
    const lastStage = opp.stageHistory[opp.stageHistory.length - 1]!;
    await tx
      .insert(opportunities)
      .values({
        id: oppId,
        userId: ctx.userId,
        companyId: derivedId(opp.companyId, userIndex),
        title: opp.title,
        descriptionMd: opp.descriptionMd,
        postingUrl: null,
        sourceKind: 'manual',
        location: opp.location,
        remote: opp.remote,
        compNote: opp.compNote,
        stage: opp.stage,
        closedReason: opp.closedReason ?? null,
        dismissedReason: opp.dismissedReason ?? null,
        dedupeKey: key,
        possibleDuplicateOf:
          opp.possibleDuplicateOf == null ? null : derivedId(opp.possibleDuplicateOf, userIndex),
        postingState: opp.postingState ?? null,
        postingStateDetail: opp.postingStateDetail ?? null,
        createdAt: now + opp.stageHistory[0]!.offsetMs,
        updatedAt: now + lastStage.offsetMs,
      })
      .run();
    let fromStage: (typeof opp.stageHistory)[number]['stage'] | null = null;
    for (const step of opp.stageHistory) {
      await tx
        .insert(stageHistory)
        .values({
          id: derivedId(`${opp.id}:stage:${step.stage}:${step.offsetMs}`, userIndex),
          userId: ctx.userId,
          opportunityId: oppId,
          fromStage,
          toStage: step.stage,
          note: null,
          at: now + step.offsetMs,
        })
        .run();
      fromStage = step.stage;
    }
  }

  for (const comm of DEMO_COMMUNICATIONS) {
    const opportunityId =
      comm.opportunityId == null ? null : derivedId(comm.opportunityId, userIndex);
    await tx
      .insert(communications)
      .values({
        id: derivedId(comm.id, userIndex),
        userId: ctx.userId,
        channel: 'gmail',
        externalId: derivedId(comm.id, userIndex),
        from: comm.from,
        to: [],
        subject: comm.subject,
        snippet: comm.snippet,
        bodyRef: null,
        sentAt: now + comm.offsetMs,
        classification: comm.classification,
        outreachKind: comm.outreachKind,
        confidence: comm.confidence,
        opportunityId,
        // The real classify-and-save path computes this (needsReviewFor), never leaves it
        // at the schema default: a seeded row that skips it is invisible in every inbox tab
        // (neither Needs Review nor Linked), not merely wrong (#280 acceptance).
        needsReview: needsReviewFor(
          comm.classification,
          comm.outreachKind,
          comm.confidence,
          opportunityId !== null,
        ),
        createdAt: now + comm.offsetMs,
        updatedAt: now + comm.offsetMs,
      })
      .run();
  }

  for (const activity of DEMO_ACTIVITIES) {
    await tx
      .insert(activities)
      .values({
        id: derivedId(activity.id, userIndex),
        userId: ctx.userId,
        opportunityId: derivedId(activity.opportunityId, userIndex),
        kind: activity.kind,
        title: activity.title,
        bodyMd: activity.bodyMd,
        occurredAt: now + activity.offsetMs,
        participants: [],
        createdAt: now + activity.offsetMs,
        updatedAt: now + activity.offsetMs,
      })
      .run();
  }

  for (const step of DEMO_NEXT_STEPS) {
    await tx
      .insert(nextSteps)
      .values({
        id: derivedId(step.id, userIndex),
        userId: ctx.userId,
        opportunityId: derivedId(step.opportunityId, userIndex),
        action: step.action,
        dueAt: now + step.dueOffsetMs,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  await tx
    .insert(roleTargets)
    .values({
      id: derivedId(`role-target:${userIndex}`, userIndex),
      userId: ctx.userId,
      name: 'Senior Software Engineer',
      titleFamily: 'Software Engineer',
      seniorityMin: 5,
      industries: [],
      keywords: ['platform', 'backend', 'distributed systems'],
      locations: ['Remote (US)'],
      remotePref: 'remote',
      compMin: 170_000,
      currency: 'USD',
      createdAt: now,
      updatedAt: now,
    })
    .run();

  await tx
    .insert(resumeRules)
    .values([
      {
        id: derivedId(`resume-rule:1:${userIndex}`, userIndex),
        userId: ctx.userId,
        ruleText: 'Lead every bullet with the outcome, not the task.',
        category: 'style',
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: derivedId(`resume-rule:2:${userIndex}`, userIndex),
        userId: ctx.userId,
        ruleText: 'Never include a previous employer client list.',
        category: 'redaction',
        sortOrder: 10,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();

  return { companies: DEMO_COMPANIES.length, opportunities: DEMO_OPPORTUNITIES.length };
}

interface WrittenResumeFile {
  storedPath: string;
  sha256: string;
  bytes: number;
}

/**
 * Writes the base resume's content and every tailored variant's content once, before any
 * transaction opens: filesystem I/O has no database involvement, the same reasoning
 * seedDemo's own hashPassword calls already follow, and holding the write gate across disk
 * writes is exactly what tripped the gate watchdog ("transaction awaited outside the
 * database") the first time this was written with the write inside the loop below.
 * writeAttachment is content-addressed, so the same text for all five users' copies only
 * ever needs writing once, not once per user.
 */
async function writeResumeFiles(
  storage: Storage,
): Promise<{ base: WrittenResumeFile; tailored: readonly WrittenResumeFile[] }> {
  const base = await storage.writeAttachment(Buffer.from(DEMO_RESUME_BASE_TEXT, 'utf8'));
  const tailored = await Promise.all(
    DEMO_TAILORED_RESUMES.map(async (t) => {
      const text = DEMO_RESUME_BASE_TEXT.replace(DEMO_RESUME_BASE_SUMMARY, t.summary);
      return await storage.writeAttachment(Buffer.from(text, 'utf8'));
    }),
  );
  return { base, tailored };
}

/**
 * The base resume plus a tailored variant for every opportunity DEMO_TAILORED_RESUMES names,
 * and a match report for each of those -- purely database writes, using content
 * writeResumeFiles already wrote. Each version's content is a real attachments row
 * (local_file, #284): userId set, opportunityId always null (see the schema column comment
 * for why that is load-bearing), which is what lets attachmentSweep understand these files
 * with no change -- a version's file is protected while its row exists and reclaimed after,
 * exactly like any other attachment, including this function's own nightly cascade-delete.
 * Two derivedId calls per resume, not one: the attachments row and the resumes row are
 * different rows with different ids, and the resume's docRef names the attachment's id (not
 * a bare path -- see localFile.ts for why).
 */
async function seedOneUserResumes(
  files: { base: WrittenResumeFile; tailored: readonly WrittenResumeFile[] },
  tx: Exec,
  ctx: UserCtx,
  userIndex: number,
  now: number,
): Promise<number> {
  const baseResumeId = derivedId(DEMO_RESUME_BASE_ID, userIndex);
  const baseAttachmentId = derivedId(`${DEMO_RESUME_BASE_ID}:attachment`, userIndex);
  await tx
    .insert(attachments)
    .values({
      id: baseAttachmentId,
      userId: ctx.userId,
      opportunityId: null,
      filename: `${DEMO_RESUME_BASE_TITLE}.txt`,
      mime: 'text/plain',
      bytes: files.base.bytes,
      sha256: files.base.sha256,
      storedPath: files.base.storedPath,
      createdAt: now,
    })
    .run();
  await tx
    .insert(resumes)
    .values({
      id: baseResumeId,
      userId: ctx.userId,
      kind: 'base',
      opportunityId: null,
      title: DEMO_RESUME_BASE_TITLE,
      store: 'local_file',
      docRef: baseAttachmentId,
      parentResumeId: null,
      status: 'final',
      submittedAt: null,
      submittedTo: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  for (let i = 0; i < DEMO_TAILORED_RESUMES.length; i++) {
    const tailored = DEMO_TAILORED_RESUMES[i]!;
    const written = files.tailored[i]!;
    const attachmentId = derivedId(`${tailored.id}:attachment`, userIndex);
    const resumeId = derivedId(tailored.id, userIndex);
    const preparedAt = now + tailored.preparedOffsetMs;
    const submitted = tailored.status === 'submitted';
    await tx
      .insert(attachments)
      .values({
        id: attachmentId,
        userId: ctx.userId,
        opportunityId: null,
        filename: `${tailored.title}.txt`,
        mime: 'text/plain',
        bytes: written.bytes,
        sha256: written.sha256,
        storedPath: written.storedPath,
        createdAt: preparedAt,
      })
      .run();
    await tx
      .insert(resumes)
      .values({
        id: resumeId,
        userId: ctx.userId,
        kind: 'tailored',
        opportunityId: derivedId(tailored.opportunityId, userIndex),
        title: tailored.title,
        store: 'local_file',
        docRef: attachmentId,
        parentResumeId: baseResumeId,
        status: tailored.status,
        submittedAt: submitted ? preparedAt : null,
        submittedTo: submitted ? (tailored.submittedTo ?? null) : null,
        archivedAt: null,
        createdAt: preparedAt,
        updatedAt: preparedAt,
      })
      .run();
  }

  for (const report of DEMO_MATCH_REPORTS) {
    await tx
      .insert(resumeMatchReports)
      .values({
        userId: ctx.userId,
        resumeId: derivedId(report.resumeId, userIndex),
        opportunityId: derivedId(report.opportunityId, userIndex),
        report: {
          score: report.score,
          missingKeywords: report.missingKeywords,
          weakAreas: report.weakAreas,
          summary: report.summary,
        },
        scoredAt: now + report.scoredOffsetMs,
      })
      .run();
  }

  return 1 + DEMO_TAILORED_RESUMES.length;
}

export async function seedDemo(
  db: Db,
  creds: SeedDemoCredentials,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedDemoReport> {
  requireDemoFlag(env);
  requireDemoOverlay(env);
  const cfg = loadConfig(env);
  bindVaultKey(db, cfg.masterKey);
  const storage = createStorage(cfg.dataDir, cfg.sqliteDir);
  const userIds = DEMO_USERS.map((u) => u.id);

  // CPU work and filesystem I/O, neither with any database involvement: done before the
  // write gate opens, not inside it.
  const passwords = [creds.adminPassword, ...creds.userPasswords];
  const passwordHashes = await Promise.all(passwords.map((p) => hashPassword(p, cfg.peppers)));
  const resumeFiles = await writeResumeFiles(storage);

  let companiesPerUser = 0;
  let opportunitiesPerUser = 0;
  let resumesPerUser = 0;
  const deletedExisting = await withTransaction(
    db,
    async (tx) => {
      // Inside the transaction, not before it: see the header comment above for why this and
      // the delete it guards must share the same write lock, with no gap between them.
      await requireOnlyPinnedUsers(tx, userIds);
      const deleted = await deleteExistingDemoUsers(tx, userIds);
      for (let i = 0; i < DEMO_USERS.length; i++) {
        const user = DEMO_USERS[i]!;
        // registerUser closes registration after the first account (FR-S2), same as the real
        // route: reopen it for the four demo users, same as the issue's own sequence ("register
        // the admin, reopen, register four, close"), then leave it closed at the end -- an
        // invite-only demo stays invite-only, admin and demo accounts alike.
        if (i === 1) {
          await tx
            .insert(settings)
            .values({ key: REGISTRATION_OPEN_KEY, userId: null, value: true, updatedAt: now })
            .onConflictDoUpdate({ target: settings.key, set: { value: true, updatedAt: now } })
            .run();
        }
        await seedOneUserAccount(tx, user, passwordHashes[i]!, now);
        const ctx = ctxFor(user.id, i === 0);
        const counts = await seedOneUserData(db, tx, ctx, i, creds.aiApiKey, now);
        companiesPerUser = counts.companies;
        opportunitiesPerUser = counts.opportunities;
        resumesPerUser = await seedOneUserResumes(resumeFiles, tx, ctx, i, now);
      }
      await tx
        .insert(settings)
        .values({ key: REGISTRATION_OPEN_KEY, userId: null, value: false, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: false, updatedAt: now } })
        .run();
      // Written last and only here: the acceptance guard for the nightly reset checks this
      // before ever deleting anything (see deleteExistingDemoUsers above). Because this whole
      // function is one transaction, a failed first seed rolls back to zero rows, not to a
      // half-seeded instance with no marker; only a failed RESET can leave partial rows behind,
      // and it does so with the marker still present (settings has no FK to cascade away),
      // which is exactly what lets the next run's checks pass and clean up on its own.
      await tx
        .insert(settings)
        .values({ key: DEMO_MARKER_KEY, userId: null, value: true, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: true, updatedAt: now } })
        .run();
      return deleted;
    },
    { scope: 'seed_demo' },
  );

  return { deletedExisting, userIds, companiesPerUser, opportunitiesPerUser, resumesPerUser };
}

const USAGE = [
  'Usage: OPPORTUN_DEMO=1 OPPORTUN_DEMO_SEED_ACK=1 OPPORTUN_DEMO_ADMIN_PASSWORD=...',
  '  OPPORTUN_DEMO_USER1_PASSWORD=... (...USER2..USER4) OPPORTUN_DEMO_AI_KEY=...',
  '  (or OPPORTUN_DEMO_AI_KEY_FILE=path/to/key) node --import tsx src/cli/seedDemo.ts',
  '  Run against the same DATA_DIR (and SQLITE_DIR / DB_DIALECT / DATABASE_URL) as the server.',
].join('\n');

export class DemoAiKeyFileError extends Error {}

/**
 * OPPORTUN_DEMO_AI_KEY_FILE or OPPORTUN_DEMO_AI_KEY (issue #314): the env var alone is readable
 * by anything that can run `docker inspect` on the host and shows up in process listings and
 * crash dumps, which is exactly what this repo's `_FILE` convention (OPPORTUN_MASTER_KEY_FILE,
 * DATABASE_URL_FILE) exists to avoid elsewhere. The file wins when both are set, not the inline
 * value: an operator migrating a running demo to the file form sets the new variable first and
 * removes the old one second, and this way the key is already being read from the file the
 * moment it exists rather than staying on the wider-exposure path until the cleanup step. A
 * file that is set but unreadable throws rather than silently falling back to the inline var or
 * treating the key as absent, the same fail-loud choice loadMasterKey and loadDatabaseUrl
 * (config.ts) make for their own `_FILE` variables.
 */
function demoAiKeyFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.OPPORTUN_DEMO_AI_KEY_FILE;
  if (file !== undefined && file !== '') {
    try {
      return readOperatorFile(resolve(file)).trim();
    } catch (err) {
      throw new DemoAiKeyFileError(
        `OPPORTUN_DEMO_AI_KEY_FILE could not be read (${file}): ${(err as Error).message}`,
      );
    }
  }
  const inline = env.OPPORTUN_DEMO_AI_KEY;
  return inline === undefined || inline === '' ? undefined : inline;
}

export function credsFromEnv(env: NodeJS.ProcessEnv): SeedDemoCredentials | undefined {
  const adminPassword = env.OPPORTUN_DEMO_ADMIN_PASSWORD;
  const userPasswords = [
    env.OPPORTUN_DEMO_USER1_PASSWORD,
    env.OPPORTUN_DEMO_USER2_PASSWORD,
    env.OPPORTUN_DEMO_USER3_PASSWORD,
    env.OPPORTUN_DEMO_USER4_PASSWORD,
  ];
  const aiApiKey = demoAiKeyFromEnv(env);
  if (
    adminPassword === undefined ||
    aiApiKey === undefined ||
    userPasswords.some((p) => p === undefined)
  ) {
    return undefined;
  }
  return {
    adminPassword,
    userPasswords: userPasswords as unknown as readonly [string, string, string, string],
    aiApiKey,
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const dataDir = resolve(
    process.env.DATA_DIR === undefined || process.env.DATA_DIR === ''
      ? './data'
      : process.env.DATA_DIR,
  );
  const run = async (): Promise<number> => {
    const creds = credsFromEnv(process.env);
    if (creds === undefined) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    const sqliteDir = loadSqliteDir(process.env, dataDir);
    const handle = await connectDatabase({
      dataDir,
      sqliteDir,
      db: loadConfig(process.env).db,
    });
    const { db } = handle;
    try {
      const report = await seedDemo(db, creds);
      process.stdout.write(
        `${report.deletedExisting ? 'Re-seeded' : 'Seeded'} ${report.userIds.length} accounts, ` +
          `${report.companiesPerUser} companies, ${report.opportunitiesPerUser} opportunities ` +
          `and ${report.resumesPerUser} resumes each.\n`,
      );
      return 0;
    } finally {
      await closeDatabase(handle);
    }
  };
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
