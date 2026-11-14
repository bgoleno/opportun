// The details #435 adds (slice 1 of https://github.com/bgoleno/opportun/issues/402; tl's design
// note issuecomment-6794050298): "How did you hear" fills a text question under one of five
// labels, compared whole; Location (city) fills a text field; a list is reported once. These go
// through the plan the popup builds; choosing in a list is test/greenhouseChoose.test.ts.
// Every value and label here is a placeholder.
import { describe, expect, it } from 'vitest';
import { fillGreenhouseForm, type FillReport } from '../src/greenhouseFill';
import { buildPlan, type PrefillAttempt } from '../src/prefill';
import { BOARD, JOB_ID, MANY_QUESTIONS, loadForm, valueOf } from './fixtures/greenhousePages';

const HEARD_LABELS = [
  'How did you hear about this role?',
  'How did you hear about this job?',
  'How did you hear about this position?',
  'How did you hear about this opportunity?',
  'How did you hear about us?',
];

function attempt(fields: Record<string, string>): PrefillAttempt {
  return {
    id: 'sub-1',
    destinationUrl: `https://job-boards.greenhouse.io/${BOARD}/jobs/${JOB_ID}`,
    fields,
    answers: [],
    resume: { snapshotState: null, filename: null, bytes: null },
    withheld: [],
    opportunityTitle: 'Senior Platform Engineer',
    companyName: 'Example Corp',
    firstRead: false,
  };
}

const DETAILS = {
  country: 'United States',
  location: 'Seattle, Washington, United States',
  school: 'University of Example',
  degree: "Bachelor's Degree",
  heardFrom: 'LinkedIn',
};

async function fill(html: string, fields: Record<string, string> = DETAILS) {
  // The page's timers are manual: a list here never answers (these forms have no stand-in), so
  // its 3 second bound is ended by firing the timer once the fill has stopped moving.
  const page = loadForm(html, { timers: 'manual' });
  const plan = JSON.parse(
    JSON.stringify(buildPlan(attempt(fields), { board: BOARD, jobId: JOB_ID }, null)),
  ) as ReturnType<typeof buildPlan>;
  const run = fillGreenhouseForm(plan, page.doc);
  let done = false;
  void run.then(() => {
    done = true;
  });
  let seen: number[] = [];
  while (!done) {
    await new Promise((r) => setTimeout(r, 50));
    const stale = page.timers.ids().filter((id) => seen.includes(id));
    seen = page.timers.ids();
    if (stale.length > 0) page.timers.fire(stale);
  }
  const report = await run;
  if (!report.ok) throw new Error(`not filled: ${report.reason}`);
  return { ...page, report: report as Extract<FillReport, { ok: true }> };
}

/**
 * MANY_QUESTIONS with question 9000105 (a text question) under another label. The form's own
 * "How did you hear about us?" dropdown is renamed first, so it cannot share a label with the
 * text question under test.
 */
const withTextQuestion = (label: string) =>
  MANY_QUESTIONS.replace('How did you hear about us?', 'Placeholder referral list').replace(
    'Which placeholder city do you live in today?',
    label,
  );

describe('"How did you hear" fills a text question under one of five labels (#435)', () => {
  it.each(HEARD_LABELS)('under "%s"', async (label) => {
    const { doc, report } = await fill(withTextQuestion(label));
    expect(valueOf(doc, 'question_9000105')).toBe('LinkedIn');
    expect(report.filled).toContain(label);
  });

  it('labels are compared whole, as written, with case and spacing normalised', async () => {
    const { doc } = await fill(withTextQuestion('  how did you  HEAR about this ROLE? '));
    expect(valueOf(doc, 'question_9000105')).toBe('LinkedIn');
  });

  it.each([
    'How did you hear about this role',
    'How did you hear about our company?',
    'How did you first hear about this role?',
    'Who referred you to this role?',
  ])('never under a near miss: "%s"', async (label) => {
    const { doc, report } = await fill(withTextQuestion(label));
    expect(valueOf(doc, 'question_9000105')).toBe('');
    expect(report.notFilled).toContainEqual({ label, reason: 'not_in_review' });
  });
});

