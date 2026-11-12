// Slice 2 of https://github.com/bgoleno/opportun/issues/402: the filler chooses the one option
// that equals the reviewed value in a Greenhouse list (tl's design note issuecomment-6794050298,
// rule 3; tl's addendum 6808214454 and its step 2.6, 6808394836; sec's rulings 6808114453 and
// 6808390283). Against the stand-in lists in fixtures/greenhousePages.ts. Every value here is a
// placeholder.
import { describe, expect, it } from 'vitest';
import { fillGreenhouseForm, type FillPlan, type FillReport } from '../src/greenhouseFill';
import {
  BOARD,
  EDUCATION,
  JOB_ID,
  LIST_QUESTIONS,
  LOCATION,
  STANDARD,
  form,
  loadForm,
  select,
  standInList,
  valueOf,
  type ListBehaviour,
  type LoadedForm,
} from './fixtures/greenhousePages';

const COUNTRIES = ['United States +1', 'Canada +1', 'United Kingdom +44', 'Kazakhstan +7'];

function plan(over: Partial<FillPlan> = {}): FillPlan {
  return {
    board: BOARD,
    jobId: JOB_ID,
    standard: [],
    questions: [],
    lists: [],
    resume: null,
    withheld: [],
    ...over,
  };
}

const ok = (r: FillReport) => {
  if (!r.ok) throw new Error(`not filled: ${r.reason}`);
  return r;
};

/**
 * Runs the fill to its end. The page's timers are manual: a timer still pending after 200 ms of
 * real time (the stand-ins answer within 20 ms) is fired, as its 3 seconds would end it.
 */
async function settle(page: LoadedForm, p: FillPlan): Promise<Extract<FillReport, { ok: true }>> {
  const run = fillGreenhouseForm(JSON.parse(JSON.stringify(p)) as FillPlan, page.doc);
  let done = false;
  void run.then(() => {
    done = true;
  });
  let seen: number[] = [];
  for (let i = 0; i < 300 && !done; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const stale = page.timers.ids().filter((id) => seen.includes(id));
    seen = page.timers.ids();
    if (!done && stale.length > 0) page.timers.fire(stale);
  }
  return ok(await run);
}

const page = (html = LIST_QUESTIONS) => loadForm(html, { timers: 'manual' });

/** Options whose text holds what was typed, as a list service filters them. */
const filtered =
  (all: string[]) =>
  (search: string): string[] =>
    all.filter((o) => o.toLowerCase().includes(search.toLowerCase()));

const country: ListBehaviour = {
  options: filtered(COUNTRIES),
  shows: (o) => /\+\d+$/.exec(o)![0],
  flag: (o) => o.replace(/ \+\d+$/, ''),
};

/** The events that reached one control, by type. */
const on = (p: LoadedForm, id: string) =>
  p.events.filter((e) => e.target === id).map((e) => e.type);
const mouseups = (p: LoadedForm, id: string) => on(p, id).filter((t) => t === 'mouseup').length;
const shownIn = (p: LoadedForm, id: string) =>
  p.doc
    .getElementById(id)!
    .closest('.select__value-container')!
    .querySelector('.select__single-value')?.textContent ?? null;

const LISTS: FillPlan['lists'] = [
  { id: 'country', name: 'Phone country code', value: 'Canada' },
  {
    id: 'candidate-location',
    name: 'Location (city)',
    value: 'Seattle, Washington, United States',
  },
  { id: 'school--0', name: 'School', value: 'University of Example' },
  { id: 'degree--0', name: 'Degree', value: "Bachelor's Degree" },
];
const HEARD = {
  labels: ['How did you hear about this role?'],
  name: 'How did you hear about this role?',
  value: 'LinkedIn',
};

