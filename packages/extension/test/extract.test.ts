import {
  MIN_KEPT_CHARS,
  MIN_KEPT_FRACTION,
  TRAILING_NOISE_MARKER_PATTERNS,
} from '@opportun/core/linkedinMarkers';
import { describe, expect, it } from 'vitest';
// Contract check against the server's own shape check (pure, no IO): what this extension sends
// for each fixture must be read by the server the way the fixture intends. Test-only import.
import { recognizeLinkedInPage } from '../../../apps/server/src/lib/linkedinCapture';
import { canonicalCaptureUrl, isLinkedInUrl } from '../src/canonical';
import { extractPage, type ExtractMarkers } from '../src/extract';
import { MAX_TEXT, MAX_TITLE, normalizeCapture, type CapturePayload } from '../src/normalize';
import {
  FEED,
  JOB,
  JOB_SEARCH,
  JOB_SEARCH_RESULTS,
  JOB_WITH_EARLY_PROMOTED_BADGE,
  JOB_WITH_LEARNING_ONLY,
  JOB_WITH_RAIL,
  load,
  MOSTLY_NOISE,
  NO_MAIN,
  PROFILE,
} from './fixtures/pages';

// The real production data (@opportun/core/linkedinMarkers), not a test-local copy: this
// suite exercises extractPage's actual cutting behavior, so it needs to run against what
// popup.ts really sends, not a stand-in that could quietly drift from it.
const MARKERS: ExtractMarkers = {
  trailingNoisePatterns: TRAILING_NOISE_MARKER_PATTERNS,
  minKeptChars: MIN_KEPT_CHARS,
  minKeptFraction: MIN_KEPT_FRACTION,
};

function capture(page: Parameters<typeof load>[0]): CapturePayload {
  const result = normalizeCapture(extractPage(MARKERS, load(page)));
  if (!result.ok) throw new Error(`normalize refused: ${result.error}`);
  return result.payload;
}

describe('extractPage', () => {
  it('reads the URL, the title and the main landmark’s visible text', () => {
    const raw = extractPage(MARKERS, load(PROFILE));
    expect(raw.url).toBe(PROFILE.url);
    expect(raw.title).toBe('(3) Dana Testworth | LinkedIn');
    expect(raw.text).toContain('Dana Testworth');
    expect(raw.text).toContain('VP of Platform Engineering at Initech | TPS report modernization');
    expect(raw.text).toContain('Globex Corporation');
  });

  it('leaves out site chrome outside main, scripts and hidden elements', () => {
    const raw = extractPage(MARKERS, load(PROFILE));
    expect(raw.text).not.toContain('My Network');
    expect(raw.text).not.toContain('People also viewed');
    expect(raw.text).not.toContain('__tracking');
    expect(raw.text).not.toContain('Hidden overlay text');
  });

  it('falls back to the body when the page has no main landmark', () => {
    const raw = extractPage(MARKERS, load(NO_MAIN));
    expect(raw.text).toContain('Dana Testworth');
    expect(raw.text).toContain('VP of Platform Engineering at Initech');
  });

  it('is self-contained: it can be serialized and injected (no outer references)', () => {
    // chrome.scripting.executeScript ships func.toString() into the page; MARKERS stands in
    // for what popup.ts sends through `args` (issue #275), not an outer reference the
    // serialized body resolves on its own -- `new Function` here has no closure over this
    // test file at all, so if the real function secretly depended on anything outside its own
    // parameters, this call would throw rather than quietly pass.
    const rebuilt = new Function(`return (${extractPage.toString()})`)() as typeof extractPage;
    expect(rebuilt(MARKERS, load(JOB)).text).toContain('Staff Platform Engineer');
  });

  it('cuts off the recommended rail, learning promos, footer and language picker (#246)', () => {
    const raw = extractPage(MARKERS, load(JOB_WITH_RAIL));
    // The posting itself is intact, right up to its last real line.
    expect(raw.text).toContain('Staff Platform Engineer');
    expect(raw.text).toContain('Initech is modernizing its TPS reporting platform');
    expect(raw.text).toContain('Go and Kubernetes in production');
    // None of the trailing noise survives.
    expect(raw.text).not.toContain('Promoted');
    expect(raw.text).not.toContain('Zillow');
    expect(raw.text).not.toContain('LaunchDarkly');
    expect(raw.text).not.toContain('LinkedIn Learning');
    expect(raw.text).not.toContain('viewers');
    expect(raw.text).not.toContain('Select language');
    expect(raw.text).not.toContain('LinkedIn Corporation');
    expect(raw.text).not.toContain('Community Guidelines');
  });

  it('keeps the full page when no trailing-noise marker is present (today’s behavior)', () => {
    // JOB has no rail, no footer markers inside <main>: nothing to cut, same as before #246.
    const raw = extractPage(MARKERS, load(JOB));
    expect(raw.text).toContain('Staff Platform Engineer');
    expect(raw.text).toContain('About the company');
  });

  it('never cuts down to nothing: a marker with barely anything ahead of it is left alone (#246)', () => {
    const raw = extractPage(MARKERS, load(MOSTLY_NOISE));
    expect(raw.text).toContain('A Role');
    expect(raw.text).toContain('Promoted');
  });

  it('skips an early "Promoted" badge on the posting itself and cuts at the real rail instead (#246)', () => {
    const raw = extractPage(MARKERS, load(JOB_WITH_EARLY_PROMOTED_BADGE));
    // The posting's own early badge, and everything real that follows it, survive.
    expect(raw.text).toContain('Promoted');
    expect(raw.text).toContain('Staff Platform Engineer');
    expect(raw.text).toContain('decade-old');
    expect(raw.text).toContain('A track record of mentoring senior engineers');
    // Only the genuine rail (and everything after it) is gone.
    expect(raw.text).not.toContain('Zillow');
    expect(raw.text).not.toContain('viewers');
  });

  it('cuts at the LinkedIn Learning promo when it is the only marker on the page (#246)', () => {
    const raw = extractPage(MARKERS, load(JOB_WITH_LEARNING_ONLY));
    expect(raw.text).toContain('Staff Platform Engineer');
    expect(raw.text).toContain('Go and Kubernetes in production');
    // The marker bounds where the noise ends, not where its own card started, so one line of
    // the course card immediately above the "Show more" link can still survive; only the
    // cutoff line itself, and anything that would follow it, is guaranteed gone.
    expect(raw.text).not.toContain('Show more on LinkedIn Learning');
  });
});

