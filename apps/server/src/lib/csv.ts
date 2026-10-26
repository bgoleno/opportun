// Minimal RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines.
// Records carry the physical line they start on so import errors can point at it.
//
// Written cells are also guarded against spreadsheet formula injection (a cell starting with
// `=`, `+`, `-`, `@`, a tab or a CR runs as a formula in Excel, LibreOffice and Sheets, and
// company names, titles and notes can come from third parties): formatCsv prefixes such a
// value with an apostrophe, which unguardFormula removes on the way back in.

export class CsvError extends Error {
  override name = 'CsvError';
}

export interface CsvRecord {
  /** 1-based line the record starts on (the header is line 1). */
  line: number;
  fields: string[];
}

/** Parses CSV text (BOM and CRLF tolerated). Blank lines are skipped. */
export function parseCsv(input: string): CsvRecord[] {
  const text = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replace(/\r\n?/g, '\n');
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let line = 1;
  let startLine = 1;

  const endField = () => {
    fields.push(field);
    field = '';
    quotedField = false;
  };
  const endRecord = () => {
    endField();
    const blank = fields.length === 1 && fields[0] === '';
    if (!blank) records.push({ line: startLine, fields });
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '' && !quotedField) {
      inQuotes = true;
      quotedField = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRecord();
      line += 1;
      startLine = line;
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CsvError(`unterminated quoted field starting on line ${startLine}`);
  if (field !== '' || fields.length > 0) endRecord();
  return records;
}

function quote(value: string): string {
  return /[",\n\r]/.test(value) || value !== value.trim()
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/**
 * A formula lead, reached through any apostrophes already in front of it. A value that is
 * itself a guarded formula is guarded again, so one strip on import always gives it back.
 * An LF belongs to the set because parseCsv folds a CR into one: a guarded CR cell comes
 * back with an LF, and must still unguard.
 */
const FORMULA_LEAD = /^'*[=+\-@\t\r\n]/;

function guardFormula(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/** Drops the apostrophe formatCsv puts in front of a formula lead; other values pass through. */
export function unguardFormula(value: string): string {
  return value.startsWith("'") && FORMULA_LEAD.test(value) ? value.slice(1) : value;
}

/** Formats rows as CSV with LF line endings and a trailing newline. */
export function formatCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map((v) => quote(guardFormula(v))).join(',')).join('\n') + '\n';
}
