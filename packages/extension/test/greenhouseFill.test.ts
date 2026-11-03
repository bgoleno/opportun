// The Greenhouse filler injected for assisted apply prefill (#183; tl's design on
// https://github.com/bgoleno/opportun/issues/120 and sec's six conditions on #183), against the
// synthetic forms in fixtures/greenhousePages.ts. Every value here is a placeholder.
import { describe, expect, it } from 'vitest';
import { fillGreenhouseForm, type FillPlan, type FillReport } from '../src/greenhouseFill';
import { greenhouseJobOf, samePosting } from '../src/prefill';
import {
  BOARD,
  FEW_QUESTIONS,
  JOB_ID,
  MANY_QUESTIONS,
  POSTING_URL,
  loadForm,
  valueOf,
} from './fixtures/greenhousePages';

const PDF = new TextEncoder().encode('%PDF-1.4\n% placeholder resume\n%%EOF\n');
const PDF_BASE64 = btoa(String.fromCharCode(...PDF));

function plan(over: Partial<FillPlan> = {}): FillPlan {
  return {
    board: BOARD,
    jobId: JOB_ID,
    standard: [
      { id: 'first_name', name: 'First name', value: 'Jane' },
      { id: 'last_name', name: 'Last name', value: 'Doe-Example' },
      { id: 'email', name: 'Email', value: 'jane@example.com' },
      { id: 'phone', name: 'Phone', value: '555 0100' },
    ],
    questions: [
      {
        labels: ['LinkedIn Profile', 'LinkedIn'],
        name: 'LinkedIn profile',
        value: 'https://www.linkedin.com/in/jane-doe-example',
      },
      { labels: ['Website'], name: 'Website', value: 'https://jane.example.com' },
      { labels: ['Why us?'], name: 'Why us?', value: 'Placeholder answer,\nover two lines.' },
      {
        labels: ['what is your placeholder  NOTICE period? *'],
        name: 'Notice period',
        value: 'Two weeks',
      },
      { labels: ['Website link'], name: 'Website link', value: 'never matched' },
    ],
    resume: { filename: 'Jane-Doe-Example-Resume.pdf', base64: PDF_BASE64 },
    ...over,
  };
}

/** Through JSON, as executeScript's args travel: the plan must survive it unchanged. */
const asArgs = (p: FillPlan): FillPlan => JSON.parse(JSON.stringify(p)) as FillPlan;

async function fill(html: string, p: FillPlan = plan(), opts = {}) {
  const page = loadForm(html, opts);
  const report = await fillGreenhouseForm(asArgs(p), page.doc);
  return { ...page, report };
}

const ok = (r: FillReport) => {
  if (!r.ok) throw new Error(`not filled: ${r.reason}`);
  return r;
};

