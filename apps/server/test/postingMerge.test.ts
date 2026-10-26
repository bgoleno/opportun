// Merging the company's own ATS copy with the capture (design D4, D5, D6, D27).
//
// "The ATS copy wins any debate between LinkedIn copy or ATS copy... keep additional content
// that may be in LinkedIn that is not on company ATS" (owner decision, 2026-10-19). So the merge is
// additive under a clear precedence, not prose blending: the employer's text is stored
// verbatim and the capture's extras are appended as passages the model *selected*, never
// wrote. Every passage is checked against the captured text before it is kept, so a model
// that paraphrases or invents has its output dropped rather than stored.
import { describe, expect, it } from 'vitest';
import { mergePostingText } from '../src/lib/postingMerge';

const ATS = 'We are hiring a Staff PM for the Core Search foundation team.';
const CAPTURE = [
  'We are hiring a Staff PM for the Core Search foundation team.',
  'Remote, Full-time',
  'Seniority level: Mid-Senior level',
].join('\n');

const merge = (over: Partial<Parameters<typeof mergePostingText>[0]> = {}) =>
  mergePostingText({
    atsText: ATS,
    captureText: CAPTURE,
    passages: [],
    siteLabel: 'LinkedIn',
    company: 'Soylent',
    ...over,
  });

describe('mergePostingText', () => {
  it('drops a passage the capture does not contain, however plausible', () => {
    // Review Focus 5: the model paraphrased instead of quoting. Without this the merge would
    // store an invented requirement as the employer's own words, and resume tailoring and the
    // match score would read it as fact.
    expect(merge({ passages: ['Remote and full time.'] })).toBe(ATS);
  });

  it('drops a passage it invented outright', () => {
    expect(merge({ passages: ['Requires 10 years of Kubernetes.'] })).toBe(ATS);
  });

  it('keeps a quoted passage and labels its source', () => {
    const out = merge({ passages: ['Remote, Full-time'] });
    expect(out).toContain('## Also on the LinkedIn posting');
    expect(out).toContain('Remote, Full-time');
    expect(out.indexOf(ATS)).toBeLessThan(out.indexOf('Also on the LinkedIn'));
  });

  it('names the company in the note, so the precedence is legible', () => {
    expect(merge({ passages: ['Remote, Full-time'] })).toContain("Soylent's own posting");
  });

  it('drops a passage the ATS text already covers', () => {
    expect(
      merge({ passages: ['We are hiring a Staff PM for the Core Search foundation team.'] }),
    ).toBe(ATS);
  });

  it('drops a repeated passage', () => {
    const out = merge({ passages: ['Remote, Full-time', 'Remote, Full-time'] });
    expect(out.match(/Remote, Full-time/g)).toHaveLength(1);
  });

  it('returns the ATS text unchanged when the model returned nothing', () => {
    expect(merge({ passages: [] })).toBe(ATS);
  });

  it('returns the ATS text unchanged when there is no capture to draw on', () => {
    expect(merge({ captureText: '', passages: ['Remote, Full-time'] })).toBe(ATS);
  });

  it('truncates the extras, never the ATS text', () => {
    const ats = 'A'.repeat(49_900);
    const long = 'B'.repeat(400);
    const out = mergePostingText({
      atsText: ats,
      captureText: long,
      passages: [long],
      siteLabel: 'LinkedIn',
      company: 'Soylent',
      maxChars: 50_000,
    });
    expect(out.startsWith(ats)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(50_000);
  });

  it('keeps the ATS text whole even when it alone exceeds the cap', () => {
    const ats = 'A'.repeat(50_500);
    const out = mergePostingText({
      atsText: ats,
      captureText: 'B',
      passages: ['B'],
      siteLabel: 'LinkedIn',
      company: 'Soylent',
      maxChars: 50_000,
    });
    // sanitizePosting will truncate it downstream; this function does not add to the problem.
    expect(out).toBe(ats);
  });

  it('ignores whitespace and case when grounding a passage', () => {
    expect(merge({ passages: ['  remote,   FULL-TIME  '] })).toContain('Also on the LinkedIn');
  });
});
