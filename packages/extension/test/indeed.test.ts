// Indeed capture in the extension (https://github.com/bgoleno/opportun/issues/74): the tab gate,
// the canonical URL, and the text composed from named parts of the job, exactly as the capture
// text contract (https://github.com/bgoleno/opportun/issues/73#issuecomment-6568000179) defines
// it. Every page is a synthetic fixture (fixtures/indeedPages.ts); nothing here touches Indeed.
import { describe, expect, it } from 'vitest';
import { canonicalCaptureUrl, captureSiteOf, indeedJobKey } from '../src/canonical';
import { extractIndeedJob, type ExtractResult } from '../src/extract';
import { normalizeCapture } from '../src/normalize';
import {
  COMPANY,
  JK,
  NEVER_SENT,
  NON_TEXT_CHILDREN,
  splitView,
  TITLE,
  viewjobPage,
} from './fixtures/indeedPages';
import { load } from './fixtures/pages';

const CANONICAL = `https://www.indeed.com/viewjob?jk=${JK}`;

/** The contract's text for the fixture job, one part per line, in the contract's order. */
const EXPECTED_TEXT = [
  TITLE,
  COMPANY,
  '4.0',
  'Springfield, ST',
  'Remote',
  'Job details',
  '$100 - $120 an hour',
  'Monday to Friday',
  'Full-time',
  'Full job description',
  'Example Corp builds placeholder software for example customers.',
  'What you will do',
  'Design and run example services.',
  'Review placeholder code with the team.',
  'What you bring',
  'Five years of example experience.',
].join('\n');

function ok(result: ExtractResult): { url: string; title: string; text: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.page;
}

describe('captureSiteOf: which tabs may be read at all', () => {
  it('names LinkedIn and Indeed hosts, https only', () => {
    expect(captureSiteOf('https://www.linkedin.com/jobs/view/1/')).toBe('linkedin');
    expect(captureSiteOf('https://uk.linkedin.com/in/x')).toBe('linkedin');
    expect(captureSiteOf(`https://www.indeed.com/viewjob?jk=${JK}`)).toBe('indeed');
    expect(captureSiteOf(`https://indeed.com/viewjob?jk=${JK}`)).toBe('indeed');
    expect(captureSiteOf(`https://WWW.INDEED.COM/viewjob?jk=${JK}`)).toBe('indeed');
  });

  it('leaves every other tab alone, look-alikes and Indeed country sites included', () => {
    for (const href of [
      `http://www.indeed.com/viewjob?jk=${JK}`,
      `https://notindeed.com/viewjob?jk=${JK}`,
      `https://indeed.com.example.org/viewjob?jk=${JK}`,
      `https://uk.indeed.com/viewjob?jk=${JK}`,
      `https://www.indeed.co.uk/viewjob?jk=${JK}`,
      'https://bank.example/',
      'chrome://extensions/',
      'not a url',
    ]) {
      expect(captureSiteOf(href), href).toBeNull();
    }
  });
});

describe('the Indeed job key and canonical URL', () => {
  it('reads jk on /viewjob and vjk on the /jobs split view, lowercased', () => {
    expect(indeedJobKey(`https://www.indeed.com/viewjob?jk=${JK}&from=x`)).toBe(JK);
    expect(indeedJobKey(`https://www.indeed.com/jobs?q=a&l=b&vjk=${JK}`)).toBe(JK);
    expect(indeedJobKey(`https://www.indeed.com/viewjob?jk=${JK.toUpperCase()}`)).toBe(JK);
  });

  it('has no key for anything that is not one posting, or a key of the wrong shape', () => {
    for (const href of [
      'https://www.indeed.com/jobs?q=a&l=b',
      `https://www.indeed.com/viewjob?vjk=${JK}`,
      `https://www.indeed.com/jobs?jk=${JK}`,
      'https://www.indeed.com/cmp/Example-Corp',
      'https://www.indeed.com/viewjob?jk=not-hex-at-all',
      'https://www.indeed.com/viewjob?jk=abc',
      `https://www.indeed.com/viewjob?jk=${'a'.repeat(33)}`,
      `https://notindeed.com/viewjob?jk=${JK}`,
    ]) {
      expect(indeedJobKey(href), href).toBeNull();
    }
  });

  it('rewrites both layouts to https://www.indeed.com/viewjob?jk=<jk>', () => {
    expect(canonicalCaptureUrl(splitView().url)).toBe(CANONICAL);
    expect(canonicalCaptureUrl(viewjobPage().url)).toBe(CANONICAL);
    expect(canonicalCaptureUrl(`https://indeed.com/viewjob?jk=${JK.toUpperCase()}`)).toBe(
      CANONICAL,
    );
  });

  it('leaves LinkedIn URLs exactly as before', () => {
    expect(
      canonicalCaptureUrl('https://www.linkedin.com/jobs/search/?currentJobId=3901234567&k=x'),
    ).toBe('https://www.linkedin.com/jobs/view/3901234567/');
    expect(canonicalCaptureUrl('https://www.linkedin.com/in/dana/')).toBe(
      'https://www.linkedin.com/in/dana/',
    );
  });
});