describe('acceptance 1: what it fills, and only from the plan', () => {
  it('fills the standard fields by id, LinkedIn and Website by exact label, and text and textarea answers', async () => {
    const { doc, report } = await fill(MANY_QUESTIONS);
    expect(valueOf(doc, 'first_name')).toBe('Jane');
    expect(valueOf(doc, 'last_name')).toBe('Doe-Example');
    expect(valueOf(doc, 'email')).toBe('jane@example.com');
    expect(valueOf(doc, 'phone')).toBe('555 0100');
    expect(valueOf(doc, 'question_9000110')).toBe('https://www.linkedin.com/in/jane-doe-example');
    expect(valueOf(doc, 'question_9000102')).toBe('https://jane.example.com');
    expect(valueOf(doc, 'question_9000107')).toBe('Placeholder answer,\nover two lines.');
    // Case, inner spaces and a trailing * are normalised on both sides; nothing else is.
    expect(valueOf(doc, 'question_9000104')).toBe('Two weeks');
    expect(ok(report).filled).toEqual([
      'First Name',
      'Last Name',
      'Email',
      'Phone',
      'Website',
      'What is your placeholder notice period?',
      'Why us?',
      'LinkedIn Profile',
      'Resume',
    ]);
  });

  it('a near-miss label is not filled, and is reported both ways', async () => {
    const { doc, report } = await fill(MANY_QUESTIONS);
    // "Website URL" on the form is not "Website", and the plan's "Website link" matches nothing.
    expect(valueOf(doc, 'question_9000111')).toBe('');
    expect(ok(report).notFilled).toEqual(
      expect.arrayContaining([
        { label: 'Website URL', reason: 'not_in_review' },
        { label: 'Website link', reason: 'no_matching_question' },
        { label: 'Preferred First Name', reason: 'not_in_review' },
        { label: 'Anything else?', reason: 'not_in_review' },
      ]),
    );
  });

  it('react-selects, the country and the self-identification block are left alone and reported', async () => {
    const { doc, report, events } = await fill(MANY_QUESTIONS);
    const choices = [
      ['country', 'Country'],
      ['question_9000103', 'Which placeholder team would you most like to join first?'],
      ['question_9000106', 'Do you need sponsorship?'],
      ['question_9000108', 'How did you hear about us?'],
      ['gender', 'Gender'],
      ['hispanic_ethnicity', 'Are you Hispanic/Latino?'],
      ['veteran_status', 'Veteran Status'],
    ] as const;
    for (const [id, label] of choices) {
      expect(valueOf(doc, id)).toBe('');
      expect(events.filter((e) => e.target === id)).toEqual([]);
      expect(ok(report).notFilled).toContainEqual({ label, reason: 'choose_on_form' });
    }
  });

  it('never sets a hidden input: react-select required inputs and the phone widget’s search stay empty', async () => {
    const { doc, events } = await fill(MANY_QUESTIONS);
    for (const el of Array.from(doc.querySelectorAll('input[aria-hidden="true"]'))) {
      expect((el as HTMLInputElement).value).toBe('');
    }
    expect(valueOf(doc, 'iti-0__search-input')).toBe('');
    const touched = new Set(events.map((e) => e.target));
    expect(touched.has('iti-0__search-input')).toBe(false);
  });

  it('a field that already has a value is left as it was, and reported', async () => {
    const page = loadForm(FEW_QUESTIONS);
    const native = Object.getOwnPropertyDescriptor(
      page.window.HTMLInputElement.prototype,
      'value',
    )!;
    native.set!.call(page.doc.getElementById('email'), 'typed-by-me@example.com');
    const report = ok(await fillGreenhouseForm(asArgs(plan()), page.doc));
    expect(valueOf(page.doc, 'email')).toBe('typed-by-me@example.com');
    expect(report.notFilled).toContainEqual({ label: 'Email', reason: 'has_value' });
    expect(page.events.filter((e) => e.target === 'email')).toEqual([]);
  });

  it('values the attempt does not have are not invented, and the form fields are reported', async () => {
    const { doc, report } = await fill(
      FEW_QUESTIONS,
      plan({ standard: [{ id: 'email', name: 'Email', value: 'jane@example.com' }] }),
    );
    expect(valueOf(doc, 'first_name')).toBe('');
    expect(valueOf(doc, 'phone')).toBe('');
    expect(ok(report).notFilled).toEqual(
      expect.arrayContaining([
        { label: 'First Name', reason: 'not_in_review' },
        { label: 'Phone', reason: 'not_in_review' },
      ]),
    );
  });
});

describe('sec (2) on #187: nothing inside a hidden container is filled', () => {
  const WEBSITE = `<label id="question_9000102-label" for="question_9000102">Website</label>`;
  const wrappers: [string, (block: string) => string][] = [
    ['a hidden container', (b) => `<div hidden>${b}</div>`],
    ['a display:none container', (b) => `<div style="display:none">${b}</div>`],
    ['an aria-hidden container', (b) => `<div aria-hidden="true">${b}</div>`],
    ['an inert container', (b) => `<div inert>${b}</div>`],
    ['a visibility:hidden container', (b) => `<div style="visibility:hidden">${b}</div>`],
    [
      'the field itself display:none',
      (b) => b.replace('type="text"', 'type="text" style="display:none"'),
    ],
  ];

  for (const [what, wrap] of wrappers) {
    it(`a question in ${what} is left alone and reported as not shown`, async () => {
      // The Website question's whole field-wrapper block, wrapped.
      const start = MANY_QUESTIONS.lastIndexOf(
        '<div class="field-wrapper">',
        MANY_QUESTIONS.indexOf(WEBSITE),
      );
      const end = MANY_QUESTIONS.indexOf('<div class="field-wrapper">', start + 1);
      const html =
        MANY_QUESTIONS.slice(0, start) +
        wrap(MANY_QUESTIONS.slice(start, end)) +
        MANY_QUESTIONS.slice(end);
      const { doc, report, events } = await fill(html);
      expect(valueOf(doc, 'question_9000102')).toBe('');
      expect(events.filter((e) => e.target === 'question_9000102')).toEqual([]);
      const r = ok(report);
      expect(r.notFilled).toContainEqual({ label: 'Website', reason: 'not_shown' });
      // Reported once, as not shown: not also as a reviewed value with no question.
      expect(r.notFilled.filter((n) => n.label === 'Website')).toHaveLength(1);
      // Everything shown is still filled.
      expect(valueOf(doc, 'first_name')).toBe('Jane');
    });
  }

  it('a resume input in a hidden container is not attached: attach it yourself', async () => {
    const html = FEW_QUESTIONS.replace(
      '<div class="file-upload">',
      '<div class="file-upload" style="display:none">',
    );
    const { doc, report, events } = await fill(html);
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
    expect(events.filter((e) => e.target === 'resume')).toEqual([]);
    expect(ok(report).notFilled).toContainEqual({ label: 'Resume', reason: 'attach_yourself' });
  });
});

