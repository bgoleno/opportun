// The Stage 1 backtest (spec D1, "Backtesting Stage 1"): score the rules against rows a human
// labelled, and decide whether the rules may ship.
//
// The gate is asymmetric, because the two errors are not comparable:
//
//   a row labelled `job` that the rules DROP is mail the user never sees again. Zero of these
//     are allowed, and one is enough to fail the gate.
//   a row labelled `not-job` that the rules PASS reaches Stage 2, which is what Stage 2 is for.
//     These are counted and reported, and they do not fail anything.
//
// The report names the ids of dropped job mail, because "two were dropped" is not actionable
// and "these two were dropped, by this rule" is.
import { senderAddress } from '../adapters/sources/alertEmail';
import type { MailFilterRuleRow } from '../repos/mailFilters';
import { triageMessage, type TriageRule } from './mailTriage';

export interface BacktestRow {
  id: string;
  /** The From header as stored, display name and all: this extracts the address itself. */
  from: string;
  subject: string;
  body: string;
  label: 'job' | 'not-job' | null;
  threadLinked: boolean;
}

export interface DroppedJob {
  id: string;
  rule: TriageRule;
  /** Which term decided, for the rules that match text. Never the message's own words. */
  signal: string | null;
}

export interface BacktestResult {
  rows: number;
  labelled: number;
  skipped: number;
  keptJob: number;
  droppedJob: DroppedJob[];
  passedNotJob: number;
  droppedNotJob: number;
  byRule: Partial<Record<TriageRule, number>>;
  /**
   * Rows whose From header could not be parsed. These PASS by design (fail open, toward the
   * human), which means a harness that hands the rules the wrong thing scores a clean sheet on
   * no evidence at all. So they are counted, and too many of them fails the gate.
   */
  unreadable: number;
  /** The gate: true when no row labelled `job` was dropped and the run proved something. */
  passes: boolean;
}

/** One unreadable sender in this many labelled rows is the most a trustworthy run may have. */
const UNREADABLE_LIMIT_DENOMINATOR = 10;

export interface BacktestOptions {
  rules?: MailFilterRuleRow[];
  consumerVeto?: boolean;
  selfAddress?: string | null;
}

export function backtest(rows: BacktestRow[], opts: BacktestOptions = {}): BacktestResult {
  const result: BacktestResult = {
    rows: rows.length,
    labelled: 0,
    skipped: 0,
    keptJob: 0,
    droppedJob: [],
    passedNotJob: 0,
    droppedNotJob: 0,
    byRule: {},
    unreadable: 0,
    passes: true,
  };
  for (const row of rows) {
    if (row.label === null) {
      result.skipped += 1;
      continue;
    }
    result.labelled += 1;
    const verdict = triageMessage({
      address: senderAddress(row.from),
      subject: row.subject,
      body: row.body,
      rules: opts.rules ?? [],
      consumerVeto: opts.consumerVeto ?? true,
      selfAddress: opts.selfAddress ?? null,
      threadLinked: row.threadLinked,
      // The sheet carries no alert-digest senders: a digest is routed to Discovery without
      // being classified, so it is not one of the messages a label is about.
      digestSender: false,
    });
    result.byRule[verdict.matchedRule] = (result.byRule[verdict.matchedRule] ?? 0) + 1;
    if (verdict.matchedRule === 'unreadable_sender') result.unreadable += 1;
    if (row.label === 'job') {
      if (verdict.decision === 'pass') result.keptJob += 1;
      else {
        result.droppedJob.push({
          id: row.id,
          rule: verdict.matchedRule,
          signal: verdict.signal ?? null,
        });
      }
    } else if (verdict.decision === 'pass') result.passedNotJob += 1;
    else result.droppedNotJob += 1;
  }
  // One in ten unreadable senders is not a mailbox, it is a harness bug: the rules were handed
  // something that is not an address, every one of those rows passed without being judged, and
  // the sheet would report a gate pass that means nothing.
  result.passes =
    result.droppedJob.length === 0 &&
    result.unreadable * UNREADABLE_LIMIT_DENOMINATOR <= result.labelled;
  return result;
}

/** The report, which is the artifact: the counts, the gate verdict, and what to go look at. */
export function formatMatrix(result: BacktestResult): string {
  const out: string[] = [
    'Stage 1 backtest',
    `  ${result.rows} rows, ${result.labelled} labelled, ${result.skipped} skipped`,
    '',
    `  labelled job      ${String(result.labelled - result.passedNotJob - result.droppedNotJob).padStart(5)}` +
      `   kept ${result.keptJob}   dropped ${result.droppedJob.length}`,
    `  labelled not-job  ${String(result.passedNotJob + result.droppedNotJob).padStart(5)}` +
      `   kept ${result.passedNotJob}   dropped ${result.droppedNotJob}`,
    '',
    '  by rule',
  ];
  for (const [rule, n] of Object.entries(result.byRule).sort((a, b) => b[1] - a[1])) {
    out.push(`    ${rule.padEnd(18)} ${String(n).padStart(5)}`);
  }
  out.push('');
  if (result.unreadable * UNREADABLE_LIMIT_DENOMINATOR > result.labelled) {
    out.push(
      `  GATE FAILED: ${result.unreadable} of ${result.labelled} senders could not be read, so ` +
        'those rows passed without being judged. Fix the input before reading anything else here.',
    );
    return out.join('\n');
  }
  if (result.passes) {
    out.push('  GATE PASSED: no message labelled job was dropped.');
    out.push('  Messages labelled not-job that passed are expected: that is what Stage 2 is for.');
  } else {
    out.push(`  GATE FAILED: ${result.droppedJob.length} message(s) labelled job were dropped.`);
    for (const d of result.droppedJob) {
      out.push(`    ${d.id}  ${d.rule}${d.signal === null ? '' : ` "${d.signal}"`}`);
    }
  }
  return out.join('\n');
}
