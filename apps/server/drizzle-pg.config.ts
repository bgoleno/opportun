import { defineConfig } from 'drizzle-kit';

// Postgres migrations (ADR-4, iteration 4 Task 8) into ./drizzle-pg, applied on boot by
// migrateLockedPg (src/db/client.ts). The chain starts at 0000_baseline.sql (the SQLite
// chain's head at iteration 4, seed rows included; scripts/pgBaseline.ts, never regenerated).
//
// Lockstep: every later schema change ships as a pair, drizzle/NNNN_<name>.sql (SQLite) and
// drizzle-pg/MMMM_<name>.sql (Postgres), with the same <name> and the same journal `when`
// (copy the SQLite entry's `when` into drizzle-pg/meta/_journal.json after generating). The
// numbers differ by the baseline's offset; the pair is keyed by name and `when`.
// test/migrationParity.test.ts fails when a migration lands in one chain only.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.pg.ts',
  out: './drizzle-pg',
});