describe('rule 3: one exact option is chosen, and listed with its text', () => {
  it('each named list and a list question: written, opened, chosen, confirmed, listed first', async () => {
    const p = page();
    const lists = {
      country: standInList(p, 'country', country),
      location: standInList(p, 'candidate-location', {
        options: filtered(['Seattle, Washington, United States', 'Seattle Heights, Example']),
        arrive: 'late',
        early: ['Searching...'],
      }),
      school: standInList(p, 'school--0', {
        options: filtered(['University of Example', 'University of Example Annex']),
        arrive: 'late',
      }),
      degree: standInList(p, 'degree--0', {
        options: filtered(["Bachelor's Degree", "Master's Degree"]),
      }),
      heard: standInList(p, 'question_9000201', { options: filtered(['LinkedIn', 'Other']) }),
    };
    const report = await settle(p, plan({ lists: LISTS, questions: [HEARD] }));
    expect(report.chosen).toEqual([
      { label: 'Phone country code', text: 'Canada +1' },
      // The form's own label, as for every field; only the phone's country code is renamed.
      { label: 'Location (City)', text: 'Seattle, Washington, United States' },
      { label: 'School', text: 'University of Example' },
      { label: 'Degree', text: "Bachelor's Degree" },
      { label: 'How did you hear about this role?', text: 'LinkedIn' },
    ]);
    expect(report.notFilled.filter((n) => n.reason !== 'attach_yourself')).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ label: 'School' })]),
    );
    // Written before it was opened: each list was first asked for the reviewed value, never
    // for an empty box (the education lists would load their first hundred unfiltered).
    expect(lists.school.asked[0]).toBe('University of Example');
    expect(lists.country.asked[0]).toBe('Canada');
    expect(lists.location.asked).not.toContain('');
    for (const l of Object.values(lists)) expect(l.isOpen()).toBe(false);
    // One write (input, change), one mouseup, then the click on the option; no second mouseup.
    for (const id of [
      'country',
      'candidate-location',
      'school--0',
      'degree--0',
      'question_9000201',
    ]) {
      expect(on(p, id)).toEqual(['input', 'change', 'mouseup']);
    }
    expect(shownIn(p, 'country')).toBe('+1');
    expect(shownIn(p, 'school--0')).toBe('University of Example');
    // Nothing left observing, no timer pending.
    expect(p.timers.pending()).toBe(0);
    expect(p.observing()).toBe(0);
  });

  it('every event is a plain bubbling Event, one MouseEvent, and the option’s own click', async () => {
    const p = page();
    standInList(p, 'degree--0', { options: filtered(["Bachelor's Degree"]) });
    await settle(p, plan({ lists: [LISTS[3]!] }));
    const mine = p.events.filter(
      (e) => e.target === 'degree--0' || e.target.startsWith('react-select-degree--0'),
    );
    expect(mine.map((e) => [e.type, e.ctor, e.bubbles])).toEqual([
      ['input', 'Event', true],
      ['change', 'Event', true],
      ['mouseup', 'MouseEvent', true],
      // The element's own click(): a PointerEvent in happy-dom, as in Chrome, made by script.
      ['click', 'PointerEvent', true],
    ]);
    expect(mine.at(-1)!.target).toBe('react-select-degree--0-option-0');
  });

  it('the hidden required input is set by the form, never by the filler', async () => {
    const p = page();
    standInList(p, 'question_9000201', { options: () => ['Other'] });
    await settle(p, plan({ questions: [HEARD] }));
    const required = p.doc.querySelector(
      '[class="question_9000201-requiredInput"]',
    ) as HTMLInputElement;
    expect(required.value).toBe('');
    expect(p.ignoredAssignments).toEqual([]);
  });
});

describe('rule 3.3: no decision before the bound', () => {
  it('a match that arrives late, after other options, is chosen', async () => {
    const p = page();
    standInList(p, 'school--0', {
      options: () => ['University of Example'],
      arrive: 'late',
      early: ['University of Elsewhere', 'Loading...'],
    });
    const report = await settle(p, plan({ lists: [LISTS[2]!] }));
    expect(report.chosen).toEqual([{ label: 'School', text: 'University of Example' }]);
  });

  it('a match that never comes is reported only when the timer ends', async () => {
    const p = page();
    standInList(p, 'school--0', {
      options: () => [],
      arrive: 'never',
      early: ['University of Elsewhere'],
    });
    const run = fillGreenhouseForm(plan({ lists: [LISTS[2]!] }), p.doc);
    let done = false;
    void run.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 80));
    // Still waiting, with the value in the box and the list open.
    expect(done).toBe(false);
    expect(valueOf(p.doc, 'school--0')).toBe('University of Example');
    expect(p.timers.pending()).toBe(1);
    p.timers.fire();
    const report = ok(await run);
    expect(report.notFilled).toContainEqual({
      label: 'School',
      reason: 'no_option',
      detail: 'University of Example',
    });
  });
});

