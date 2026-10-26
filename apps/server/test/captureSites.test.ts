// Posting identity (design D20). The capture and the lead it completes describe one req two
// different ways, so matching them on a dedupe key built from company, title and location
// fails whenever the AI refine step did not run (no key, budget spent, provider error): the
// capture then carries no location at all. Identity is exact and needs no AI.
import type { NormalizedPosting } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { CAPTURE_SITES, postingIdentity, siteLabel } from '../src/lib/captureSites';

const posting = (over: Partial<NormalizedPosting>): NormalizedPosting => ({
  company: 'Initech',
  title: 'Staff Product Manager',
  ...over,
});

describe('postingIdentity', () => {
  it('reads the two shapes the 2026-10-18 collision actually held', () => {
    // The extension capture stored `linkedin:1000000001`; the alert-email lead for the same
    // req stored a bare `1000000001`. They are the same posting.
    const capture = posting({
      externalId: 'linkedin:1000000001',
      postingUrl: 'https://www.linkedin.com/jobs/view/1000000001',
    });
    const alert = posting({
      externalId: '1000000001',
      postingUrl: 'https://www.linkedin.com/jobs/view/1000000001/',
    });
    expect(postingIdentity(capture)).toBe('linkedin:1000000001');
    expect(postingIdentity(alert)).toBe('linkedin:1000000001');
  });

  it('reads the id from the URL when there is no externalId at all', () => {
    expect(
      postingIdentity(posting({ postingUrl: 'https://www.linkedin.com/jobs/view/1000000001/' })),
    ).toBe('linkedin:1000000001');
  });

  it('accepts the country subdomains and the bare apex that LinkedIn also serves', () => {
    for (const host of ['www.linkedin.com', 'linkedin.com', 'uk.linkedin.com', 'de.linkedin.com']) {
      expect(
        postingIdentity(posting({ postingUrl: `https://${host}/jobs/view/1000000001/` })),
      ).toBe('linkedin:1000000001');
    }
  });

  it('is null for a bare externalId with no site to attach it to', () => {
    // A Greenhouse lead's externalId means nothing without its board, and must never be
    // matched against a LinkedIn capture that happens to carry the same digits.
    expect(postingIdentity(posting({ externalId: '1000000001' }))).toBeNull();
  });

  it('does not invent a site from an unknown prefix', () => {
    expect(postingIdentity(posting({ externalId: 'wellfound:12' }))).toBeNull();
  });

  it('is case-insensitive about the host and the stored prefix', () => {
    expect(postingIdentity(posting({ externalId: 'LINKEDIN:1000000001' }))).toBe(
      'linkedin:1000000001',
    );
    expect(
      postingIdentity(posting({ postingUrl: 'https://WWW.LinkedIn.COM/jobs/view/1000000001/' })),
    ).toBe('linkedin:1000000001');
  });

  it('refuses a lookalike host', () => {
    expect(
      postingIdentity(posting({ postingUrl: 'https://linkedin.com.evil.test/jobs/view/1/' })),
    ).toBeNull();
    expect(
      postingIdentity(posting({ postingUrl: 'https://notlinkedin.com/jobs/view/1/' })),
    ).toBeNull();
  });

  it('refuses a job id that is not one', () => {
    expect(
      postingIdentity(posting({ postingUrl: 'https://www.linkedin.com/jobs/view/not-an-id/' })),
    ).toBeNull();
    expect(postingIdentity(posting({ postingUrl: 'https://www.linkedin.com/jobs/' }))).toBeNull();
  });

  it('ignores a non-https posting URL', () => {
    expect(
      postingIdentity(posting({ postingUrl: 'http://www.linkedin.com/jobs/view/1000000001/' })),
    ).toBeNull();
  });
});

describe('siteLabel', () => {
  it('names a known site the way the merge heading will read', () => {
    expect(siteLabel('linkedin')).toBe('LinkedIn');
  });

  it('falls back to the id for a site it does not know', () => {
    expect(siteLabel('wellfound')).toBe('wellfound');
  });

  it('ships exactly one site today, so adding one is additive', () => {
    expect(CAPTURE_SITES.map((s) => s.id)).toEqual(['linkedin']);
  });
});
