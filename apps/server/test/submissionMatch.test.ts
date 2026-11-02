// matchConfirmation (assisted apply M2b-1, https://github.com/bgoleno/opportun/issues/126; the
// design's Part A 5.3 step 2 and section 8 test 6): does one inbound email confirm exactly one
// submitted application? Table-driven at every boundary the issue lists. Every company, address
// and job here is synthetic; the ATS sender domains are made up for the test (the real list comes
// from M0 item 4, and none ships in this change).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIRMATION_SKEW_MS,
  CONFIRMATION_WINDOW_MS,
  matchConfirmation,
  senderDomain,
  type AtsSenderDomains,
  type ConfirmationCandidate,
  type ConfirmationMessage,
} from '../src/lib/submissionMatch';

const T = 1_800_000_000_000; // when the candidate was submitted
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const CANDIDATE: ConfirmationCandidate = {
  id: 'sub-1',
  atsKind: 'ats_greenhouse',
  atsRef: 'examplecorp',
  atsExternalId: '1000001',
  companyName: 'Example Corp',
  companyDomain: 'examplecorp.example',
  roleTitle: 'Senior Platform Engineer',
  submittedAt: T,
};

/** A confirmation that carries every signal: an ATS ref, the company's domain, title and name. */
const MESSAGE: ConfirmationMessage = {
  fromAddress: 'Example Corp Careers <careers@examplecorp.example>',
  subject: 'Thank you for applying to Example Corp',
  text: 'We received your application for Senior Platform Engineer. Placeholder text.',
  sentAt: T + 10 * MIN,
  atsJobRefs: [{ kind: 'ats_greenhouse', org: 'examplecorp', externalId: '1000001' }],
};

/** Made-up ATS sender domains, one per kind. */
const SENDERS: AtsSenderDomains = {
  ats_greenhouse: ['ats-mail-one.example'],
  ats_lever: ['ats-mail-two.example'],
};

/** The message with no ATS ref, so only B and C can carry it. */
const NO_REF: ConfirmationMessage = { ...MESSAGE, atsJobRefs: [] };
/** The message with no title or company, so only A or B can carry it. */
const BARE: ConfirmationMessage = { ...MESSAGE, subject: 'Application received', text: 'Thanks.' };

const match = (
  message: ConfirmationMessage,
  candidates: readonly ConfirmationCandidate[] = [CANDIDATE],
  senders: AtsSenderDomains = SENDERS,
) => matchConfirmation(message, candidates, senders);

describe('signal A: the ATS job reference (criterion 1)', () => {
  it.each([
    ['kind and externalId', [{ kind: 'ats_greenhouse', org: null, externalId: '1000001' }], true],
    ['kind and org', [{ kind: 'ats_greenhouse', org: 'examplecorp', externalId: '999' }], true],
    [
      'kind and org, in another case',
      [{ kind: 'ats_greenhouse', org: 'ExampleCorp', externalId: '9' }],
      true,
    ],
    [
      'the right id on another ATS',
      [{ kind: 'ats_lever', org: null, externalId: '1000001' }],
      false,
    ],
    [
      'the right kind, another job and org',
      [{ kind: 'ats_greenhouse', org: 'other', externalId: '2' }],
      false,
    ],
    ['no refs', [], false],
  ])('%s: %s', (_n, atsJobRefs, matched) => {
    // A non-company, non-ATS sender and no title: only A can make the match.
    const message = { ...BARE, fromAddress: 'someone@unrelated.example', atsJobRefs };
    const result = match(message);
    expect(result.kind).toBe(matched ? 'match' : 'none');
    if (result.kind === 'match') expect(result.signals).toContain('ats_job_ref');
  });
});