describe('rule 3.4 and step 2.6: three ways to end without a choice', () => {
  const cases: [string, ListBehaviour, string, number][] = [
    ['no equal option', { options: () => ['University of Elsewhere'] }, 'no_option', 2],
    [
      'two equal options',
      { options: () => ['University of Example', 'University  of example'] },
      'several_options',
      2,
    ],
    [
      'a list that opens without naming itself',
      { options: () => [], setsControls: false },
      'list_not_shown',
      2,
    ],
    ['a list that never opens', { options: () => [], opens: false }, 'list_not_shown', 1],
  ];
  it.each(cases)(
    '%s: nothing chosen, the box empty, the list closed, the field reported',
    async (_, b, reason, ups) => {
      const p = page();
      const list = standInList(p, 'school--0', b);
      const report = await settle(p, plan({ lists: [LISTS[2]!] }));
      expect(report.chosen).toEqual([]);
      expect(valueOf(p.doc, 'school--0')).toBe('');
      expect(list.isOpen()).toBe(false);
      expect(p.doc.getElementById('school--0')!.getAttribute('aria-expanded')).toBe('false');
      expect(shownIn(p, 'school--0')).toBeNull();
      // One mouseup to open and, only for a list this fill opened, one to close it.
      expect(mouseups(p, 'school--0')).toBe(ups);
      // Emptied the same way it was written: input and change, before the closing mouseup.
      expect(on(p, 'school--0').slice(0, 3)).toEqual(['input', 'change', 'mouseup']);
      expect(on(p, 'school--0').slice(3, 5)).toEqual(['input', 'change']);
      expect(report.notFilled).toContainEqual({
        label: 'School',
        reason,
        detail: 'University of Example',
      });
      expect(p.timers.pending()).toBe(0);
      expect(p.observing()).toBe(0);
    },
  );

  it('a list already open when the fill starts (the user opened it) is not touched at all', async () => {
    const p = page();
    const list = standInList(p, 'school--0', { options: () => ['University of Example'] });
    p.doc
      .getElementById('school--0')!
      .dispatchEvent(new p.window.MouseEvent('mouseup', { bubbles: true }) as unknown as Event);
    expect(list.isOpen()).toBe(true);
    const before = p.events.length;
    const report = await settle(p, plan({ lists: [LISTS[2]!] }));
    expect(p.events.slice(before).filter((e) => e.target === 'school--0')).toEqual([]);
    expect(list.isOpen()).toBe(true);
    expect(report.chosen).toEqual([]);
    expect(report.notFilled).toContainEqual({ label: 'School', reason: 'choose_on_form' });
  });

  it('a control that already shows a choice is left as it was', async () => {
    const p = page();
    standInList(p, 'degree--0', { options: () => ["Master's Degree", "Bachelor's Degree"] });
    const box = p.doc.getElementById('degree--0')!;
    box.dispatchEvent(new p.window.MouseEvent('mouseup', { bubbles: true }) as unknown as Event);
    (p.doc.getElementById('react-select-degree--0-option-0') as HTMLElement).click();
    expect(shownIn(p, 'degree--0')).toBe("Master's Degree");
    const before = p.events.length;
    const report = await settle(p, plan({ lists: [LISTS[3]!] }));
    expect(p.events.slice(before).filter((e) => e.target === 'degree--0')).toEqual([]);
    expect(report.notFilled).toContainEqual({ label: 'Degree', reason: 'has_value' });
  });

  it('the form not showing the choice is reported: check this field', async () => {
    const p = page();
    standInList(p, 'degree--0', { options: () => ["Bachelor's Degree"], ignoresChoice: true });
    const report = await settle(p, plan({ lists: [LISTS[3]!] }));
    expect(report.chosen).toEqual([]);
    expect(report.notFilled).toContainEqual({
      label: 'Degree',
      reason: 'not_confirmed',
      detail: "Bachelor's Degree",
    });
  });
});

