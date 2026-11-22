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
// First, before anything that loads the AI SDK: see unsetEmptyAiBaseUrls.ts for why.
import '../unsetEmptyAiBaseUrls';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadSqliteDir } from '../config';
import { closeDatabase, connectDatabase } from '../db/client';
import { credsFromEnv, seedDemo } from '../lib/demo/seed';
import { queueInFlightBatchCleanups } from '../jobs/rankBatch';

// The seed itself is lib/demo/seed.ts (#765): this file is only the command.
const USAGE = [
  'Usage: OPPORTUN_DEMO=1 OPPORTUN_DEMO_SEED_ACK=1 OPPORTUN_DEMO_ADMIN_PASSWORD=...',
  '  OPPORTUN_DEMO_USER1_PASSWORD=... (...USER2..USER4) OPPORTUN_DEMO_AI_KEY=...',
  '  (or OPPORTUN_DEMO_AI_KEY_FILE=path/to/key) node --import tsx src/cli/seedDemo.ts',
  '  Run against the same DATA_DIR (and SQLITE_DIR / DB_DIALECT / DATABASE_URL) as the server.',
].join('\n');

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
      // As the nightly reset does (#784): a batch in flight gets its cleanup queued.
      const report = await seedDemo(db, creds, undefined, undefined, {
        beforeDelete: queueInFlightBatchCleanups,
      });
      process.stdout.write(
        `${report.deletedExisting ? 'Re-seeded' : 'Seeded'} ${report.userIds.length} accounts, ` +
          `${report.companiesPerUser} companies, ${report.opportunitiesPerUser} opportunities, ` +
          `${report.resumesPerUser} resumes and ${report.contactsPerUser} contacts each.\n`,
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