describe('signal B: the sender address, never the display name (criterion 1)', () => {
  it.each([
    ['the company domain', 'careers@examplecorp.example', true],
    ['a subdomain of the company domain', 'jobs@mail.examplecorp.example', true],
    ['the domain in another case, with a display name', 'Careers <Jobs@ExampleCorp.Example>', true],
    ['an ATS sender domain for this kind', 'no-reply@ats-mail-one.example', true],
    ['a subdomain of that ATS sender domain', 'no-reply@us.ats-mail-one.example', true],
    ['an ATS sender domain for another kind', 'no-reply@ats-mail-two.example', false],
    ['a look-alike that ends with the company domain', 'x@notexamplecorp.example', false],
    [
      'a look-alike that starts with the company domain',
      'x@examplecorp.example.evil.example',
      false,
    ],
    ['a free mail address', 'someone@mail.example', false],
  ])('%s', (_n, fromAddress, matched) => {
    // No ATS ref; title and company present, so B decides.
    expect(match({ ...NO_REF, fromAddress }).kind).toBe(matched ? 'match' : 'none');
  });

  it.each([
    [
      'the company address only in the display name',
      '"careers@examplecorp.example" <noreply@evil.example>',
    ],
    [
      'a whole bracketed company address in the display name',
      '"Example Corp <careers@examplecorp.example>" <noreply@evil.example>',
    ],
    ['the company name as the display name', 'Example Corp <noreply@evil.example>'],
    [
      // qa on #128: the header does not end with the bracket, so the bracket is not the address.
      'a bracketed company address followed by a bare address',
      'Careers <careers@examplecorp.example> noreply@evil.example',
    ],
    // qa's case on #128, as https://github.com/bgoleno/opportun/issues/132 states it.
    [
      'a quoted bracketed company address, then a bare one',
      '"<careers@examplecorp.example>" x@evil.example',
    ],
  ])('a spoofed display name is not evidence: %s', (_n, fromAddress) => {
    expect(match({ ...NO_REF, fromAddress })).toEqual({
      kind: 'none',
      reason: 'no_match',
      candidateIds: [],
    });
  });

  it('the same message from the real address matches, so the spoof test is not hollow', () => {
    expect(
      match({ ...NO_REF, fromAddress: 'Example Corp <careers@examplecorp.example>' }).kind,
    ).toBe('match');
  });

  it.each([
    ['"<careers@examplecorp.example>" x@evil.example', null],
    ['Careers <careers@examplecorp.example> noreply@evil.example', null],
    ['  Careers <careers@examplecorp.example>  ', 'examplecorp.example'],
    ['"Jobs <at> Example" <careers@examplecorp.example>', 'examplecorp.example'],
    ['careers@examplecorp.example', 'examplecorp.example'],
  ])('senderDomain(%j) is %j: a bracket counts only when it ends the header', (from, domain) => {
    expect(senderDomain(from)).toBe(domain);
  });

  it('a "<" inside the display name does not hide the real address after it', () => {
    // The address is the last bracket pair, not one opened earlier in the display name.
    expect(
      match({ ...NO_REF, fromAddress: '"Jobs <at> Example" <careers@examplecorp.example>' }).kind,
    ).toBe('match');
  });

  it('a company with no known domain can be matched only through the ATS list or A', () => {
    const noDomain = { ...CANDIDATE, companyDomain: null };
    expect(match(NO_REF, [noDomain]).kind).toBe('none');
    expect(match({ ...NO_REF, fromAddress: 'x@ats-mail-one.example' }, [noDomain]).kind).toBe(
      'match',
    );
  });
});

describe('signal C: the role title and the company name in the subject or text (criterion 1)', () => {
  it.each([
    ['both in the text', 'Re: your application', 'Senior Platform Engineer at Example Corp', true],
    [
      'title in the subject, company in the text',
      'Senior Platform Engineer',
      'Example Corp says thanks',
      true,
    ],
    [
      'the title with a different seniority spelling',
      'Sr. Platform Engineer',
      'Example Corp',
      true,
    ],
    [
      'the company with a legal suffix in the email',
      'Platform Engineer',
      'Example Corp, Inc.',
      true,
    ],
    ['punctuation and case differ', 'PLATFORM-ENGINEER?', 'example corp!', false],
    ['only the title', 'Senior Platform Engineer', 'Thanks for applying.', false],
    ['only the company', 'Thanks', 'Example Corp received your application.', false],
    ['the title inside a longer word', 'Platform Engineering', 'Example Corp', false],
  ])('%s', (_n, subject, text, matched) => {
    // B holds (company domain), no A: C decides.
    expect(match({ ...NO_REF, subject, text }).kind).toBe(matched ? 'match' : 'none');
  });

  it('a subject of null reads the text alone', () => {
    const text = 'Example Corp received your application for Senior Platform Engineer.';
    expect(match({ ...NO_REF, subject: null, text }).kind).toBe('match');
    // And with only the subject carrying the company, a null subject loses it.
    expect(match({ ...NO_REF, subject: null }).kind).toBe('none');
  });
});

describe('the rule: D and (A, or B and C) (criterion 2)', () => {
  it('everything holding gives the candidate and every signal, in order', () => {
    expect(match(MESSAGE)).toEqual({
      kind: 'match',
      submissionId: 'sub-1',
      signals: ['ats_job_ref', 'sender_domain', 'role_and_company', 'time_window'],
    });
  });

  it('A and D alone are enough', () => {
    expect(match({ ...BARE, fromAddress: 'x@unrelated.example' })).toEqual({
      kind: 'match',
      submissionId: 'sub-1',
      signals: ['ats_job_ref', 'time_window'],
    });
  });

  it('B, C and D are enough without A', () => {
    expect(match(NO_REF)).toEqual({
      kind: 'match',
      submissionId: 'sub-1',
      signals: ['sender_domain', 'role_and_company', 'time_window'],
    });
  });

  it('B and D without C is not enough (an unrelated message from the company)', () => {
    expect(match({ ...NO_REF, subject: 'Newsletter', text: 'Nothing about the role.' }).kind).toBe(
      'none',
    );
  });

  it('a non-ATS sender with title and company but no domain match is not enough (C and D only)', () => {
    expect(
      match({ ...NO_REF, fromAddress: 'Recruiter <recruiter@staffing-agency.example>' }),
    ).toEqual({ kind: 'none', reason: 'no_match', candidateIds: [] });
  });

  it('A, B and C outside the window are not enough', () => {
    expect(match({ ...MESSAGE, sentAt: T + 30 * DAY }).kind).toBe('none');
  });
});

