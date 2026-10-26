import { describe, expect, it } from 'vitest';
import { companyMatchKey, dedupeGroupKey, dedupeKey } from './dedupe';

describe('dedupeKey', () => {
  it('ignores case, punctuation, and extra whitespace', () => {
    expect(dedupeKey('Initech', 'Principal PM, Widget Builder', 'Remote')).toBe(
      dedupeKey('INITECH ', 'principal  pm widget builder', 'remote'),
    );
  });

  it('produces the company|title|location format with seniority stripped', () => {
    expect(dedupeKey('Initech', 'Principal PM, Widget Builder', 'Remote')).toBe(
      'initech|pm widget builder|remote',
    );
  });

  it('strips diacritics and compatibility characters via NFKD', () => {
    expect(dedupeKey('Société Générale', 'Café ﬁnance lead', 'Zürich')).toBe(
      'societe generale|cafe finance|zurich',
    );
  });

  it('treats tabs and newlines as whitespace', () => {
    expect(dedupeKey('Acme\tCorp', 'Product\nManager')).toBe('acme corp|product manager|');
  });

  it('collides Staff PM with PM when the seniority token leads', () => {
    expect(dedupeKey('Acme', 'Staff PM')).toBe(dedupeKey('Acme', 'PM'));
  });

  it('collides when seniority tokens trail, and strips repeated tokens', () => {
    expect(dedupeKey('Acme', 'PM Lead')).toBe(dedupeKey('Acme', 'PM'));
    expect(dedupeKey('Acme', 'Sr. Staff Engineer')).toBe(dedupeKey('Acme', 'Engineer'));
    expect(dedupeKey('Acme', 'Jr Engineer')).toBe(dedupeKey('Acme', 'junior engineer'));
  });

  it('keeps seniority tokens in the middle of a title', () => {
    expect(dedupeKey('Acme', 'PM, Staff Programs')).not.toBe(dedupeKey('Acme', 'PM Programs'));
    expect(dedupeKey('Acme', 'PM, Staff Programs')).toBe('acme|pm staff programs|');
  });

  it('does not strip seniority words from company or location', () => {
    expect(dedupeKey('Lead Bank', 'Engineer', 'Principal City')).toBe(
      'lead bank|engineer|principal city',
    );
  });

  it('keeps a title made only of seniority tokens rather than emptying it', () => {
    expect(dedupeKey('Acme', 'Lead')).toBe('acme|lead|');
  });

  it('handles missing, null, and empty location the same way', () => {
    const expected = 'initech|pm|';
    expect(dedupeKey('Initech', 'PM')).toBe(expected);
    expect(dedupeKey('Initech', 'PM', null)).toBe(expected);
    expect(dedupeKey('Initech', 'PM', '')).toBe(expected);
    expect(dedupeKey('Initech', 'PM', '  ')).toBe(expected);
  });

  it('distinguishes different locations', () => {
    expect(dedupeKey('Initech', 'PM', 'Remote')).not.toBe(dedupeKey('Initech', 'PM', 'Amsterdam'));
  });
});

describe('dedupeGroupKey', () => {
  it('collides the same role in different locations (issue #209)', () => {
    const remote = dedupeKey('Initech', 'Staff Platform Engineer', 'Remote');
    const austin = dedupeKey('Initech', 'Staff Platform Engineer', 'Austin, TX');
    expect(dedupeGroupKey(remote)).toBe(dedupeGroupKey(austin));
  });

  it('still distinguishes a genuinely different role at the same company', () => {
    const engineer = dedupeKey('Initech', 'Staff Platform Engineer', 'Remote');
    const pm = dedupeKey('Initech', 'Product Manager', 'Remote');
    expect(dedupeGroupKey(engineer)).not.toBe(dedupeGroupKey(pm));
  });

  it('is the identity for a key with no location segment (two-part legacy keys included)', () => {
    expect(dedupeGroupKey('initech|pm')).toBe('initech|pm');
    expect(dedupeGroupKey(dedupeKey('Initech', 'PM'))).toBe('initech|pm');
  });
});