describe('canonicalCaptureUrl', () => {
  it('rewrites the jobs search split view to the canonical job view URL', () => {
    expect(canonicalCaptureUrl(JOB_SEARCH.url)).toBe(
      'https://www.linkedin.com/jobs/view/3901234567/',
    );
    expect(
      canonicalCaptureUrl(
        'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=42&x=1',
      ),
    ).toBe('https://www.linkedin.com/jobs/view/42/');
  });

  it('leaves profile, job view and other pages as they are', () => {
    expect(canonicalCaptureUrl(PROFILE.url)).toBe(PROFILE.url);
    expect(canonicalCaptureUrl(JOB.url)).toBe(JOB.url);
    expect(canonicalCaptureUrl(FEED.url)).toBe(FEED.url);
  });

  it('does not rewrite a non-numeric currentJobId or a non-jobs path', () => {
    const odd = 'https://www.linkedin.com/jobs/search/?currentJobId=abc';
    expect(canonicalCaptureUrl(odd)).toBe(odd);
    const feed = 'https://www.linkedin.com/feed/?currentJobId=42';
    expect(canonicalCaptureUrl(feed)).toBe(feed);
  });

  it('drops the query and fragment of a URL longer than the server accepts', () => {
    const long = `https://www.linkedin.com/in/dana-testworth-0a1b2c/?t=${'x'.repeat(3000)}#frag`;
    expect(canonicalCaptureUrl(long)).toBe('https://www.linkedin.com/in/dana-testworth-0a1b2c/');
  });
});

describe('isLinkedInUrl', () => {
  it('accepts https LinkedIn hosts only', () => {
    expect(isLinkedInUrl('https://www.linkedin.com/feed/')).toBe(true);
    expect(isLinkedInUrl('https://uk.linkedin.com/in/x')).toBe(true);
    expect(isLinkedInUrl('https://linkedin.com/in/x')).toBe(true);
    expect(isLinkedInUrl('http://www.linkedin.com/in/x')).toBe(false);
    expect(isLinkedInUrl('https://evil-linkedin.com/in/x')).toBe(false);
    expect(isLinkedInUrl('https://www.linkedin.com.evil.example/in/x')).toBe(false);
    expect(isLinkedInUrl('chrome://extensions')).toBe(false);
    expect(isLinkedInUrl('not a url')).toBe(false);
  });
});

