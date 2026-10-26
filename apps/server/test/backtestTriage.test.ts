// The Stage 1 backtest (spec D1, "Backtesting Stage 1"): scores the rules against rows a human
// labelled, and decides whether the rules may ship.
//
// The gate is asymmetric on purpose, because the two errors are not comparable. A row labelled
// `job` that the rules DROP is mail the user never sees again, and the gate forbids it outright.
// A row labelled `not-job` that the rules PASS is a message that reaches Stage 2, which is what
// Stage 2 is for, so the gate only reports those.
//
// The fixture here is synthetic (decision D-6): the real sheet holds real senders and subject
// lines and never enters the repository, so what is committed is a set of cases chosen to
// exercise each rule, and the real sheet is a local run whose matrix is reported separately.
import { describe, expect, it } from 'vitest';
import { backtest, formatMatrix, type BacktestRow } from '../src/lib/backtestTriage';

const row = (over: Partial<BacktestRow>): BacktestRow => ({
  id: 'c1',
  from: 'riley@acme.example',
  subject: 'A subject',
  body: '',
  label: 'job',
  threadLinked: false,
  ...over,
});

describe('backtest', () => {
  it('counts a labelled job email the rules keep as a true keep', () => {
    const result = backtest([row({ subject: 'Interview on Tuesday?', label: 'job' })]);

    expect(result.keptJob).toBe(1);
    expect(result.droppedJob).toHaveLength(0);
  });

  it('records a labelled job email the rules drop, with the rule that dropped it', () => {
    // The failure the gate exists to catch: no job vocabulary anywhere, so rule 7 takes it.
    const result = backtest([row({ subject: 'Following up', body: 'Any news?', label: 'job' })]);

    expect(result.droppedJob).toHaveLength(1);
    expect(result.droppedJob[0]?.rule).toBe('no_signal');
    expect(result.passes).toBe(false);
  });

  it('passes the gate only when no job-labelled row was dropped', () => {
    const clean = backtest([
      row({ subject: 'Recruiter reaching out', label: 'job' }),
      row({ id: 'c2', from: 'billing@valleymedicalgroup.example', label: 'not-job' }),
    ]);

    expect(clean.passes).toBe(true);
    expect(clean.droppedNotJob).toBe(1);
  });

  it('reports a not-job row the rules pass without failing the gate', () => {
    const result = backtest([
      row({ subject: 'Your interview with our sales team is confirmed', label: 'not-job' }),
    ]);

    expect(result.passedNotJob).toBe(1);
    expect(result.passes).toBe(true);
  });

  it('skips a row nobody labelled', () => {
    const result = backtest([row({ label: null }), row({ id: 'c2', label: 'job' })]);

    expect(result.labelled).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('credits rule 6 for a reply on a thread the user linked to an opportunity', () => {
    // Spec D1 rule 6: a bare "sounds good, Thursday works" on a linked thread must survive.
    const result = backtest([
      row({ subject: 'Re: next steps', body: 'Thursday works.', label: 'job', threadLinked: true }),
    ]);

    expect(result.keptJob).toBe(1);
    expect(result.byRule.thread).toBe(1);
  });

  it('puts the private-content veto ahead of job vocabulary', () => {
    // The state-benefits case from the spec: hiring words in a message about a benefit record.
    const result = backtest([
      row({
        subject: 'Your claim number for the hiring event',
        body: 'claim number 99-12',
        label: 'not-job',
      }),
    ]);

    expect(result.byRule.private_content).toBe(1);
    expect(result.droppedNotJob).toBe(1);
  });
});

describe('formatMatrix', () => {
  it('reports both error kinds and names the gate verdict', () => {
    const text = formatMatrix(
      backtest([
        row({ subject: 'Recruiter here', label: 'job' }),
        row({ id: 'c2', subject: 'Following up', label: 'job' }),
        row({ id: 'c3', from: 'noreply@firstnationalbank.example', label: 'not-job' }),
      ]),
    );

    expect(text).toContain('labelled job');
    expect(text).toContain('GATE FAILED');
    // The ids of dropped job mail are the actionable part, so they are in the report.
    expect(text).toContain('c2');
  });

  it('says the gate passed when nothing job-labelled was dropped', () => {
    const text = formatMatrix(backtest([row({ subject: 'Recruiter here', label: 'job' })]));

    expect(text).toContain('GATE PASSED');
  });
});

describe('the harness refuses to look like a pass when it is broken', () => {
  it('evaluates a row whose from is a full header, not just a bare address', () => {
    // The shape every mail row actually has. Handing this to the rules unparsed makes every
    // message an unreadable sender, which fails open and reports a gate pass on no evidence.
    const result = backtest([
      row({ from: 'Billing <billing@valleymedicalgroup.example>', label: 'not-job' }),
    ]);

    expect(result.byRule.unreadable_sender ?? 0).toBe(0);
    expect(result.droppedNotJob).toBe(1);
  });

  it('fails the gate when too many senders could not be read', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ id: `c${i}`, from: 'two@a.example, three@b.example', label: 'job' }),
    );
    const result = backtest(rows);

    expect(result.unreadable).toBe(10);
    expect(result.passes).toBe(false);
    expect(formatMatrix(result)).toContain('could not be read');
  });
});
