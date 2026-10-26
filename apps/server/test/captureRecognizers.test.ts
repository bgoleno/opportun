// The per-site recognizer registry (design D18). Adding Wellfound should be adding a
// recognizer and its tests, not touching the capture route, the resolve path or the merge.
// This is a seam, not a behavior change: lib/linkedinCapture.test.ts is the specification for
// what the LinkedIn recognizer does, and it passes unchanged.
import { describe, expect, it } from 'vitest';
import { CAPTURE_RECOGNIZERS, recognizeCapturedPage } from '../src/lib/captureRecognizers';
import { JOB, PROFILE } from './fixtures/capture/pages';

// The same fixtures the LinkedIn recognizer's own tests use, so this file tests the routing
// and not a second, divergent idea of what a job page looks like.
const JOB_PAGE = JOB;

describe('recognizeCapturedPage', () => {
  it('refuses a host no site claims, without consulting any recognizer', () => {
    expect(
      recognizeCapturedPage({ url: 'https://example.com/jobs/1', title: 'Job', text: 'x' }),
    ).toMatchObject({ kind: 'unrecognized' });
  });

  it('refuses a lookalike host', () => {
    expect(
      recognizeCapturedPage({ ...JOB_PAGE, url: 'https://linkedin.com.evil.test/jobs/view/1/' }),
    ).toMatchObject({ kind: 'unrecognized' });
  });

  it('routes a LinkedIn job page to the LinkedIn recognizer, tagged with its site', () => {
    const page = recognizeCapturedPage(JOB_PAGE);
    expect(page).toMatchObject({ kind: 'job', siteId: 'linkedin' });
    expect((page as { company: string }).company.length).toBeGreaterThan(0);
  });

  it('routes a LinkedIn profile page to the same recognizer', () => {
    expect(recognizeCapturedPage(PROFILE)).toMatchObject({ kind: 'profile', siteId: 'linkedin' });
  });

  it('ships exactly one recognizer today, and every one names a known site', async () => {
    const { CAPTURE_SITES } = await import('../src/lib/captureSites');
    const siteIds = CAPTURE_SITES.map((s) => s.id);
    expect(CAPTURE_RECOGNIZERS.map((r) => r.siteId)).toEqual(['linkedin']);
    for (const r of CAPTURE_RECOGNIZERS) expect(siteIds).toContain(r.siteId);
  });
});