describe('extractIndeedJob', () => {
  it('composes the contract text on /viewjob (no <main>, global nav around the job)', () => {
    const page = ok(extractIndeedJob(load(viewjobPage())));
    expect(page.text).toBe(EXPECTED_TEXT);
    expect(page.url).toBe(viewjobPage().url);
  });

  it('composes the same text in the split view, with the full header hidden', () => {
    const page = ok(extractIndeedJob(load(splitView({ compactHeaderShowing: true }))));
    expect(page.text).toBe(EXPECTED_TEXT);
  });

  it('gives identical text for the two layouts of one job', () => {
    const a = ok(extractIndeedJob(load(viewjobPage()))).text;
    const b = ok(extractIndeedJob(load(splitView()))).text;
    const c = ok(extractIndeedJob(load(splitView({ compactHeaderShowing: true })))).text;
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('sends nothing from the nav, the results list, the recommended jobs or the page chrome', () => {
    for (const fixture of [viewjobPage(), splitView(), splitView({ compactHeaderShowing: true })]) {
      const page = ok(extractIndeedJob(load(fixture)));
      for (const never of NEVER_SENT) {
        expect(page.text, `${fixture.url}: ${never}`).not.toContain(never);
        expect(page.title, `${fixture.url}: ${never}`).not.toContain(never);
      }
    }
  });

  it('the title it reports is the job title, never the tab title (which names the search)', () => {
    const fixture = splitView({ compactHeaderShowing: true });
    expect(load(fixture).title).toMatch(/^Now Hiring: .* Jobs in /);
    expect(ok(extractIndeedJob(load(fixture))).title).toBe(TITLE);
    expect(ok(extractIndeedJob(load(viewjobPage()))).title).toBe(TITLE);
  });

  it('leaves out the optional job details block when the page has none', () => {
    const text = ok(extractIndeedJob(load(viewjobPage({ withSummary: false })))).text;
    expect(text).not.toContain('Job details');
    expect(text.split('\n').slice(0, 6)).toEqual([
      TITLE,
      COMPANY,
      '4.0',
      'Springfield, ST',
      'Remote',
      'Full job description',
    ]);
  });

  it('keeps a company line exactly as the link reads, and a title containing " - "', () => {
    const page = ok(
      extractIndeedJob(
        load(viewjobPage({ title: 'Security Check Analyst - Night - Level 2', company: 'Ex Co.' })),
      ),
    );
    expect(page.text.split('\n').slice(0, 2)).toEqual([
      'Security Check Analyst - Night - Level 2',
      'Ex Co.',
    ]);
  });

  it.each([
    ['no job root on the page', viewjobPage({}, false)],
    ['the split view with no job pane', splitView({}, false)],
    ['no job title', viewjobPage({ omit: ['title'] })],
    ['no company link', splitView({ omit: ['company'] })],
    ['no description heading', viewjobPage({ omit: ['heading'] })],
    ['an empty description', splitView({ omit: ['description'] })],
  ])('refuses when the layout is not recognized: %s', (_name, fixture) => {
    const result = extractIndeedJob(load(fixture));
    // A refusal carries no page text at all: nothing falls back to <main> or <body>.
    expect(result).toEqual({ ok: false, reason: 'layout_unrecognized' });
  });

  // tl review of https://github.com/bgoleno/opportun/pull/81 (optional points).
  it('refuses the split view when the highlighted card is a different job than the URL names', () => {
    expect(extractIndeedJob(load(splitView({ highlightedKey: '00000000000000a1' })))).toEqual({
      ok: false,
      reason: 'layout_unrecognized',
    });
    // The highlighted card matching the URL, or no highlighted card at all, reads as usual.
    expect(ok(extractIndeedJob(load(splitView({ highlightedKey: JK })))).text).toBe(EXPECTED_TEXT);
    expect(ok(extractIndeedJob(load(splitView({ highlightedKey: null })))).text).toBe(
      EXPECTED_TEXT,
    );
  });

  it('skips style, script, noscript and template children of the description container', () => {
    for (const fixture of [
      viewjobPage({ descriptionContainerExtras: NON_TEXT_CHILDREN }),
      splitView({ descriptionContainerExtras: NON_TEXT_CHILDREN }),
    ]) {
      const text = ok(extractIndeedJob(load(fixture))).text;
      expect(text).toBe(EXPECTED_TEXT);
      for (const never of ['desc-container-style', 'Script Placeholder', 'Noscript', 'Template']) {
        expect(text).not.toContain(never);
      }
    }
  });

  it('reads the title and company from textContent, so a hidden full header still gives them', () => {
    // happy-dom ignores visibility for innerText, so the hidden state a browser shows (the full
    // header visibility: hidden, the compact copy showing) is modelled here: innerText of the
    // full header's nodes is empty, as Chrome reports it. Reading it would lose the title.
    const doc = load(splitView({ compactHeaderShowing: true }));
    for (const selector of [
      '[data-testid="company-info-title-row"]',
      '[data-testid="vj-job-title"]',
      '[data-testid="company-info-metadata"]',
      '[data-testid="company-info-metadata"] > *',
    ]) {
      for (const el of Array.from(doc.querySelectorAll(selector))) {
        Object.defineProperty(el, 'innerText', { get: () => '' });
      }
    }
    expect(ok(extractIndeedJob(doc)).text).toBe(EXPECTED_TEXT);
  });

  it('is self-contained: it can be serialized and injected (no outer references)', () => {
    const rebuilt = new Function(
      `return (${extractIndeedJob.toString()})`,
    )() as typeof extractIndeedJob;
    expect(ok(rebuilt(load(viewjobPage()))).text).toBe(EXPECTED_TEXT);
  });
});

describe('what the popup sends for an Indeed job', () => {
  it('both layouts send the same canonical URL, job title and text', () => {
    const payloads = [viewjobPage(), splitView({ compactHeaderShowing: true })].map((f) => {
      const n = normalizeCapture(ok(extractIndeedJob(load(f))));
      if (!n.ok) throw new Error(n.error);
      return n.payload;
    });
    expect(payloads[0]).toEqual({ url: CANONICAL, title: TITLE, text: EXPECTED_TEXT });
    expect(payloads[1]).toEqual(payloads[0]);
  });
});
