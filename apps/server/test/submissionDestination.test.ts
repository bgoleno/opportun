// The handoff's destination rule, by reason (https://github.com/bgoleno/opportun/issues/136,
// design 7.2). The route answers every refusal the same way (422 destination_not_allowed,
// test/submissionReview.test.ts), so each guard is pinned here by the reason it gives: a guard
// that another one already covers (LinkedIn and Indeed are never a recognised ATS board) would
// otherwise have no test that fails without it.
import { describe, expect, it } from 'vitest';
import { confirmationPageVerdict } from '../src/repos/submissionConfirm';
import { destinationAllowed, destinationRefusal } from '../src/repos/submissionReview';

const SUB = { atsKind: 'ats_greenhouse', atsExternalId: '1000001', atsRef: 'examplecorp' } as const;
const POSTING = 'https://boards.greenhouse.io/examplecorp/jobs/1000001';

describe('destinationRefusal', () => {
  it('accepts the posting on its own board, with or without tracking parameters', () => {
    expect(destinationRefusal(POSTING, SUB)).toBeNull();
    expect(destinationRefusal(`${POSTING}?utm_source=x&gh_src=y`, SUB)).toBeNull();
    expect(destinationAllowed(POSTING, SUB)).toBe(true);
  });

  it.each([
    ['not a URL', 'boards.greenhouse.io/examplecorp/jobs/1000001', 'not_a_url'],
    ['plain http', 'http://boards.greenhouse.io/examplecorp/jobs/1000001', 'not_https'],
    [
      'a user name in the URL',
      'https://jane@boards.greenhouse.io/examplecorp/jobs/1000001',
      'credentials',
    ],
    [
      'a user name and password in the URL',
      'https://jane:secret@boards.greenhouse.io/examplecorp/jobs/1000001',
      'credentials',
    ],
    ['LinkedIn', 'https://www.linkedin.com/jobs/view/1000001/?gh_jid=1000001', 'prohibited_host'],
    ['LinkedIn, upper case', 'https://WWW.LINKEDIN.COM/jobs/view/1000001', 'prohibited_host'],
    ['LinkedIn, trailing dot', 'https://www.linkedin.com./jobs/view/1000001', 'prohibited_host'],
    ['lnkd.in', 'https://lnkd.in/abc1000001', 'prohibited_host'],
    ['Indeed', 'https://www.indeed.com/viewjob?jk=1000001&gh_jid=1000001', 'prohibited_host'],
    ['Indeed UK', 'https://uk.indeed.com/viewjob?jk=1000001', 'prohibited_host'],
    [
      'a career page with gh_jid',
      'https://careers.example.com/jobs?gh_jid=1000001',
      'not_ats_board',
    ],
    [
      'a lookalike host',
      'https://boards.greenhouse.io.example.com/x/jobs/1000001',
      'not_ats_board',
    ],
    ['another ATS’s board', 'https://jobs.lever.co/examplecorp/1000001', 'other_board'],
    [
      'another company’s board',
      'https://boards.greenhouse.io/othercorp/jobs/1000001',
      'other_board',
    ],
    [
      'another requisition',
      'https://boards.greenhouse.io/examplecorp/jobs/1000002',
      'not_this_posting',
    ],
  ])('refuses %s', (_name, url, reason) => {
    expect(destinationRefusal(url, SUB)).toBe(reason);
    expect(destinationAllowed(url, SUB)).toBe(false);
  });
});

// #521 (sec's audit of main a8efb96, rated low): the job is read from the address's own path, not
// from a URL embedded in its query. An address on the attempt's board whose path names another
// job, and whose query happens to carry the attempt's job page, names that other job. The ')' is
// what the text scanner ends a URL at, and a URL keeps it as it is in a query.
describe("the job is the address's own, never one embedded in its query (#521)", () => {
  const TRAP =
    'https://boards.greenhouse.io/examplecorp/jobs/1000002?ref=)https://boards.greenhouse.io/examplecorp/jobs/1000001';
  const DESTINATION = { ...SUB, destinationUrl: POSTING };

  it('destinationRefusal: not_this_posting', () => {
    expect(destinationRefusal(TRAP, SUB)).toBe('not_this_posting');
    expect(destinationAllowed(TRAP, SUB)).toBe(false);
  });

  it('confirmationPageVerdict: different_job', () => {
    expect(confirmationPageVerdict(TRAP, DESTINATION)).toBe('different_job');
  });

  it("the attempt's own path still passes, whatever job the query embeds", () => {
    const own =
      'https://boards.greenhouse.io/examplecorp/jobs/1000001?ref=)https://boards.greenhouse.io/examplecorp/jobs/1000002';
    expect(destinationRefusal(own, SUB)).toBeNull();
    expect(confirmationPageVerdict(own, DESTINATION)).toBe('ok');
  });
});
