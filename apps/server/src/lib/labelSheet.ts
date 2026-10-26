// The hand-labelled backtest's sheet (spec D1, "Backtesting Stage 1"): a CSV of real senders
// and subject lines that one person labels `job` or `not-job`, which is the ship gate for the
// Stage 1 rules. Nothing here decides anything; it is the paperwork around someone's judgment.
//
// Decision D-6: this file never enters git. It is the only artifact in the project that holds
// mail content in plain text, and the repository is the one place that would keep it forever.
// scripts/labelSheet.ts enforces that; this module stays IO-free so it can be tested.
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const LABEL_HEADER = 'id,from,subject,classification,label';

/**
 * Decision D-6, as a check rather than a convention: the sheet may not be written anywhere
 * inside the repository. Compared by relative path, not by string prefix, so a sibling
 * directory whose name merely starts the same way is still a legal destination.
 */
export function assertSheetDestination(outPath: string, repoRoot: string): void {
  const rel = relative(resolve(repoRoot), resolve(outPath));
  const escapes = isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
  if (!escapes) {
    throw new Error(
      `label sheet: ${outPath} is inside the repository (${repoRoot}). It holds real senders ` +
        'and subject lines, so it is written outside the repo and never committed.',
    );
  }
}

/**
 * Which rows a human can label, for the columns the database actually has.
 *
 * A row with no subject cannot be labelled: Stage 1 filtered it or the user rejected it, and in
 * both cases the content is deliberately gone. The two triage columns arrived with Plan 1, and
 * the sheet has to be generatable from a database that predates them (a stale container, a
 * restored backup), so their conditions are added only when they exist.
 */
export function labellableWhere(columns: ReadonlySet<string>): string {
  const parts = ['subject IS NOT NULL'];
  if (columns.has('rejected_at')) parts.push('rejected_at IS NULL');
  if (columns.has('triage_decision')) {
    parts.push("(triage_decision IS NULL OR triage_decision != 'filtered')");
  }
  return parts.join(' AND ');
}

export interface SheetRow {
  id: string;
  from: string;
  subject: string;
  /**
   * What the classifier called it, as a hint only. It is NOT a label: an appointment reminder
   * is classified `scheduling`, and labelling from that would teach the rules to send clinic
   * mail to a model.
   */
  classification: string;
}

export interface LabelledRow extends SheetRow {
  label: 'job' | 'not-job' | null;
}

const NEEDS_QUOTES = /[",\n\r]/;

/** One CSV record, RFC 4180: quote when the cell needs it, double an embedded quote. */
export function csvLine(cells: string[]): string {
  return cells
    .map((cell) => (NEEDS_QUOTES.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(',');
}

export function renderLabelSheet(rows: SheetRow[]): string {
  const lines = [LABEL_HEADER];
  for (const r of rows) {
    lines.push(csvLine([r.id, r.from, r.subject, r.classification, '']));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A stable sample of `n` ids: ordered by a hash of the id, not at random and not by arrival.
 *
 * Stability is what makes the sheet worth filling in. The sample has to survive both a re-run
 * on the same data (someone labels half of it, then regenerates) and a re-run after more mail
 * has arrived, where a growing `n` must keep every row a smaller `n` already produced.
 */
export function sampleStable(ids: string[], n: number): string[] {
  return [...ids]
    .map((id) => ({ id, key: createHash('sha256').update(id).digest('hex') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, n)
    .map((x) => x.id);
}

/** Splits one CSV record, honoring quotes. Returns the cells in order. */
function splitRecord(record: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < record.length; i++) {
    const ch = record[i] as string;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (record[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** Splits a sheet into records, keeping newlines that are inside a quoted cell. */
function records(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === '\n' && !quoted) {
      out.push(current.replace(/\r$/, ''));
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current);
  return out;
}

/**
 * Reads a filled-in sheet back. Throws on a label that is neither `job` nor `not-job`, because
 * a typo that silently became "unlabelled" would quietly shrink the gate the sheet exists to be.
 */
export function parseLabelSheet(text: string): LabelledRow[] {
  const rows: LabelledRow[] = [];
  for (const record of records(text)) {
    if (record === LABEL_HEADER || record.trim() === '') continue;
    const [id = '', from = '', subject = '', classification = '', label = ''] = splitRecord(record);
    // Lowercased because a spreadsheet capitalizes the first letter of a cell on its own, and
    // "Job" is the label rather than a typo. Anything else still throws.
    const trimmed = label.trim().toLowerCase();
    if (trimmed !== '' && trimmed !== 'job' && trimmed !== 'not-job') {
      throw new Error(`label sheet: row ${id} has label "${trimmed}", expected job or not-job`);
    }
    rows.push({
      id,
      from,
      subject,
      classification,
      label: trimmed === '' ? null : trimmed,
    });
  }
  return rows;
}
