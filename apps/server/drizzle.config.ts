import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations into ./drizzle; they are applied on boot (src/db/client.ts).
//
// Chain health (issue #78, repaired): every drizzle/meta/NNNN_snapshot.json has a unique id,
// chains to the previous entry's id via prevId, and its content is the true cumulative schema
// as of that migration. Nothing but this tool reads these files -- not migrateLocked, not
// migrationParity.test.ts, which checks the chain's SQL-built result against the newest
// Postgres snapshot, never the SQLite meta files themselves -- so a broken chain costs nothing
// except the ability to run `generate` again; it was never a risk to the applied SQL or to a
// running instance.
//
// How #78 broke: generate cannot produce a pure-data migration (an INSERT, as every seeded
// default prompt is) at all, since it only diffs table/column/index structure. The fix each
// time was to hand-write the .sql, which is correct and still required for a data-only
// migration -- the bug was in NOT ALSO advancing the snapshot for it. Twice, several
// migrations in a row (hand-written for that reason, or bundled in one PR) copied the SAME
// preceding meta/snapshot.json forward across every one of their numbers, several with the
// SAME id and prevId. Two or more snapshots claiming the same prevId is the collision
// (`[...] are pointing to a parent snapshot [...] which is a collision`); it also meant real
// DDL some of those hand-written migrations DID contain (an ALTER TABLE, not just the data
// migrations) was never reflected in any snapshot either, silently, since nothing checks that.
//
// If this happens again, for a migration N that generate cannot produce (data-only, or several
// migrations landing in one PR where generate can only advance one step at a time):
//   1. Copy drizzle/meta/<N-1>_snapshot.json to <N>_snapshot.json. Replace its `id` with a
//      fresh uuid; set `prevId` to <N-1>'s own (original) id.
//   2. If N has no DDL (a pure data migration), stop here: the content is already correct,
//      unchanged from N-1.
//   3. If N DOES have DDL, run `generate` for real against the schema as it stands with just
//      N's change applied (temporarily revert any later migrations' schema.sqlite.ts edits if
//      several are queued in the same PR), one migration at a time, and let the tool write
//      both the .sql and the snapshot. Never hand-write the .sql for a real schema change and
//      then hand-copy a snapshot to match: that is exactly how this broke.
//   4. Before committing, run `generate` again with no further schema changes. It must print
//      "No schema changes, nothing to migrate" -- that emptiness is the proof the chain is
//      sound, not just that the tool stopped erroring.
//
// A real gap, not a chain problem, found while repairing #78: for a nullable self- or
// cross-table foreign key added via ALTER TABLE ADD COLUMN (drizzle-kit@0.31.11), the emitted
// .sql omits the column's ON DELETE/ON UPDATE clause even though the snapshot's own model
// records it correctly (confirmed in meta/*.json). Check a generated ADD COLUMN ... REFERENCES
// statement against the TS schema's onDelete/onUpdate before committing it; add the clause by
// hand if the tool dropped it. This stopped being just a warning to remember after issue #156:
// test/migrationForeignKeys.test.ts migrates the real chain into a real SQLite database and
// compares every applied ON DELETE/ON UPDATE against schema.sqlite.ts itself, so a dropped
// clause (this one, a future drizzle-kit regression, or a hand-written mistake) fails CI
// instead of waiting to be noticed by hand.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.sqlite.ts',
  out: './drizzle',
});
