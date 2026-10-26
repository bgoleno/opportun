// Runs the Stage 1 backtest against a labelled sheet (spec D1, "Backtesting Stage 1").
//
//   pnpm --filter @opportun/server backtest -- --db <opportun.db> --labels <labelled.csv>
//
// The sheet is a label carrier, keyed by message id: the sender, subject and body are read from
// the database rather than from the CSV, so an editor that mangled the quoting, reordered the
// rows or dropped a column cannot change the result. Only the label column is taken from it.
//
// The output is counts, rule names and message ids. No message content is printed, and nothing
// is written: the labelled sheet stays where it is (decision D-6), and the database is opened
// read-only.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { backtest, formatMatrix, type BacktestRow } from '../src/lib/backtestTriage';
import { parseLabelSheet } from '../src/lib/labelSheet';
import type { MailFilterRuleRow } from '../src/repos/mailFilters';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const dbPath = arg('db');
const labelsPath = arg('labels');
if (dbPath === undefined || labelsPath === undefined) {
  fail('usage: backtest --db <opportun.db> --labels <labelled.csv> [--self <address>]');
}

const labelled = parseLabelSheet(readFileSync(resolve(labelsPath), 'utf8'));
const labels = new Map(labelled.map((r) => [r.id, r.label]));

const dataDir = dirname(resolve(dbPath));
const db = new Database(resolve(dbPath), { readonly: true, fileMustExist: true });

const hasTable = (name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
  undefined;

const rows = db
  .prepare(
    `SELECT id, "from" AS sender, COALESCE(subject, '') AS subject,
            COALESCE(snippet, '') AS snippet, body_ref AS bodyRef,
            thread_key AS threadKey, opportunity_id AS opportunityId
       FROM communications`,
  )
  .all() as {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  bodyRef: string | null;
  threadKey: string | null;
  opportunityId: string | null;
}[];

// The user's own rules count toward the verdict: a backtest that ignored them would score a
// configuration nobody is running.
const rules: MailFilterRuleRow[] = hasTable('mail_filter_rules')
  ? (
      db
        .prepare(
          `SELECT id, user_id AS userId, pattern, effect, enabled, source, note,
                created_at AS createdAt, updated_at AS updatedAt
           FROM mail_filter_rules`,
        )
        .all() as MailFilterRuleRow[]
    ).map((r) => ({ ...r, enabled: Boolean(r.enabled) }))
  : [];
db.close();

const linkedThreads = new Set(
  rows.filter((r) => r.opportunityId !== null && r.threadKey !== null).map((r) => r.threadKey),
);

const bodyOf = (ref: string | null): string => {
  if (ref === null) return '';
  try {
    return readFileSync(join(dataDir, ref), 'utf8');
  } catch {
    return '';
  }
};

const scored: BacktestRow[] = [];
let missing = 0;
for (const r of rows) {
  const label = labels.get(r.id);
  if (label === undefined) continue;
  scored.push({
    id: r.id,
    from: r.sender,
    subject: r.subject,
    body: `${r.snippet}\n${bodyOf(r.bodyRef)}`,
    label,
    threadLinked: r.threadKey !== null && linkedThreads.has(r.threadKey),
  });
}
for (const id of labels.keys()) {
  if (!rows.some((r) => r.id === id)) missing += 1;
}

const result = backtest(scored, { rules, selfAddress: arg('self') ?? null });
process.stdout.write(`${formatMatrix(result)}\n`);
if (missing > 0) {
  process.stdout.write(
    `\n  ${missing} labelled id(s) are not in this database: the sheet and the database differ.\n`,
  );
}
process.exit(result.passes ? 0 : 1);
