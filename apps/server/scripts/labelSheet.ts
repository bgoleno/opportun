// Generates the Stage 1 backtest's label sheet (spec D1, "Backtesting Stage 1").
//
//   pnpm --filter @opportun/server labels -- --db <path to opportun.db> --out <path outside repo>
//
// Reads one Opportun database read-only and writes a CSV of every message a human could label,
// ordered by sender so a run of mail from one place can be judged once. The `classification`
// column is a hint, not a label: an appointment reminder is classified `scheduling`, and
// labelling from that column would teach the rules to send clinic mail to a model.
//
// The sheet holds real senders and subject lines, so (decision D-6) it refuses to be written
// inside the repository, it is created readable only by its owner, and it never overwrites an
// existing file: someone's half-finished labelling is not this script's to discard.
import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertSheetDestination,
  labellableWhere,
  renderLabelSheet,
  sampleStable,
  type SheetRow,
} from '../src/lib/labelSheet';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const DEFAULT_OTHER_SAMPLE = 200;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const dbPath = arg('db');
const outPath = arg('out');
if (dbPath === undefined || outPath === undefined) {
  fail('usage: labels --db <opportun.db> --out <path outside the repo> [--other <n>]');
}
const otherSample = Number(arg('other') ?? DEFAULT_OTHER_SAMPLE);
if (!Number.isInteger(otherSample) || otherSample < 0) fail('--other must be a whole number');

assertSheetDestination(outPath, REPO_ROOT);
if (existsSync(outPath)) {
  fail(`${outPath} already exists. Labelling it is work; pass a different --out.`);
}

const db = new Database(resolve(dbPath), { readonly: true, fileMustExist: true });
interface Row extends SheetRow {
  userId: string;
}
const columns = new Set(
  (db.prepare('PRAGMA table_info(communications)').all() as { name: string }[]).map((c) => c.name),
);
const rows = db
  .prepare(
    `SELECT id, user_id AS userId, "from" AS "from", subject,
            COALESCE(classification, '(unclassified)') AS classification
       FROM communications
      WHERE ${labellableWhere(columns)}
      ORDER BY "from" COLLATE NOCASE, sent_at`,
  )
  .all() as Row[];
db.close();

const users = new Set(rows.map((r) => r.userId));
const other = rows.filter((r) => r.classification === 'other');
const keptOther = new Set(
  sampleStable(
    other.map((r) => r.id),
    otherSample,
  ),
);
const sheet = rows.filter((r) => r.classification !== 'other' || keptOther.has(r.id));

writeFileSync(outPath, renderLabelSheet(sheet), { mode: 0o600 });

process.stdout.write(
  [
    `${rows.length} labellable messages (${users.size} user${users.size === 1 ? '' : 's'})`,
    `${rows.length - other.length} classified as something, ${other.length} as other`,
    `sheet: ${sheet.length} rows (all of the first group, ${keptOther.size} sampled from other)`,
    `written to ${outPath}, owner-readable only`,
    '',
    'Label the last column `job` or `not-job`. Leave a row blank to skip it.',
    'Judge it as mail: would a job-search tool be right to read this message?',
  ].join('\n') + '\n',
);