describe('acceptance 2: one write per field, input and change only', () => {
  it('uses the native setter: the controlled stand-in ignores every plain assignment', async () => {
    const { doc, ignoredAssignments } = await fill(MANY_QUESTIONS);
    expect(ignoredAssignments).toEqual([]);
    expect(valueOf(doc, 'first_name')).toBe('Jane');
  });

  it('each filled field gets exactly one plain bubbling input and one change, and no other event fires', async () => {
    const { events, report } = await fill(MANY_QUESTIONS);
    const filledIds = [
      'first_name',
      'last_name',
      'email',
      'phone',
      'question_9000102',
      'question_9000104',
      'question_9000107',
      'question_9000110',
      'resume',
    ];
    expect(ok(report).filled).toHaveLength(filledIds.length);
    for (const id of filledIds) {
      expect(events.filter((e) => e.target === id)).toEqual([
        { type: 'input', target: id, ctor: 'Event', bubbles: true },
        { type: 'change', target: id, ctor: 'Event', bubbles: true },
      ]);
    }
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['input', 'change']));
    expect(events.every((e) => filledIds.includes(e.target))).toBe(true);
  });

  it('a second run changes nothing and dispatches nothing', async () => {
    const page = loadForm(MANY_QUESTIONS);
    ok(await fillGreenhouseForm(asArgs(plan()), page.doc));
    const before = page.events.length;
    const again = ok(await fillGreenhouseForm(asArgs(plan()), page.doc));
    expect(page.events.length).toBe(before);
    expect(again.filled).toContain('First Name');
    expect(again.notFilled).toContainEqual({ label: 'Resume', reason: 'has_value' });
  });
});

