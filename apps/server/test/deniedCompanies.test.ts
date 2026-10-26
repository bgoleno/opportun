// Matching a posting against the user's denylist (issue #199): a source tied to a specific
// company settles it directly, otherwise falls back to companyMatchKey's fuzzy name match, then
// the posting URL's host against a stored domain. No subsidiary inference (see matchDeniedCompany's
// own comment): denying "Microsoft" must never catch a "GitHub" posting.
import { describe, expect, it } from 'vitest';
import { matchDeniedCompany, type DeniedCompany } from '../src/lib/deniedCompanies';

const ORACLE: DeniedCompany = { id: 'c-oracle', name: 'Oracle', domain: null };
const MICROSOFT: DeniedCompany = { id: 'c-msft', name: 'Microsoft', domain: 'microsoft.com' };
const DENIED = [ORACLE, MICROSOFT];

function posting(company: string, postingUrl: string | null = null) {
  return { company, postingUrl };
}

describe('matchDeniedCompany', () => {
  it('matches a source tied directly to a denied company, regardless of the posting text', () => {
    // The posting text says something else entirely; the source's own companyId still wins,
    // since it is a stored fact about which company this board tracks, not an inference.
    expect(matchDeniedCompany(DENIED, 'c-oracle', posting('Oracle Careers Page'))).toBe(ORACLE);
  });

  it('matches by fuzzy company name (companyMatchKey handles corporate-suffix variation)', () => {
    expect(matchDeniedCompany(DENIED, null, posting('Oracle Corporation'))).toBe(ORACLE);
    expect(matchDeniedCompany(DENIED, null, posting('oracle, inc.'))).toBe(ORACLE);
  });

  it("matches by the posting URL host against the denied company's own stored domain", () => {
    expect(
      matchDeniedCompany(
        DENIED,
        null,
        posting('A Totally Different Name', 'https://careers.microsoft.com/job/1'),
      ),
    ).toBe(MICROSOFT);
  });

  it('a subdomain of the stored domain still matches', () => {
    expect(
      matchDeniedCompany(DENIED, null, posting('Whatever', 'https://jobs.careers.microsoft.com/1')),
    ).toBe(MICROSOFT);
  });

  it('does not match a company that merely contains the domain as a substring', () => {
    expect(
      matchDeniedCompany(DENIED, null, posting('Whatever', 'https://notmicrosoft.com/jobs/1')),
    ).toBeUndefined();
  });

  it('does not infer a subsidiary: denying Microsoft does not catch a GitHub posting', () => {
    expect(matchDeniedCompany(DENIED, null, posting('GitHub'))).toBeUndefined();
    expect(
      matchDeniedCompany(DENIED, null, posting('GitHub', 'https://github.careers/jobs/1')),
    ).toBeUndefined();
  });

  it('returns undefined for an unrelated company', () => {
    expect(matchDeniedCompany(DENIED, null, posting('Initech'))).toBeUndefined();
  });

  it('returns undefined with an empty denylist', () => {
    expect(matchDeniedCompany([], null, posting('Oracle'))).toBeUndefined();
  });

  it('tolerates an unparseable posting url rather than throwing', () => {
    expect(
      matchDeniedCompany(DENIED, null, posting('Initech', 'not a url at all')),
    ).toBeUndefined();
  });
});