describe('Location (city) fills a text field (#435)', () => {
  it('a text question labelled "Location (City)" takes the city', async () => {
    const { doc, report } = await fill(withTextQuestion('Location (City)'));
    expect(valueOf(doc, 'question_9000105')).toBe('Seattle, Washington, United States');
    expect(report.filled).toContain('Location (City)');
  });

  it('nothing is invented for a draft without a city', async () => {
    const { location: _city, ...rest } = DETAILS;
    void _city;
    const { doc } = await fill(withTextQuestion('Location (City)'), rest);
    expect(valueOf(doc, 'question_9000105')).toBe('');
  });
});

// Slice 2 (tl's rule 3): the city, the phone's country code, School and Degree are planned as
// lists by the form's control ids; the city and how you heard stay text questions by label too.
describe('the plan: lists by control id, questions by label (#402 slice 2)', () => {
  it('the plan carries the four lists, and the city and how you heard as questions', () => {
    const plan = buildPlan(attempt(DETAILS), { board: BOARD, jobId: JOB_ID }, null);
    expect(plan.questions.map((q) => q.name)).toEqual([
      'Location (city)',
      'How did you hear about this role?',
    ]);
    expect(plan.lists).toEqual([
      { id: 'candidate-location', name: 'Location (city)', value: DETAILS.location },
      { id: 'country', name: 'Phone country code', value: DETAILS.country },
      { id: 'school--0', name: 'School', value: DETAILS.school },
      { id: 'degree--0', name: 'Degree', value: DETAILS.degree },
    ]);
    // Whole values, as the city itself ends in "United States".
    const values = plan.questions.map((q) => q.value);
    for (const value of [DETAILS.country, DETAILS.school, DETAILS.degree]) {
      expect(values).not.toContain(value);
    }
  });

  it('nothing is planned for a detail the draft does not have', () => {
    const { country: _c, school: _s, ...rest } = DETAILS;
    void _c;
    void _s;
    const plan = buildPlan(attempt(rest), { board: BOARD, jobId: JOB_ID }, null);
    expect(plan.lists.map((l) => l.id)).toEqual(['candidate-location', 'degree--0']);
  });

  it('a text question labelled School is not filled, and a form without one says nothing of it', async () => {
    const { doc, report } = await fill(withTextQuestion('School'));
    expect(valueOf(doc, 'question_9000105')).toBe('');
    expect(report.notFilled).toContainEqual({ label: 'School', reason: 'not_in_review' });
    const plain = await fill(MANY_QUESTIONS);
    for (const name of ['School', 'Degree']) {
      expect(plain.report.notFilled.map((n) => n.label)).not.toContain(name);
    }
  });
});

describe('a list is reported once (#435, and slice 2 of #402)', () => {
  it('the phone country code list and the "How did you hear about us?" list, each once, emptied again', async () => {
    // These forms have no stand-in, so no list ever appears: each is tried, then reported.
    const { doc, report } = await fill(MANY_QUESTIONS);
    for (const [id, label, detail] of [
      ['country', 'Phone country code', DETAILS.country],
      ['question_9000108', 'How did you hear about us?', DETAILS.heardFrom],
    ] as const) {
      expect(valueOf(doc, id)).toBe('');
      expect(report.notFilled.filter((n) => n.label === label)).toEqual([
        { label, reason: 'list_not_shown', detail },
      ]);
    }
    // Never also as "no question has this label" under the detail's own name.
    expect(report.notFilled.filter((n) => n.label === 'How did you hear about this role?')).toEqual(
      [],
    );
    expect(report.notFilled.map((n) => n.label)).not.toContain('Country');
  });

  it('School and Degree as list questions with other ids, each once, as choose it on the form', async () => {
    const html = MANY_QUESTIONS.replace(
      'Which placeholder team would you most like to join first?',
      'School',
    ).replace('Do you need sponsorship?', 'Degree');
    const { report } = await fill(html);
    for (const label of ['School', 'Degree']) {
      expect(report.notFilled.filter((n) => n.label === label)).toEqual([
        { label, reason: 'choose_on_form' },
      ]);
    }
  });
});