describe('dedupeKey with non-Latin input', () => {
  const company = '株式会社サンプル';
  const title = 'プロダクトマネージャー';

  it('falls back to # plus 12 hex chars of sha256 when a segment collapses to empty', () => {
    const key = dedupeKey(company, title);
    expect(key).toMatch(/^#[0-9a-f]{12}\|#[0-9a-f]{12}\|$/);
    // sha256('株式会社サンプル'.normalize('NFKD')) and the same for the title.
    expect(key).toBe(`#${SAMPLE_COMPANY_HASH}|#${SAMPLE_TITLE_HASH}|`);
  });

  it('is stable across calls and NFC/NFKD forms of the same text', () => {
    expect(dedupeKey(company, title)).toBe(dedupeKey(company, title));
    expect(dedupeKey(company.normalize('NFC'), title.normalize('NFC'))).toBe(
      dedupeKey(company.normalize('NFKD'), title.normalize('NFKD')),
    );
  });

  it('no longer collides distinct non-Latin companies or titles', () => {
    expect(dedupeKey(company, title)).not.toBe(dedupeKey('サンプル商事', title));
    expect(dedupeKey(company, title)).not.toBe(dedupeKey(company, 'エンジニア'));
    expect(dedupeKey('Яндекс', 'Менеджер продукта')).not.toBe(
      dedupeKey('Сбербанк', 'Менеджер продукта'),
    );
    expect(dedupeKey(company, title)).not.toBe(dedupeKey('Яндекс', 'Менеджер продукта'));
  });

  it('keeps normalized segments when only one of them is non-Latin', () => {
    expect(dedupeKey('Acme', title, 'Remote')).toBe(`acme|#${SAMPLE_TITLE_HASH}|remote`);
    expect(dedupeKey(company, 'Staff PM')).toBe(`#${SAMPLE_COMPANY_HASH}|pm|`);
  });

  // Issue #13: location had no fallback, so every non-Latin location collapsed to the same
  // empty segment and distinct postings at the same company and title looked like one.
  it('no longer collides distinct non-Latin locations', () => {
    expect(dedupeKey('Acme', 'PM', '東京')).not.toBe(dedupeKey('Acme', 'PM', '大阪'));
    expect(dedupeKey('Acme', 'PM', 'Москва')).not.toBe(dedupeKey('Acme', 'PM', 'Санкт-Петербург'));
  });

  it('falls back on location the same way it does on company and title', () => {
    const key = dedupeKey('Acme', 'PM', '東京');
    expect(key).toMatch(/^acme\|pm\|#[0-9a-f]{12}$/);
    expect(key).toBe(`acme|pm|#${SAMPLE_LOCATION_HASH}`);
  });

  it('still leaves a genuinely unspecified location empty, not hashed', () => {
    // Nothing non-Latin about saying nothing: this must not start matching every non-Latin
    // location now that the fallback exists.
    expect(dedupeKey('Acme', 'PM', null)).toBe('acme|pm|');
    expect(dedupeKey('Acme', 'PM', '')).toBe('acme|pm|');
  });

  it('is stable for the same non-Latin location across calls and Unicode forms', () => {
    expect(dedupeKey('Acme', 'PM', '東京')).toBe(dedupeKey('Acme', 'PM', '東京'));
    expect(dedupeKey('Acme', 'PM', '東京'.normalize('NFC'))).toBe(
      dedupeKey('Acme', 'PM', '東京'.normalize('NFKD')),
    );
  });
});

describe('companyMatchKey', () => {
  // Issue #94: dedupeKey's own normalize() does not strip corporate suffixes, so this is a
  // separate function, not a change to dedupeKey's behavior (which the unique index depends on).
  it('collides a bare name with the same name plus a corporate suffix', () => {
    expect(companyMatchKey('Acme Robotics, Inc.')).toBe(companyMatchKey('Acme Robotics'));
    expect(companyMatchKey('Acme Robotics LLC')).toBe(companyMatchKey('Acme Robotics'));
    expect(companyMatchKey('Acme Robotics, Ltd')).toBe(companyMatchKey('Acme Robotics'));
    expect(companyMatchKey('Acme Robotics Corp')).toBe(companyMatchKey('Acme Robotics'));
  });

  it('is case- and punctuation-insensitive, like dedupeKey', () => {
    expect(companyMatchKey('ACME ROBOTICS, INC.')).toBe(companyMatchKey('acme robotics inc'));
  });

  it('only strips a trailing suffix, not one used as part of the actual name', () => {
    expect(companyMatchKey('Lead Inc Robotics')).toBe('lead inc robotics');
  });

  it('does not empty a company name that is only a suffix token', () => {
    expect(companyMatchKey('Inc')).toBe('inc');
    expect(companyMatchKey('Co')).toBe('co');
  });

  it('still distinguishes genuinely different companies', () => {
    expect(companyMatchKey('Acme Robotics')).not.toBe(companyMatchKey('Acme Systems'));
  });

  it('falls back the same way dedupeKey does for non-Latin input', () => {
    expect(companyMatchKey('株式会社サンプル')).toBe(`#${SAMPLE_COMPANY_HASH}`);
  });
});

// Reference digests (first 12 hex chars), computed independently with node:crypto.
const SAMPLE_COMPANY_HASH = '6400da4deae3';
const SAMPLE_TITLE_HASH = '0c06d800f155';
const SAMPLE_LOCATION_HASH = '130016b2599b';