describe("rule 3.6: the phone's country code", () => {
  it('compared without the trailing code: two countries sharing +1 are told apart by name', async () => {
    const p = page();
    // Every option at once: the stand-in's filter would not match the doubled space.
    standInList(p, 'country', { ...country, options: () => COUNTRIES });
    const report = await settle(
      p,
      plan({ lists: [{ id: 'country', name: 'Phone country code', value: 'united  states' }] }),
    );
    expect(report.chosen).toEqual([{ label: 'Phone country code', text: 'United States +1' }]);
    expect(shownIn(p, 'country')).toBe('+1');
  });

  it.each(['United', 'States', 'United States +1', 'USA'])(
    'nothing looser: "%s" chooses nothing',
    async (value) => {
      const p = page();
      standInList(p, 'country', { ...country, options: () => COUNTRIES });
      const report = await settle(
        p,
        plan({ lists: [{ id: 'country', name: 'Phone country code', value }] }),
      );
      expect(report.chosen).toEqual([]);
      expect(report.notFilled).toContainEqual({
        label: 'Phone country code',
        reason: 'no_option',
        detail: value,
      });
    },
  );

  it('a flag that names another country is reported, not taken as confirmed', async () => {
    const p = page();
    standInList(p, 'country', { ...country, flag: () => 'Canada' });
    const report = await settle(
      p,
      plan({ lists: [{ id: 'country', name: 'Phone country code', value: 'United States' }] }),
    );
    expect(report.chosen).toEqual([]);
    expect(report.notFilled).toContainEqual({
      label: 'Phone country code',
      reason: 'not_confirmed',
      detail: 'United States +1',
    });
  });

  it('a control that does not show the chosen code is reported', async () => {
    const p = page();
    standInList(p, 'country', { ...country, shows: () => '+44' });
    const report = await settle(
      p,
      plan({ lists: [{ id: 'country', name: 'Phone country code', value: 'Canada' }] }),
    );
    expect(report.chosen).toEqual([]);
    expect(report.notFilled).toContainEqual(expect.objectContaining({ reason: 'not_confirmed' }));
  });

  it('without a value it is still named Phone country code, never Country', async () => {
    const report = await settle(page(), plan());
    expect(report.notFilled).toContainEqual({
      label: 'Phone country code',
      reason: 'choose_on_form',
    });
    expect(report.notFilled.map((n) => n.label)).not.toContain('Country');
  });
});

describe('rule 3.1 and 3.7: what is never touched', () => {
  const answers = (labels: string[]) =>
    labels.map((l) => ({ labels: [l], name: l, value: 'Other' }));

  it('the self-identification blocks, the multi-selects, Discipline and the months: nothing written, opened or chosen', async () => {
    const p = page();
    const ids = [
      'gender',
      '4000001',
      '4000002',
      'question_9000202',
      'discipline--0',
      'start-month--0',
    ];
    for (const id of ids) standInList(p, id, { options: () => ['Other'] });
    const report = await settle(
      p,
      plan({
        questions: answers([
          'Gender',
          'Placeholder demographic question',
          'Placeholder demographic choices',
          'Placeholder favourite colours',
          'Discipline',
          'Start date month',
        ]),
      }),
    );
    for (const id of ids) expect(on(p, id)).toEqual([]);
    expect(report.chosen).toEqual([]);
    // Listed as choices for the user, never as filled or chosen.
    for (const label of ['Gender', 'Discipline', 'Placeholder favourite colours']) {
      expect(report.notFilled).toContainEqual({ label, reason: 'choose_on_form' });
    }
  });

  it('a second education entry is never chosen in, and Add another and Locate me are never pressed', async () => {
    const html = form(
      `${STANDARD}${LOCATION}${EDUCATION.replace('</div>\n      <button', `${select('school--1', 'School')}</div>\n      <button`)}`,
    );
    const p = page(html);
    standInList(p, 'school--1', { options: () => ['University of Example'] });
    standInList(p, 'candidate-location', { options: () => ['Seattle, Washington, United States'] });
    await settle(p, plan({ lists: LISTS, questions: answers(['School']) }));
    expect(on(p, 'school--1')).toEqual([]);
    expect(on(p, 'locate-me')).toEqual([]);
    expect(on(p, 'add-education')).toEqual([]);
  });

  it('two lists with one label, or two answers for it: neither is chosen', async () => {
    const html = form(
      `${STANDARD}${select('question_1', 'Placeholder pick')}${select('question_2', 'Placeholder pick')}`,
    );
    const p = page(html);
    standInList(p, 'question_1', { options: () => ['Other'] });
    standInList(p, 'question_2', { options: () => ['Other'] });
    const report = await settle(p, plan({ questions: answers(['Placeholder pick']) }));
    expect(on(p, 'question_1')).toEqual([]);
    expect(on(p, 'question_2')).toEqual([]);
    expect(report.notFilled.filter((n) => n.label === 'Placeholder pick')).toEqual([
      { label: 'Placeholder pick', reason: 'ambiguous' },
      { label: 'Placeholder pick', reason: 'ambiguous' },
    ]);
  });

  it('a withheld list detail is reported as withheld and left alone', async () => {
    const p = page();
    standInList(p, 'country', country);
    const report = await settle(
      p,
      plan({ withheld: [{ id: 'country', labels: [], name: 'Phone country code' }] }),
    );
    expect(on(p, 'country')).toEqual([]);
    // Once, as withheld, under the control it is: never also as a list to choose on the form.
    expect(report.notFilled.filter((n) => n.label === 'Phone country code')).toEqual([
      { label: 'Phone country code', reason: 'withheld' },
    ]);
  });

  it('a list detail the form does not have is not reported (tl on #437)', async () => {
    const report = await settle(page(form(STANDARD)), plan({ lists: LISTS.slice(1) }));
    for (const name of ['School', 'Degree', 'Location (city)']) {
      expect(report.notFilled.map((n) => n.label)).not.toContain(name);
    }
  });
});

