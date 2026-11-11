// The Postgres twin of migrations.test.ts's "0040 updates the capture.linkedin system default in
// place" (https://github.com/bgoleno/opportun/issues/102, a review point on
// https://github.com/bgoleno/opportun/pull/95): drizzle-pg/0022_capture_linkedin_verbatim.sql
// updates the system default once and leaves a user's own version of the prompt alone. Runs only
// with TEST_DATABASE_URL set (CI's Postgres service), like the other live Postgres migration tests.
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptVariables, TASK_PROMPT_VARS } from '@opportun/ai';
import { newId } from '@opportun/core';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_PG_DIR, migrateLockedPg } from '../src/db/client';
import { livePgUrl, withScratchDatabase } from './pgScratch';

const TAG = '0022_capture_linkedin_verbatim';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A copy of the Postgres migrations folder whose journal stops just before `tag`. */
async function chainBefore(tag: string): Promise<string> {
  const partial = await mkdtemp(join(tmpdir(), 'opportun-pg-0022-'));
  temps.push(partial);
  await cp(MIGRATIONS_PG_DIR, partial, { recursive: true });
  const path = join(partial, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(path, 'utf8')) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((e) => e.tag === tag);
  expect(at, `${tag} is in the journal`).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, at);
  await writeFile(path, JSON.stringify(journal));
  return partial;
}

interface PromptRow {
  id: string;
  userId: string | null;
  taskKey: string;
  body: string;
  version: string;
  active: boolean;
}

const promptsOf = async (pool: pg.Pool, where: string, params: unknown[] = []) =>
  (
    await pool.query<PromptRow>(
      `SELECT id, user_id AS "userId", task_key AS "taskKey", body, version::text AS version, is_active AS active
         FROM prompts WHERE ${where} ORDER BY id`,
      params,
    )
  ).rows;

describe.runIf(livePgUrl !== undefined)('0022 capture.linkedin verbatim on Postgres (live)', () => {
  it('updates the system default once, in place, and leaves a user’s own version alone', async () => {
    const partial = await chainBefore(TAG);
    await withScratchDatabase(async (url) => {
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      try {
        await migrateLockedPg(pool, partial);

        // A user with their own version of the prompt, made from the default before 0022.
        const userId = newId();
        await pool.query(
          `INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
           VALUES ($1, $2, 'x', 'U', 1, 1)`,
          [userId, `${userId}@example.com`],
        );
        const [before] = await promptsOf(pool, `user_id IS NULL AND task_key = 'capture.linkedin'`);
        expect(before!.body).toContain('- location: the city, region, or country as stated.');
        await pool.query(
          `INSERT INTO prompts (id, user_id, task_key, name, body, version, is_active, created_at, updated_at)
           VALUES ($1, $2, 'capture.linkedin', 'mine', $3, 2, true, 1, 1)`,
          [newId(), userId, before!.body],
        );
        const othersBefore = await promptsOf(pool, `task_key <> 'capture.linkedin'`);

        // The real upgrade path: every remaining migration, 0022 included.
        await migrateLockedPg(pool);

        const system = await promptsOf(pool, `user_id IS NULL AND task_key = 'capture.linkedin'`);
        expect(system).toHaveLength(1);
        expect(system[0]).toMatchObject({ id: before!.id, version: '1', active: true });
        const body = system[0]!.body;
        expect(body).toMatch(
          /location: on a job, the location copied exactly as the page states it/,
        );
        expect(body).toMatch(/compNote: on a job, the pay copied exactly as the page states it/);
        expect(body).toMatch(/descriptionMd: always null/);
        expect(body).not.toContain('clean Markdown');
        // Each replace() appears once: the update ran once, not once per statement or boot.
        expect(body.split('copied exactly as the page states it').length - 1).toBe(2);
        expect(body.split('thrown away, so never paraphrase them').length - 1).toBe(1);
        expect(promptVariables(body)).toEqual([...TASK_PROMPT_VARS['capture.linkedin']]);

        const mine = await promptsOf(pool, `user_id = $1 AND task_key = 'capture.linkedin'`, [
          userId,
        ]);
        expect(mine).toHaveLength(1);
        expect(mine[0]!.body).toBe(before!.body);
        // The other prompts are as they were. The chain runs to the end, so a later migration may
        // add a system default for a task that had none (as migrations.test.ts's 0040 test allows).
        const known = new Set(othersBefore.map((r) => r.id));
        const othersAfter = await promptsOf(pool, `task_key <> 'capture.linkedin'`);
        // company.suggest v2 (0039, #221), the rank default's reorder (0043, #388) and the
        // classify default's reorder (0044, #380) rewrote their system defaults in place, after
        // 0022: those rows are checked apart, and every other row is as it was.
        const rewritten = (r: PromptRow) =>
          r.userId === null &&
          ['company.suggest', 'discovery.rank', 'comms.classify'].includes(r.taskKey);
        expect(othersAfter.filter((r) => known.has(r.id) && !rewritten(r))).toEqual(
          othersBefore.filter((r) => !rewritten(r)),
        );
        const rewrittenRow = (task: string) =>
          othersAfter.find((r) => rewritten(r) && r.taskKey === task)!;
        expect(rewrittenRow('company.suggest').body).toContain('{{industry_profile_untrusted}}');
        const rank = rewrittenRow('discovery.rank').body;
        expect(rank.indexOf('## Output')).toBeLessThan(rank.indexOf('## Posting'));
        const classify = rewrittenRow('comms.classify').body;
        expect(classify.indexOf('## What to decide')).toBeLessThan(
          classify.indexOf('{{message_untrusted}}'),
        );
        const tasksBefore = new Set(othersBefore.map((r) => r.taskKey));
        for (const added of othersAfter.filter((r) => !known.has(r.id))) {
          expect(added.userId, added.taskKey).toBeNull();
          expect(tasksBefore.has(added.taskKey), added.taskKey).toBe(false);
        }

        // Re-running 0022 itself changes nothing.
        const sql = await readFile(join(MIGRATIONS_PG_DIR, `${TAG}.sql`), 'utf8');
        for (const stmt of sql.split('--> statement-breakpoint')) await pool.query(stmt);
        const [again] = await promptsOf(pool, `user_id IS NULL AND task_key = 'capture.linkedin'`);
        expect(again!.body).toBe(body);
      } finally {
        await pool.end();
      }
    });
  });
});
