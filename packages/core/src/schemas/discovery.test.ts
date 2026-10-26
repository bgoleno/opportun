import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_SOURCE_KINDS,
  DISPOSITIONS,
  NormalizedPostingSchema,
  RESOLUTIONS,
  SOURCE_KINDS,
} from './index';

const full = {
  company: 'Initech',
  title: 'Staff Platform Engineer',
  descriptionMd: 'Build the platform.',
  postingUrl: 'https://boards.example.com/initech/jobs/123',
  location: 'Austin, TX',
  remote: true,
  compNote: '$200k to $240k',
  externalId: '123',
  postedAt: 1_760_000_000_000,
};

describe('NormalizedPostingSchema', () => {
  it('parses a full posting and a partial lead', () => {
    expect(NormalizedPostingSchema.parse(full)).toEqual(full);
    const lead = { company: 'Initech', title: 'Engineer', postingUrl: null, descriptionMd: null };
    expect(NormalizedPostingSchema.parse(lead)).toEqual(lead);
  });

  it('requires company and title', () => {
    expect(NormalizedPostingSchema.safeParse({ ...full, company: '' }).success).toBe(false);
    expect(NormalizedPostingSchema.safeParse({ ...full, title: undefined }).success).toBe(false);
  });

  it('rejects an oversized description and other field caps', () => {
    expect(
      NormalizedPostingSchema.safeParse({ ...full, descriptionMd: 'x'.repeat(50_001) }).success,
    ).toBe(false);
    expect(
      NormalizedPostingSchema.safeParse({ ...full, descriptionMd: 'x'.repeat(50_000) }).success,
    ).toBe(true);
    expect(NormalizedPostingSchema.safeParse({ ...full, title: 'x'.repeat(301) }).success).toBe(
      false,
    );
    expect(NormalizedPostingSchema.safeParse({ ...full, compNote: 'x'.repeat(501) }).success).toBe(
      false,
    );
    expect(
      NormalizedPostingSchema.safeParse({ ...full, externalId: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('rejects a non-URL posting link and a fractional postedAt', () => {
    expect(NormalizedPostingSchema.safeParse({ ...full, postingUrl: 'not a url' }).success).toBe(
      false,
    );
    expect(NormalizedPostingSchema.safeParse({ ...full, postedAt: 1.5 }).success).toBe(false);
  });
});

describe('discovery enums', () => {
  it('lists the discovery source kinds, resolutions and dispositions', () => {
    expect(DISCOVERY_SOURCE_KINDS).toEqual([
      'ats_greenhouse',
      'ats_lever',
      'ats_ashby',
      'mcp',
      'alert_email',
      'manual',
      'extension',
      'ats_workday',
    ]);
    expect(RESOLUTIONS).toEqual(['full', 'resolved_ats', 'needs_capture', 'capture_failed']);
    expect(DISPOSITIONS).toEqual(['pending', 'accepted', 'dismissed']);
  });

  it('keeps the opportunity SOURCE_KINDS distinct from the discovery source kinds', () => {
    expect(SOURCE_KINDS).toContain('discovery');
    expect(SOURCE_KINDS).not.toContain('ats_greenhouse');
  });
});
