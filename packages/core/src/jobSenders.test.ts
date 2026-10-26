// Rule 4's built-in pass list (spec D1, decision D-3). The scope of each entry is the point:
// LinkedIn is address-level so that two of its senders stay out, while a platform whose every
// address is hiring workflow is domain-level.
import { describe, expect, it } from 'vitest';
import { isJobSenderPattern, JOB_SENDER_SEEDS, matchesJobSenderSeed } from './jobSenders';

describe('JOB_SENDER_SEEDS', () => {
  it('is a list of patterns the matcher can read', () => {
    for (const seed of JOB_SENDER_SEEDS) {
      expect(isJobSenderPattern(seed.pattern), seed.pattern).toBe(true);
      expect(seed.platform.length).toBeGreaterThan(0);
    }
  });
});

describe('matchesJobSenderSeed', () => {
  it('passes the LinkedIn senders that carry recruiter mail', () => {
    expect(matchesJobSenderSeed('inmail-hit-reply@linkedin.com')).toBe(true);
    expect(matchesJobSenderSeed('hit-reply@linkedin.com')).toBe(true);
    expect(matchesJobSenderSeed('messaging-digest-noreply@linkedin.com')).toBe(true);
  });

  it('leaves the rest of LinkedIn out, which is why those entries are address-level', () => {
    // The two the spec names: security mail and the generic marketing sender.
    expect(matchesJobSenderSeed('security-noreply@linkedin.com')).toBe(false);
    expect(matchesJobSenderSeed('linkedin@em.linkedin.com')).toBe(false);
  });

  it('passes every address at a platform whose whole purpose is hiring workflow', () => {
    expect(matchesJobSenderSeed('no-reply@interviews.modernloop.io')).toBe(true);
    expect(matchesJobSenderSeed('anything@candidate.fyi')).toBe(true);
  });

  it('passes the ATS mail domain and its regional subdomains, not the vendor website', () => {
    expect(matchesJobSenderSeed('no-reply@greenhouse-mail.io')).toBe(true);
    expect(matchesJobSenderSeed('no-reply@us.greenhouse-mail.io')).toBe(true);
    // greenhouse.io sells recruiting software; its mail is vendor marketing.
    expect(matchesJobSenderSeed('hello@greenhouse.io')).toBe(false);
  });

  it('passes only the Wellfound subdomain the digests come from', () => {
    expect(matchesJobSenderSeed('team@hi.wellfound.com')).toBe(true);
    expect(matchesJobSenderSeed('product@wellfound.com')).toBe(false);
  });

  it('ignores case and surrounding whitespace, and is false for nonsense', () => {
    expect(matchesJobSenderSeed('  Hit-Reply@LinkedIn.com ')).toBe(true);
    expect(matchesJobSenderSeed('not-an-address')).toBe(false);
    expect(matchesJobSenderSeed('')).toBe(false);
  });

  it('can be told to ignore seeds the user switched off', () => {
    const off = new Set(['hit-reply@linkedin.com']);
    expect(matchesJobSenderSeed('hit-reply@linkedin.com', off)).toBe(false);
    expect(matchesJobSenderSeed('inmail-hit-reply@linkedin.com', off)).toBe(true);
  });
});
