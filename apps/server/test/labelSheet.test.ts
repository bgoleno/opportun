// The hand-labelled backtest's input sheet (spec D1, "Backtesting Stage 1").
//
// This sheet is the one artifact in the project that holds real mail content in plain text:
// senders and subject lines straight out of the user's mailbox. Decision D-6 is that it never
// enters git, so the guard that refuses to write it inside the repository is a tested behavior
// and not a convention. The rest is the dull mechanics that make the sheet worth 30 minutes of
// someone's time: a stable sample, so re-running it does not shuffle the rows out from under a
// half-labelled file, and CSV quoting that survives subject lines written by strangers.
import { describe, expect, it } from 'vitest';
import {
  assertSheetDestination,
  labellableWhere,
  csvLine,
  LABEL_HEADER,
  parseLabelSheet,
  renderLabelSheet,
  sampleStable,
  type SheetRow,
} from '../src/lib/labelSheet';

const row = (over: Partial<SheetRow> = {}): SheetRow => ({
  id: 'c1',
  from: 'Riley Recruiter <riley@acme.example>',
  subject: 'Senior Platform Engineer',
  classification: 'other',
  ...over,
});

describe('csvLine', () => {
  it('quotes a cell containing a comma, a quote or a newline', () => {
    expect(csvLine(['a,b'])).toBe('"a,b"');
    expect(csvLine(['say "hi"'])).toBe('"say ""hi"""');
    expect(csvLine(['two\nlines'])).toBe('"two\nlines"');
  });

  it('leaves an ordinary cell alone', () => {
    expect(csvLine(['c1', 'other', ''])).toBe('c1,other,');
  });
});

describe('renderLabelSheet', () => {
  it('starts with the header and leaves every label blank', () => {
    const sheet = renderLabelSheet([row({ id: 'c1' }), row({ id: 'c2' })]);
    const lines = sheet.trimEnd().split('\n');

    expect(lines[0]).toBe(LABEL_HEADER);
    expect(lines).toHaveLength(3);
    for (const line of lines.slice(1)) expect(line.endsWith(',')).toBe(true);
  });

  it('survives a subject line written by a stranger', () => {
    const nasty = 'Re: "urgent", 50% off\nclick here';
    const sheet = renderLabelSheet([row({ subject: nasty })]);

    expect(parseLabelSheet(sheet)[0]?.subject).toBe(nasty);
  });
});

describe('sampleStable', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);

  it('takes the same rows every run, so a half-labelled sheet can be regenerated', () => {
    expect(sampleStable(ids, 200)).toEqual(sampleStable(ids, 200));
  });

  it('is not just the first n in input order', () => {
    expect(sampleStable(ids, 200)).not.toEqual(ids.slice(0, 200));
  });

  it('keeps a growing sample a superset of a smaller one', () => {
    // A re-run after more mail arrives must not drop a row the user already labelled.
    const small = sampleStable(ids, 100);
    expect(sampleStable(ids, 200)).toEqual(expect.arrayContaining(small));
  });

  it('returns everything when asked for more than it has', () => {
    expect(sampleStable(['a', 'b'], 50).sort()).toEqual(['a', 'b']);
  });
});

describe('parseLabelSheet', () => {
  it('reads back the labels a human typed', () => {
    const sheet = [
      LABEL_HEADER,
      'c1,riley@acme.example,"Senior Platform Engineer",other,job',
      'c2,billing@clinic-a.example,Appointment reminder,scheduling,not-job',
      'c3,x@y.example,Unlabelled,other,',
    ].join('\n');

    expect(parseLabelSheet(sheet).map((r) => r.label)).toEqual(['job', 'not-job', null]);
  });

  it('accepts the capitalization a spreadsheet applies on its own', () => {
    // Real sheets come back with 'Job' in a couple of rows. That is the label, not a typo,
    // and dropping those rows would quietly shrink the gate they were meant to tighten.
    const sheet = [
      LABEL_HEADER,
      'c1,a@b.example,Subject,other,Job',
      'c2,a@b.example,S,other,NOT-JOB',
    ].join('\n');

    expect(parseLabelSheet(sheet).map((r) => r.label)).toEqual(['job', 'not-job']);
  });

  it('rejects a label that is not one of the two', () => {
    const sheet = [LABEL_HEADER, 'c1,a@b.example,Subject,other,maybe'].join('\n');

    expect(() => parseLabelSheet(sheet)).toThrow(/maybe/);
  });
});

describe('assertSheetDestination', () => {
  const repo = '/home/dev/opportun';

  it('refuses to write the sheet anywhere inside the repository (D-6)', () => {
    expect(() => assertSheetDestination('/home/dev/opportun/docs/labels.csv', repo)).toThrow(
      /inside the repository/i,
    );
    expect(() => assertSheetDestination('/home/dev/opportun', repo)).toThrow();
    // ..-walks resolve before the check, so this is inside too.
    expect(() => assertSheetDestination('/home/dev/opportun/apps/../labels.csv', repo)).toThrow();
  });

  it('accepts a path outside it, including one whose name starts the same way', () => {
    expect(() => assertSheetDestination('/home/dev/labels.csv', repo)).not.toThrow();
    // The prefix trap: this directory is not the repository.
    expect(() => assertSheetDestination('/home/dev/opportun-labels/x.csv', repo)).not.toThrow();
  });
});

describe('labellableWhere', () => {
  // The sheet is generated against whatever database it is pointed at, including one that
  // predates the mail-filter migrations: a stale container, or a restored backup.
  it('excludes rejected and filtered rows when those columns exist', () => {
    const where = labellableWhere(new Set(['subject', 'rejected_at', 'triage_decision']));
    expect(where).toContain('rejected_at IS NULL');
    expect(where).toContain("triage_decision IS NULL OR triage_decision != 'filtered'");
  });

  it('still works on a database from before those columns existed', () => {
    const where = labellableWhere(new Set(['subject']));
    expect(where).toBe('subject IS NOT NULL');
  });
});
