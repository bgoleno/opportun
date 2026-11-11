// The details #435 adds (slice 1 of https://github.com/bgoleno/opportun/issues/402; tl's design
// note issuecomment-6794050298): "How did you hear" fills a text question under one of five
// labels, compared whole; Location (city) fills a text field; a dropdown is reported once, as
// "choose it on the form". The filler itself is unchanged: these go through the plan the popup
// builds. Every value and label here is a placeholder.
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
  const page = loadForm(html);
  const plan = JSON.parse(
    JSON.stringify(buildPlan(attempt(fields), { board: BOARD, jobId: JOB_ID }, null)),
  ) as ReturnType<typeof buildPlan>;
  const report = await fillGreenhouseForm(plan, page.doc);
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

// tl's ruling on #437: country, school and degree are not planned in slice 1. A list is reported
// whatever the plan holds, and a planned detail would add a "no question" line to every form.
describe('Country, School and Degree are not planned yet (#435)', () => {
  it('the plan carries the city and how you heard, and none of the three', () => {
    const plan = buildPlan(attempt(DETAILS), { board: BOARD, jobId: JOB_ID }, null);
    const names = plan.questions.map((q) => q.name);
    expect(names).toEqual(['Location (city)', 'How did you hear about this role?']);
    // Whole values, as the city itself ends in "United States".
    const values = plan.questions.map((q) => q.value);
    for (const key of ['country', 'school', 'degree'] as const) {
      expect(values).not.toContain(DETAILS[key]);
    }
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

describe('a dropdown is reported once, as choose it on the form (#435)', () => {
  it('the Country list and the "How did you hear about us?" list, each once', async () => {
    const { doc, report, events } = await fill(MANY_QUESTIONS);
    for (const [id, label] of [
      ['country', 'Country'],
      ['question_9000108', 'How did you hear about us?'],
    ] as const) {
      expect(valueOf(doc, id)).toBe('');
      expect(events.filter((e) => e.target === id)).toEqual([]);
      expect(report.notFilled.filter((n) => n.label === label)).toEqual([
        { label, reason: 'choose_on_form' },
      ]);
    }
    // Never also as "no question has this label" under the detail's own name (for Country the
    // name and the form's label are one text: the one line above is all there is).
    expect(report.notFilled.filter((n) => n.label === 'How did you hear about this role?')).toEqual(
      [],
    );
  });

  it('School and Degree, where a form has them as lists, each once', async () => {
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
