// The Greenhouse filler injected for assisted apply prefill (#183; tl's design on
// https://github.com/bgoleno/opportun/issues/120 and sec's six conditions on #183), against the
// synthetic forms in fixtures/greenhousePages.ts. Every value here is a placeholder.
import { describe, expect, it } from 'vitest';
import {
  clearResume,
  fillGreenhouseForm,
  resumeShown,
  type FillPlan,
  type FillReport,
} from '../src/greenhouseFill';
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
const asJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

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
    ]);
    // The resume is set, and left for the popup to confirm (tl and sec on #187).
    expect(ok(report).resume).toEqual({
      filename: 'Jane-Doe-Example-Resume.pdf',
      size: PDF.length,
      before: 0,
    });
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
    // qa on #187: a labelled field that is itself aria-hidden.
    [
      'the field itself aria-hidden',
      (b: string) => b.replace('type="text"', 'type="text" aria-hidden="true"'),
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

describe('tl on #187: ambiguity, react-selects by structure, and the edges of matching', () => {
  const SPONSOR = 'Do you need sponsorship?';
  const withSponsorAnswer = () =>
    plan({
      questions: [...plan().questions, { labels: [SPONSOR], name: SPONSOR, value: 'No' }],
    });
  /** The sponsorship react-select's own markup, rewritten by `edit`. */
  const sponsor = (edit: (block: string) => string): string => {
    const start = MANY_QUESTIONS.lastIndexOf(
      '<div class="field-wrapper">',
      MANY_QUESTIONS.indexOf('for="question_9000106"'),
    );
    const end = MANY_QUESTIONS.indexOf('<div class="field-wrapper">', start + 1);
    return (
      MANY_QUESTIONS.slice(0, start) +
      edit(MANY_QUESTIONS.slice(start, end)) +
      MANY_QUESTIONS.slice(end)
    );
  };
  const variants: [string, (b: string) => string][] = [
    ['without its role', (b) => b.replace('role="combobox" ', '')],
    [
      'with only its class and containers',
      (b) =>
        b
          .replace('role="combobox" ', '')
          .replace('aria-autocomplete="list"', '')
          .replace('aria-haspopup="true"', ''),
    ],
    [
      'with only a .select container',
      (b) =>
        b
          .replace('role="combobox" ', '')
          .replace('aria-autocomplete="list"', '')
          .replace('aria-haspopup="true"', '')
          .replace('class="select__input"', 'class="plain"')
          .replace('class="select__container"', 'class="plain-container"'),
    ],
    [
      'with only a .select__container container',
      (b) =>
        b
          .replace('role="combobox" ', '')
          .replace('aria-autocomplete="list"', '')
          .replace('aria-haspopup="true"', '')
          .replace('class="select__input"', 'class="plain"')
          .replace('<div class="select">', '<div class="plain-outer">'),
    ],
    // One marker alone, each (tl on #187): the rest renamed away.
    [
      'with only its role',
      (b) =>
        b
          .replace('aria-autocomplete="list"', '')
          .replace('aria-haspopup="true"', '')
          .replace('class="select__input"', 'class="plain"')
          .replace('<div class="select">', '<div class="plain-outer">')
          .replace('class="select__container"', 'class="plain-container"'),
    ],
    [
      'with only aria-haspopup',
      (b) =>
        b
          .replace('role="combobox" ', '')
          .replace('aria-autocomplete="list"', '')
          .replace('class="select__input"', 'class="plain"')
          .replace('<div class="select">', '<div class="plain-outer">')
          .replace('class="select__container"', 'class="plain-container"'),
    ],
    [
      'with only its select__input class',
      (b) =>
        b
          .replace('role="combobox" ', '')
          .replace('aria-autocomplete="list"', '')
          .replace('aria-haspopup="true"', '')
          .replace('<div class="select">', '<div class="plain-outer">')
          .replace('class="select__container"', 'class="plain-container"'),
    ],
    [
      'with only aria-autocomplete',
      (b) =>
        b
          .replace('role="combobox" ', '')
          .replace('aria-haspopup="true"', '')
          .replace('class="select__input"', 'class="plain"')
          .replace('<div class="select">', '<div class="plain-outer">')
          .replace('class="select__container"', 'class="plain-container"'),
    ],
  ];
  for (const [what, edit] of variants) {
    it(`a react-select ${what} is never typed into, even with a reviewed answer for it`, async () => {
      const { doc, report, events } = await fill(sponsor(edit), withSponsorAnswer());
      expect(valueOf(doc, 'question_9000106')).toBe('');
      expect(events.filter((e) => e.target === 'question_9000106')).toEqual([]);
      expect(ok(report).notFilled).toContainEqual({ label: SPONSOR, reason: 'choose_on_form' });
    });
  }

  it('two questions on the form with one label: neither is filled, both are reported', async () => {
    const html = MANY_QUESTIONS.replace('>Website URL<', '>Website<');
    const { doc, report, events } = await fill(html);
    expect(valueOf(doc, 'question_9000102')).toBe('');
    expect(valueOf(doc, 'question_9000111')).toBe('');
    expect(
      events.filter((e) => e.target.startsWith('question_90001')).map((e) => e.target),
    ).not.toContain('question_9000102');
    const r = ok(report);
    expect(r.notFilled.filter((n) => n.label === 'Website')).toEqual([
      { label: 'Website', reason: 'ambiguous' },
      { label: 'Website', reason: 'ambiguous' },
    ]);
  });

  it('two reviewed answers with one label: the question is not filled, and it is reported once', async () => {
    const p = plan({
      questions: [
        ...plan().questions,
        { labels: ['Why us?'], name: 'Why us?', value: 'A second, different answer.' },
      ],
    });
    const { doc, report } = await fill(MANY_QUESTIONS, p);
    expect(valueOf(doc, 'question_9000107')).toBe('');
    const r = ok(report);
    expect(r.notFilled.filter((n) => n.label === 'Why us?')).toEqual([
      { label: 'Why us?', reason: 'ambiguous' },
    ]);
  });

  it('a question labelled plain "LinkedIn" takes the LinkedIn address (qa on #187)', async () => {
    const html = MANY_QUESTIONS.replace('>LinkedIn Profile<', '>LinkedIn<');
    const { doc, report } = await fill(html);
    expect(valueOf(doc, 'question_9000110')).toBe('https://www.linkedin.com/in/jane-doe-example');
    expect(ok(report).filled).toContain('LinkedIn');
  });

  it('labels are compared whole: two long questions sharing their first 200 characters stay apart', async () => {
    const stem = 'Placeholder '.repeat(20);
    const html = MANY_QUESTIONS.replace('>Preferred First Name<', `>${stem} one<`).replace(
      '>What is your placeholder notice period?<',
      `>${stem} two<`,
    );
    const p = plan({
      questions: [{ labels: [`${stem} two`], name: 'Long two', value: 'Answer two' }],
    });
    const { doc } = await fill(html, p);
    expect(valueOf(doc, 'question_9000101')).toBe('');
    expect(valueOf(doc, 'question_9000104')).toBe('Answer two');
  });

  it('a label inside the form for a field outside it fills nothing', async () => {
    const html = MANY_QUESTIONS.replace(
      '</form>',
      '<label for="outside_q">Outside question</label></form><input id="outside_q" type="text" />',
    );
    const p = plan({ questions: [{ labels: ['Outside question'], name: 'Outside', value: 'x' }] });
    const { doc, report } = await fill(html, p);
    expect(valueOf(doc, 'outside_q')).toBe('');
    expect(ok(report).notFilled).toContainEqual({
      label: 'Outside',
      reason: 'no_matching_question',
    });
  });

  it('an element named application-form that is not a form fills nothing', async () => {
    const html = MANY_QUESTIONS.replace(
      '<form id="application-form"',
      '<div id="application-form"',
    ).replace('</form>', '</div>');
    const page = loadForm(html);
    expect(await fillGreenhouseForm(asArgs(plan()), page.doc)).toEqual({
      ok: false,
      reason: 'no_form',
    });
    expect(valueOf(page.doc, 'first_name')).toBe('');
  });

  it('an empty file name is never attached: attach it yourself', async () => {
    const { doc, report, events } = await fill(
      FEW_QUESTIONS,
      plan({ resume: { filename: '', base64: btoa('%PDF-1.4') } }),
    );
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
    expect(events.filter((e) => e.target === 'resume')).toEqual([]);
    expect(ok(report).notFilled).toContainEqual({ label: 'Resume', reason: 'attach_yourself' });
  });
});

describe('#192: a label shared by a text field and a choice control is ambiguous', () => {
  /** MANY_QUESTIONS with `extra` added just before the self-identification block. */
  const withExtra = (extra: string) =>
    MANY_QUESTIONS.replace(
      '<h2>Voluntary Self-Identification</h2>',
      `${extra}<h2>Voluntary Self-Identification</h2>`,
    );

  const cases: [string, string][] = [
    [
      'a native select',
      `<div class="field-wrapper"><label for="q_select">Website</label><select id="q_select"><option value="">Choose</option><option>Yes</option></select></div>`,
    ],
    [
      'a react-select',
      `<div class="field-wrapper"><div class="select"><div class="select__container"><label for="q_rs">Website</label><input id="q_rs" class="select__input" role="combobox" aria-autocomplete="list" aria-haspopup="true" aria-expanded="false" value="" /></div></div></div>`,
    ],
    [
      'a radio input labelled for it',
      `<div class="field-wrapper"><label for="q_radio">Website</label><input id="q_radio" type="radio" name="q_radio" value="yes" /></div>`,
    ],
    [
      'a radio group whose legend carries the label',
      `<fieldset class="field-wrapper"><legend>Website</legend><label for="q_r1">Yes</label><input id="q_r1" type="radio" name="q_rg" value="yes" /><label for="q_r2">No</label><input id="q_r2" type="radio" name="q_rg" value="no" /></fieldset>`,
    ],
    [
      'a checkbox group whose legend carries the label',
      `<fieldset class="field-wrapper"><legend>Website *</legend><label for="q_c1">Has one</label><input id="q_c1" type="checkbox" value="yes" /></fieldset>`,
    ],
  ];

  for (const [what, extra] of cases) {
    it(`a text question and ${what} with one label: the text field is not filled, and it is reported ambiguous`, async () => {
      const { doc, report, events } = await fill(withExtra(extra));
      expect(valueOf(doc, 'question_9000102')).toBe('');
      expect(events.filter((e) => e.target === 'question_9000102')).toEqual([]);
      const r = ok(report);
      expect(r.notFilled).toContainEqual({ label: 'Website', reason: 'ambiguous' });
      expect(r.filled).not.toContain('Website');
      // The reviewed Website value is accounted for: not reported again as unmatched.
      expect(r.notFilled).not.toContainEqual({ label: 'Website', reason: 'no_matching_question' });
      // Everything else is filled as before.
      expect(valueOf(doc, 'first_name')).toBe('Jane');
      expect(valueOf(doc, 'question_9000110')).toBe('https://www.linkedin.com/in/jane-doe-example');
    });
  }

  it('a choice control with another label leaves a text question with its own label filled', async () => {
    const { doc, report } = await fill(
      withExtra(
        `<div class="field-wrapper"><label for="q_select">Website type</label><select id="q_select"><option>Personal</option></select></div>`,
      ),
    );
    expect(valueOf(doc, 'question_9000102')).toBe('https://jane.example.com');
    expect(ok(report).filled).toContain('Website');
  });

  it('a hidden radio group whose legend shares the label does not make it ambiguous (qa on #197, #198)', async () => {
    const { doc, report } = await fill(
      withExtra(
        `<fieldset class="field-wrapper" hidden><legend>Website</legend><label for="q_r1">Yes</label><input id="q_r1" type="radio" name="q_rg" value="yes" /></fieldset>`,
      ),
    );
    expect(valueOf(doc, 'question_9000102')).toBe('https://jane.example.com');
    expect(ok(report).filled).toContain('Website');
  });

  it('a hidden choice control does not make a shown text question ambiguous', async () => {
    const { doc } = await fill(
      withExtra(
        `<div class="field-wrapper" hidden><label for="q_select">Website</label><select id="q_select"><option>Yes</option></select></div>`,
      ),
    );
    expect(valueOf(doc, 'question_9000102')).toBe('https://jane.example.com');
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
    // Every field but the resume, which the popup confirms afterwards.
    expect(ok(report).filled).toHaveLength(filledIds.length - 1);
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
    expect(again.resume).toBeNull();
  });
});

describe('acceptance 3: the resume, through DataTransfer on #resume only', () => {
  it('attaches one file with the snapshot’s name, type and bytes, and leaves the judging to the popup', async () => {
    const { doc, report, events } = await fill(FEW_QUESTIONS, plan(), { showsFileName: false });
    const files = (doc.getElementById('resume') as HTMLInputElement).files!;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('Jane-Doe-Example-Resume.pdf');
    expect(files[0]!.type).toBe('application/pdf');
    expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(PDF);
    expect(events.filter((e) => e.target === 'resume').map((e) => e.type)).toEqual([
      'input',
      'change',
    ]);
    const r = ok(report);
    expect(r.resume).toEqual({
      filename: 'Jane-Doe-Example-Resume.pdf',
      size: PDF.length,
      before: 0,
    });
    expect(r.filled).not.toContain('Resume');
    expect(r.notFilled.map((n) => n.label)).not.toContain('Resume');
  });

  it('counts the name already on the form before the attach', async () => {
    const html = FEW_QUESTIONS.replace('>Country<', '>Country (Jane-Doe-Example-Resume.pdf)<');
    const { report } = await fill(html);
    expect(ok(report).resume?.before).toBe(1);
  });

  it('with no ready copy, #resume is untouched and the report says to attach it yourself', async () => {
    const { doc, report, events } = await fill(FEW_QUESTIONS, plan({ resume: null }));
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
    expect(events.filter((e) => e.target === 'resume')).toEqual([]);
    expect(ok(report).notFilled).toContainEqual({ label: 'Resume', reason: 'attach_yourself' });
    expect(ok(report).resume).toBeNull();
  });

  it('a file input that does not take a PDF is left alone', async () => {
    const { doc, report } = await fill(FEW_QUESTIONS.replace('.pdf,.doc,', '.doc,'));
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
    expect(ok(report).notFilled).toContainEqual({ label: 'Resume', reason: 'attach_yourself' });
  });

  it('any other file input, a cover letter, is reported as attach it yourself (tl on #187)', async () => {
    const html = FEW_QUESTIONS.replace(
      '<div class="file-upload">',
      '<div class="field-wrapper"><label for="cover_letter">Cover Letter</label><input id="cover_letter" type="file" class="visually-hidden" /></div><div class="file-upload">',
    );
    const { doc, report } = await fill(html);
    expect((doc.getElementById('cover_letter') as HTMLInputElement).files).toHaveLength(0);
    // Its own reason: the words for it say "this file", never "your resume" (tl on #187).
    expect(ok(report).notFilled).toContainEqual({
      label: 'Cover Letter',
      reason: 'attach_file_yourself',
    });
  });
});

describe('resumeShown: the popup’s read-only look at the form (tl and sec on #187)', () => {
  const check = { board: BOARD, jobId: JOB_ID, filename: 'Jane-Doe-Example-Resume.pdf' };

  it('counts the name on the form, and nothing changes', async () => {
    const page = loadForm(FEW_QUESTIONS);
    expect(resumeShown(asJson(check), page.doc)).toBe(0);
    page.doc.querySelector('.file-upload__filename')!.textContent = check.filename;
    expect(resumeShown(asJson(check), page.doc)).toBe(1);
    expect(page.events).toEqual([]);
  });

  it('on any other page, or without the form, it reads nothing: null', () => {
    expect(
      resumeShown(asJson(check), loadForm(FEW_QUESTIONS, { url: `${POSTING_URL}0` }).doc),
    ).toBeNull();
    expect(
      resumeShown(asJson(check), loadForm('<!doctype html><html><body></body></html>').doc),
    ).toBeNull();
  });
});

describe('clearResume: takes back only the file the filler set (tl and sec on #187)', () => {
  const check = {
    board: BOARD,
    jobId: JOB_ID,
    filename: 'Jane-Doe-Example-Resume.pdf',
    size: PDF.length,
    before: 0,
  };

  it('our one file: cleared, with one plain input and one change', async () => {
    const { doc, events } = await fill(FEW_QUESTIONS, plan(), { showsFileName: false });
    const before = events.length;
    expect(clearResume(asJson(check), doc)).toBe('cleared');
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
    expect(events.slice(before)).toEqual([
      { type: 'input', target: 'resume', ctor: 'Event', bubbles: true },
      { type: 'change', target: 'resume', ctor: 'Event', bubbles: true },
    ]);
  });

  it('a file the user attached meanwhile is kept', async () => {
    const { window, doc, events } = await fill(FEW_QUESTIONS, plan(), { showsFileName: false });
    const input = doc.getElementById('resume') as HTMLInputElement;
    const theirs = new window.DataTransfer();
    theirs.items.add(new window.File(['their own'], 'My-Own-CV.pdf', { type: 'application/pdf' }));
    input.files = theirs.files as unknown as FileList;
    const before = events.length;
    expect(clearResume(asJson(check), doc)).toBe('kept');
    expect(input.files?.[0]?.name).toBe('My-Own-CV.pdf');
    expect(events.length).toBe(before);
  });

  it('a file of our name but another size is not ours: kept', async () => {
    const { doc } = await fill(FEW_QUESTIONS, plan(), { showsFileName: false });
    expect(clearResume(asJson({ ...check, size: check.size + 1 }), doc)).toBe('kept');
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(1);
  });

  it('a file of our size but another name is not ours: kept (tl on #187)', async () => {
    const { window, doc, events } = await fill(FEW_QUESTIONS, plan(), { showsFileName: false });
    const input = doc.getElementById('resume') as HTMLInputElement;
    const same = new window.DataTransfer();
    same.items.add(new window.File([PDF], 'Another-Name.pdf', { type: 'application/pdf' }));
    input.files = same.files as unknown as FileList;
    const before = events.length;
    expect(clearResume(asJson(check), doc)).toBe('kept');
    expect(input.files?.[0]?.name).toBe('Another-Name.pdf');
    expect(events.length).toBe(before);
  });

  it('a name the form has just shown is looked for again first: shown, nothing cleared (tl on #187)', async () => {
    const { doc, events } = await fill(FEW_QUESTIONS, plan(), { showsFileName: false });
    doc.querySelector('.file-upload__filename')!.textContent = check.filename;
    const before = events.length;
    expect(clearResume(asJson(check), doc)).toBe('shown');
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(1);
    expect(events.length).toBe(before);
  });

  it('an input that is empty by then is reported as empty, and nothing is written (tl on #187)', async () => {
    const { window, doc, events } = await fill(FEW_QUESTIONS, plan(), { showsFileName: false });
    const input = doc.getElementById('resume') as HTMLInputElement;
    input.files = new window.DataTransfer().files as unknown as FileList;
    const before = events.length;
    expect(clearResume(asJson(check), doc)).toBe('empty');
    expect(events.length).toBe(before);
  });

  it('on any other page it touches nothing', async () => {
    const { window, doc, events } = await fill(FEW_QUESTIONS, plan(), { showsFileName: false });
    window.happyDOM.setURL(`https://job-boards.greenhouse.io/${BOARD}/jobs/1000002`);
    const before = events.length;
    expect(clearResume(asJson(check), doc)).toBe('wrong_page');
    expect((doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(1);
    expect(events.length).toBe(before);
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
    [`https://job-boards.greenhouse.io:8443/${BOARD}/jobs/${JOB_ID}`, false],
    [`https://job-boards.greenhouse.io:443/${BOARD}/jobs/${JOB_ID}`, true],
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
      // The resume check and the clear carry the same address rule (they cannot import it
      // either): https, the host, the default port, the board and the job id (tl on #187).
      expect(
        resumeShown(
          { board: BOARD, jobId: JOB_ID, filename: 'Jane-Doe-Example-Resume.pdf' },
          loadForm(MANY_QUESTIONS, { url }).doc,
        ) !== null,
      ).toBe(same);
      expect(
        clearResume(
          {
            board: BOARD,
            jobId: JOB_ID,
            filename: 'Jane-Doe-Example-Resume.pdf',
            size: PDF.length,
            before: 0,
          },
          loadForm(MANY_QUESTIONS, { url }).doc,
        ) !== 'wrong_page',
      ).toBe(same);
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

describe('the source scan of the injected functions (acceptance 2, sec 1 to 6)', () => {
  // Each function injected into the page is held to the same rules; the filler and the clear
  // write, the check only reads.
  const source = [fillGreenhouseForm, resumeShown, clearResume].map((f) => f.toString()).join('\n');

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

  it('dispatches only plain Event input and change, through one helper in each writer', () => {
    // One helper in the filler, one in the clear.
    expect(source.match(/dispatchEvent\s*\(/g)).toHaveLength(2);
    expect(source.match(/new\s+[\w.]*Event\s*\(/g)).toEqual(['new view.Event(', 'new view.Event(']);
    // Quotes either way: the source as serialized is the transpiled function.
    const fired = [...source.matchAll(/fire\(\s*\w+\s*,\s*['"](\w+)['"]\s*\)/g)].map((m) => m[1]);
    expect(new Set(fired)).toEqual(new Set(['input', 'change']));
    // Every call of the helper is one of those (the definition aside).
    expect(source.match(/fire\(/g)!.length).toBe(fired.length);
  });

  it('writes values only through the native setter, and files only on #resume', () => {
    expect(source).not.toMatch(/\.value\s*=[^=]/);
    // Two writes, both on #resume: the attach in the filler, and the clear.
    expect(source.match(/\.files\s*=[^=]/g)).toHaveLength(2);
    expect(source.match(/fileInput\.files\s*=[^=]/g)).toHaveLength(2);
    expect(fillGreenhouseForm.toString()).toMatch(/fileInput\.files\s*=\s*carrier\.files/);
    expect(clearResume.toString()).toMatch(
      /fileInput\.files\s*=\s*new view\.DataTransfer\(\)\.files/,
    );
    expect(source).toMatch(/getElementById\(['"]resume['"]\)/);
  });

  it('the check only reads: no event, no write, no setter', () => {
    const check = resumeShown.toString();
    expect(check).not.toMatch(
      /dispatchEvent|\.files\s*=[^=]|\.call\(|\.value\s*=[^=]|setAttribute|textContent\s*=[^=]/,
    );
  });

  it('every function injected checks the page’s address first', () => {
    for (const f of [fillGreenhouseForm, resumeShown, clearResume]) {
      // A plain string, not a pattern: this reads source text, not a URL (CodeQL on #187).
      expect(f.toString(), f.name).toContain('job-boards.greenhouse.io');
      expect(f.toString(), f.name).toMatch(/\.port\s*===\s*['"]['"]/);
    }
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