describe('signal D: the time window, at its boundaries (criteria 1 and 4)', () => {
  it.each([
    ['5 minutes before submission (the skew allowed)', T - CONFIRMATION_SKEW_MS, true],
    ['5 minutes and 1 ms before', T - CONFIRMATION_SKEW_MS - 1, false],
    ['5 minutes less 1 ms before', T - CONFIRMATION_SKEW_MS + 1, true],
    ['at the moment of submission', T, true],
    ['14 days less 1 ms after', T + CONFIRMATION_WINDOW_MS - 1, true],
    ['exactly 14 days after', T + CONFIRMATION_WINDOW_MS, true],
    ['14 days and 1 ms after', T + CONFIRMATION_WINDOW_MS + 1, false],
    ['a year before', T - 365 * DAY, false],
  ])('%s', (_n, sentAt, matched) => {
    const result = match({ ...MESSAGE, sentAt });
    expect(result.kind).toBe(matched ? 'match' : 'none');
  });

  it('the constants are the design’s: 5 minutes of skew, 14 days of window', () => {
    expect(CONFIRMATION_SKEW_MS).toBe(5 * MIN);
    expect(CONFIRMATION_WINDOW_MS).toBe(14 * DAY);
  });
});

describe('more than one candidate (criterion 3)', () => {
  const second: ConfirmationCandidate = {
    ...CANDIDATE,
    id: 'sub-2',
    atsExternalId: '1000002',
    roleTitle: 'Principal Platform Engineer',
  };

  it('two candidates at one company that both match give none, ambiguous, naming both', () => {
    // From the company's domain, naming the company and a title both attempts share once
    // seniority is stripped, with no ATS ref to tell them apart.
    expect(match(NO_REF, [CANDIDATE, second])).toEqual({
      kind: 'none',
      reason: 'ambiguous',
      candidateIds: ['sub-1', 'sub-2'],
    });
  });

  it('the ATS ref tells two attempts at one company apart', () => {
    const message: ConfirmationMessage = {
      ...BARE,
      fromAddress: 'x@unrelated.example',
      atsJobRefs: [{ kind: 'ats_greenhouse', org: null, externalId: '1000002' }],
    };
    expect(match(message, [CANDIDATE, second])).toMatchObject({
      kind: 'match',
      submissionId: 'sub-2',
    });
  });

  it('one matching candidate among others that do not is matched', () => {
    const elsewhere: ConfirmationCandidate = {
      ...CANDIDATE,
      id: 'sub-3',
      atsKind: 'ats_lever',
      atsRef: 'othercorp',
      atsExternalId: 'x1',
      companyName: 'Other Corp',
      companyDomain: 'othercorp.example',
      roleTitle: 'Example Analyst',
    };
    expect(match(MESSAGE, [elsewhere, CANDIDATE])).toMatchObject({
      kind: 'match',
      submissionId: 'sub-1',
    });
  });

  it('a candidate outside its window does not make an ambiguity', () => {
    const old = { ...second, submittedAt: T - 30 * DAY };
    expect(match(NO_REF, [CANDIDATE, old])).toMatchObject({ kind: 'match', submissionId: 'sub-1' });
  });

  it('no candidates gives none, no_candidates', () => {
    expect(match(MESSAGE, [])).toEqual({ kind: 'none', reason: 'no_candidates', candidateIds: [] });
  });
});

describe('purity (criterion 5)', () => {
  it('the same input always gives the same answer, and the input is not changed', () => {
    const message = structuredClone(MESSAGE);
    const candidates = [structuredClone(CANDIDATE)];
    const first = match(message, candidates);
    expect(match(message, candidates)).toEqual(first);
    expect(message).toEqual(MESSAGE);
    expect(candidates).toEqual([CANDIDATE]);
  });

  it('the module reads no clock and does no IO', async () => {
    const source = await readFile(join(__dirname, '..', 'src/lib/submissionMatch.ts'), 'utf8');
    const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of [
      'Date.now',
      'new Date',
      'performance.now',
      'fetch(',
      'process.',
      "from '../db",
      "from '../repos",
      "from 'node:",
      'await ',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});