describe('normalizeCapture', () => {
  it('normalizes whitespace: CRLF, non-breaking spaces, trailing spaces, blank-line runs', () => {
    const r = normalizeCapture({
      url: PROFILE.url,
      title: '  Dana\u00a0Testworth | LinkedIn \n',
      text: '\n\nDana\u00a0Testworth  \r\n\r\n\r\n\r\nVP at Initech\t \n\n',
    });
    expect(r).toEqual({
      ok: true,
      payload: {
        url: PROFILE.url,
        title: 'Dana Testworth | LinkedIn',
        text: 'Dana Testworth\n\nVP at Initech',
      },
    });
  });

  it('caps the text at the server’s 200k characters and the title at 500', () => {
    const r = normalizeCapture({
      url: PROFILE.url,
      title: 't'.repeat(900),
      text: 'a'.repeat(MAX_TEXT + 5000),
    });
    if (!r.ok) throw new Error('refused');
    expect(r.payload.text).toHaveLength(MAX_TEXT);
    expect(r.payload.title).toHaveLength(MAX_TITLE);
  });

  it('never cuts a surrogate pair in half at the cap', () => {
    const r = normalizeCapture({
      url: PROFILE.url,
      title: '',
      text: `${'a'.repeat(MAX_TEXT - 1)}\u{1F600}tail`,
    });
    if (!r.ok) throw new Error('refused');
    expect(r.payload.text).toBe('a'.repeat(MAX_TEXT - 1));
  });

  it('refuses a page with no text yet (the server requires some)', () => {
    expect(normalizeCapture({ url: PROFILE.url, title: 'x', text: ' \n\t ' })).toEqual({
      ok: false,
      error: 'empty_page',
    });
  });

  it('canonicalizes the URL', () => {
    const r = normalizeCapture({ url: JOB_SEARCH.url, title: 'x', text: 'y' });
    expect(r.ok && r.payload.url).toBe('https://www.linkedin.com/jobs/view/3901234567/');
  });
});

describe('what the server reads from each captured fixture', () => {
  it('a profile page is recognized as that profile', () => {
    expect(recognizeLinkedInPage(capture(PROFILE))).toMatchObject({
      kind: 'profile',
      name: 'Dana Testworth',
      headline: 'VP of Platform Engineering at Initech | TPS report modernization',
    });
  });

  it('a job view page is recognized as that job', () => {
    expect(recognizeLinkedInPage(capture(JOB))).toMatchObject({
      kind: 'job',
      jobId: '3901234567',
      title: 'Staff Platform Engineer',
      company: 'Initech',
    });
  });

  it('the jobs search split view, rewritten, is recognized as the visible job', () => {
    expect(recognizeLinkedInPage(capture(JOB_SEARCH))).toMatchObject({
      kind: 'job',
      jobId: '3901234567',
      title: 'Staff Platform Engineer',
    });
  });

  it('the jobs search-results view, rewritten, is recognized as the visible job', () => {
    const payload = capture(JOB_SEARCH_RESULTS);
    expect(payload.url).toBe('https://www.linkedin.com/jobs/view/3901234567/');
    expect(recognizeLinkedInPage(payload)).toMatchObject({
      kind: 'job',
      jobId: '3901234567',
      title: 'Staff Platform Engineer',
    });
  });

  it('the feed is still sent, and the server refuses it', () => {
    const payload = capture(FEED);
    expect(payload.text).toContain('Start a post');
    expect(recognizeLinkedInPage(payload)).toMatchObject({ kind: 'unrecognized' });
  });

  it('a job view with a recommended rail is still recognized, with no rail content in the description (#246)', () => {
    const payload = capture(JOB_WITH_RAIL);
    const page = recognizeLinkedInPage(payload);
    expect(page).toMatchObject({
      kind: 'job',
      jobId: '3901234567',
      title: 'Staff Platform Engineer',
      company: 'Initech',
    });
    if (page.kind !== 'job') throw new Error('expected job');
    expect(page.descriptionMd).toContain('Initech is modernizing its TPS reporting platform');
    expect(page.descriptionMd).not.toContain('Zillow');
    expect(page.descriptionMd).not.toContain('viewers');
    expect(page.descriptionMd).not.toContain('Select Language');
  });
});