describe('the mouseup and click helpers refuse anything but the control’s own box and list', () => {
  const swap = (from: string, to: string) => form(`${STANDARD}${EDUCATION.replace(from, to)}`);
  it.each([
    [
      'a button',
      '<button id="school--0" class="select__input" role="combobox" aria-expanded="false">x</button>',
    ],
    [
      'a link',
      '<a id="school--0" class="select__input" role="combobox" aria-expanded="false" href="#">x</a>',
    ],
    [
      'an input that is not a combobox',
      '<input id="school--0" class="select__input" aria-expanded="false" value="" />',
    ],
    [
      'a box with no aria-expanded',
      '<input id="school--0" class="select__input" role="combobox" value="" />',
    ],
  ])('%s: no mouseup, nothing written, nothing chosen', async (_, markup) => {
    const html = swap(/<input id="school--0"[\s\S]*?\/>/.exec(EDUCATION)![0], markup);
    const p = page(html);
    const report = await settle(p, plan({ lists: [LISTS[2]!] }));
    expect(on(p, 'school--0')).toEqual([]);
    expect(report.chosen).toEqual([]);
    // An input the form marks as a list is still named for the user to choose.
    if (markup.startsWith('<input')) {
      expect(report.notFilled).toContainEqual({ label: 'School', reason: 'choose_on_form' });
    }
  });

  it.each(['link', 'button', 'no-role'] as const)(
    'an equal entry that is a %s, not an option, is never clicked',
    async (optionMarkup) => {
      const p = page();
      standInList(p, 'degree--0', { options: () => ["Bachelor's Degree"], optionMarkup });
      const report = await settle(p, plan({ lists: [LISTS[3]!] }));
      expect(p.events.filter((e) => e.type === 'click')).toEqual([]);
      expect(report.notFilled).toContainEqual({
        label: 'Degree',
        reason: 'no_option',
        detail: "Bachelor's Degree",
      });
    },
  );

  it('a list named by aria-controls outside the control’s own shell is never read or clicked', async () => {
    const html = LIST_QUESTIONS.replace(
      '<div class="eeoc__container">',
      '<div role="listbox" id="elsewhere"><div role="option" id="stray">Bachelor\'s Degree</div></div><div class="eeoc__container">',
    );
    const p = page(html);
    standInList(p, 'degree--0', { options: () => ["Bachelor's Degree"], controls: 'elsewhere' });
    const report = await settle(p, plan({ lists: [LISTS[3]!] }));
    expect(p.events.filter((e) => e.type === 'click')).toEqual([]);
    expect(report.notFilled).toContainEqual({
      label: 'Degree',
      reason: 'list_not_shown',
      detail: "Bachelor's Degree",
    });
  });
});