describe('acceptance 3: the resume, through DataTransfer on #resume only', () => {
  it('attaches one file with the snapshot’s name, type and bytes when the form shows its name', async () => {
    const { doc, report } = await fill(FEW_QUESTIONS);
    const files = (doc.getElementById('resume') as HTMLInputElement).files!;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('Jane-Doe-Example-Resume.pdf');
    expect(files[0]!.type).toBe('application/pdf');
    expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(PDF);
    expect(ok(report).filled).toContain('Resume');
  });

  it('when the form does not show the file’s name, the file is cleared again: attach it yourself (sec on #187)', async () => {
    const { doc, report, events } = await fill(FEW_QUESTIONS, plan(), { showsFileName: false });
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
    // The set, then the clear: each with one plain input and one change.
    expect(events.filter((e) => e.target === 'resume').map((e) => e.type)).toEqual([
      'input',
      'change',
      'input',
      'change',
    ]);
    expect(ok(report).filled).not.toContain('Resume');
    expect(ok(report).notFilled).toContainEqual({ label: 'Resume', reason: 'attach_yourself' });
  });

  it('a name the form showed before the attach proves nothing: cleared, attach it yourself (sec on #187)', async () => {
    const page = loadForm(FEW_QUESTIONS);
    page.doc.querySelector('.file-upload__filename')!.textContent = 'Jane-Doe-Example-Resume.pdf';
    const report = ok(await fillGreenhouseForm(asArgs(plan()), page.doc));
    expect((page.doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
    expect(report.notFilled).toContainEqual({ label: 'Resume', reason: 'attach_yourself' });
  });

  it('with no ready copy, #resume is untouched and the report says to attach it yourself', async () => {
    const { doc, report, events } = await fill(FEW_QUESTIONS, plan({ resume: null }));
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
    expect(events.filter((e) => e.target === 'resume')).toEqual([]);
    expect(ok(report).notFilled).toContainEqual({ label: 'Resume', reason: 'attach_yourself' });
  });

  it('a file input that does not take a PDF is left alone', async () => {
    const { doc, report } = await fill(FEW_QUESTIONS.replace('.pdf,.doc,', '.doc,'));
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
    expect(ok(report).notFilled).toContainEqual({ label: 'Resume', reason: 'attach_yourself' });
  });
});

describe('acceptance 4 and sec (5): the page must still be the pinned posting', () => {
  const urls: [string, boolean][] = [
    [POSTING_URL, true],
    [`https://boards.greenhouse.io/${BOARD}/jobs/${JOB_ID}`, true],
    [`https://job-boards.greenhouse.io/ExampleCorp/jobs/${JOB_ID}/`, true],
    [`${POSTING_URL}?gh_src=placeholder#app`, true],
    [`https://job-boards.greenhouse.io/${BOARD}/jobs/1000002`, false],
    [`https://job-boards.greenhouse.io/othercorp/jobs/${JOB_ID}`, false],
    [`http://job-boards.greenhouse.io/${BOARD}/jobs/${JOB_ID}`, false],
    [`https://job-boards.greenhouse.io.example.com/${BOARD}/jobs/${JOB_ID}`, false],
    [`https://careers.example.com/${BOARD}/jobs/${JOB_ID}`, false],
    [`https://job-boards.greenhouse.io/embed/job_app?for=${BOARD}`, false],
    [`https://job-boards.greenhouse.io/${BOARD}/jobs/${JOB_ID}/confirmation`, false],
    [`https://job-boards.greenhouse.io/${BOARD}`, false],
  ];

  for (const [url, same] of urls) {
    it(`${same ? 'fills' : 'fills nothing'} at ${url}, as the popup's own check decides`, async () => {
      const { doc, report, events } = await fill(MANY_QUESTIONS, plan(), { url });
      // The popup's rule and the one inside the page agree on every address.
      const popupSays = greenhouseJobOf(url);
      expect(popupSays !== null && samePosting(popupSays, { board: BOARD, jobId: JOB_ID })).toBe(
        same,
      );
      if (same) {
        expect(report.ok).toBe(true);
      } else {
        expect(report).toEqual({ ok: false, reason: 'wrong_page' });
        expect(events).toEqual([]);
        expect(valueOf(doc, 'first_name')).toBe('');
      }
    });
  }

  it('a page without the application form fills nothing', async () => {
    const page = loadForm('<!doctype html><html><body><main>Placeholder</main></body></html>');
    expect(await fillGreenhouseForm(asArgs(plan()), page.doc)).toEqual({
      ok: false,
      reason: 'no_form',
    });
  });
});

describe('the source scan of the injected filler (acceptance 2, sec 1 to 6)', () => {
  const source = fillGreenhouseForm.toString();

  it('never submits, activates, focuses, types or simulates a pointer', () => {
    for (const banned of [
      /\.click\s*\(/,
      /\.submit\s*\(/,
      /requestSubmit/,
      /\.focus\s*\(/,
      /\.blur\s*\(/,
      /\.select\s*\(/,
      /(Keyboard|Mouse|Pointer|Drag|Focus|Input|Touch|Wheel|Composition|Clipboard|Submit)Event/,
      /setTimeout|setInterval|requestAnimationFrame|requestIdleCallback/,
      /execCommand/,
    ]) {
      expect(source).not.toMatch(banned);
    }
  });

  it('dispatches only plain Event input and change, through one helper', () => {
    expect(source.match(/dispatchEvent\s*\(/g)).toHaveLength(1);
    expect(source.match(/new\s+[\w.]*Event\s*\(/g)).toEqual(['new view.Event(']);
    // Quotes either way: the source as serialized is the transpiled function.
    const fired = [...source.matchAll(/fire\(\s*\w+\s*,\s*['"](\w+)['"]\s*\)/g)].map((m) => m[1]);
    expect(new Set(fired)).toEqual(new Set(['input', 'change']));
    // Every call of the helper is one of those (the definition aside).
    expect(source.match(/fire\(/g)!.length).toBe(fired.length);
  });

  it('writes values only through the native setter, and files only on #resume', () => {
    expect(source).not.toMatch(/\.value\s*=[^=]/);
    // Two writes, both on #resume: the attach, and the clear when the form does not show it.
    expect(source.match(/\.files\s*=[^=]/g)).toHaveLength(2);
    expect(source.match(/fileInput\.files\s*=[^=]/g)).toHaveLength(2);
    expect(source).toMatch(/fileInput\.files\s*=\s*carrier\.files/);
    expect(source).toMatch(/getElementById\(['"]resume['"]\)/);
  });

  it('has no network, no other frame, no captcha, no masking and nothing secret', () => {
    for (const banned of [
      /fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|import\(/,
      /iframe|frames|contentWindow|contentDocument|postMessage/i,
      /grecaptcha|recaptcha|sitekey|captcha/i,
      /isTrusted|webdriver|navigator|defineProperty/,
      /token|authorization|bearer|cookie|storage/i,
      /\beval\b|new Function/,
      /location\s*=|location\.(assign|replace|reload)/,
    ]) {
      expect(source).not.toMatch(banned);
    }
  });
});
