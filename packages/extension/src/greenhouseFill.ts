// The functions that run inside a Greenhouse application tab for assisted apply prefill (M3,
// https://github.com/bgoleno/opportun/issues/183; tl's design on #120 and sec's six conditions
// on #183): the filler, then, for the resume only, a read-only check and a clear (tl and sec on
// #187). The popup runs each in the top frame of the active tab, the filler once on the user's
// click (chrome.scripting.executeScript serializes them with toString()). Each must stay
// self-contained, as extract.ts's readers are: no imports, no module-level names, only its
// parameters, its own body and the page's globals, so each carries its own copy of the address
// check. Type-only names are erased before they are serialized.
//
// What it may do, enforced by a scan of its own source (test/greenhouseFill.test.ts):
// - set a text input's or textarea's value once, with the element prototype's native setter
//   (the form is React-controlled: a plain assignment is not seen), then dispatch a plain
//   bubbling Event 'input' and Event 'change' on that element, and nothing else: no key,
//   pointer, mouse, drag or focus events, no InputEvent, no per-character loop, no timers;
// - attach the resume through DataTransfer on #resume only, the one hidden input it touches,
//   and return how often its name was on the form before. It does not judge whether the form
//   took it: React renders the name after a macrotask, and the page side keeps no timer. The
//   popup looks with resumeShown, read-only, at fixed gaps on its own timer, and if the name
//   never appears, clearResume takes the file back out, and only if it is still exactly ours;
// - leave alone a dropdown widget however it is marked up, and a label that is ambiguous (two
//   questions, or two reviewed answers, carry it): which value goes where cannot be known;
// - leave alone anything the form does not show: a field that is, or sits in a container that
//   is, hidden, aria-hidden, inert, display:none or visibility:hidden (sec on #187);
// - never activate a control, never send the form, never touch another frame, the captcha
//   or the network, and never mask anything about how it runs.
// It fills only empty fields (a value the user typed is left alone and reported), and only from
// the plan the popup built out of the reviewed attempt. Comments inside the function are kept to
// plain words on purpose: they are part of what the scan reads.

/** What to fill, built by the popup from the reviewed attempt (prefill.ts buildPlan). */
export interface FillPlan {
  /** The posting the attempt was handed off to; the page must still be it when this runs. */
  board: string;
  jobId: string;
  /** Standard fields, by the form's own element id, with the reviewed value. */
  standard: { id: string; name: string; value: string }[];
  /** Questions matched by their label, normalised; any one of `labels` matches. */
  questions: { labels: string[]; name: string; value: string }[];
  /** The ready resume snapshot as base64 (executeScript args are JSON only), or null. */
  resume: { filename: string; base64: string } | null;
  /**
   * Fields the server withheld because their stored value fails today's checks (#196): which
   * field each is (a standard id, or question labels) and its name, never a value. Each is
   * reported once as withheld, under the form's label, or by its name if the form lacks it.
   */
  withheld: { id: string | null; labels: string[]; name: string }[];
}

export type NotFilledReason =
  /** A choice on the form (a dropdown, checkbox or radio): never filled. */
  | 'choose_on_form'
  /** A question on the form with nothing for it in the reviewed attempt. */
  | 'not_in_review'
  /** A reviewed value with no question on the form whose label matches it exactly. */
  | 'no_matching_question'
  /** The field already had something in it: left as it was. */
  | 'has_value'
  /** A field the form does not show (it, or a container of it, is hidden): left alone. */
  | 'not_shown'
  /** Two questions on the form, or two reviewed answers, share this label: neither is filled. */
  | 'ambiguous'
  /**
   * A file to attach yourself: no ready copy, no shown file input that takes a PDF, the form
   * never showed the file's name (it was taken back out), or another file input on the form.
   */
  | 'attach_yourself'
  /** Another file input on the form (a cover letter): never set; attach that file yourself. */
  | 'attach_file_yourself'
  /** The resume could not be checked (the tab moved on): look at it on the form. */
  | 'resume_unchecked'
  /** The server withheld the field: its stored value fails today's checks (#196). */
  | 'withheld';

export type FillReport =
  | {
      ok: true;
      filled: string[];
      notFilled: { label: string; reason: NotFilledReason }[];
      /**
       * The resume the filler set, for the popup to confirm: its name, its size, and how often
       * the name was on the form before the attach. Null when it set none.
       */
      resume: { filename: string; size: number; before: number } | null;
    }
  | { ok: false; reason: 'wrong_page' | 'no_form' };

/** What resumeShown and clearResume are given: the posting, and the file the filler set. */
export interface ResumeCheck {
  board: string;
  jobId: string;
  filename: string;
}

export function fillGreenhouseForm(plan: FillPlan, doc: Document = document): FillReport {
  const view = doc.defaultView;
  if (view === null) return { ok: false, reason: 'no_form' };

  // The page must still be the posting the attempt was handed off to.
  let here: URL | null;
  try {
    here = new URL(doc.location.href);
  } catch {
    here = null;
  }
  const parts = here === null ? [] : here.pathname.split('/').filter((p) => p !== '');
  const onPosting =
    here !== null &&
    here.protocol === 'https:' &&
    (here.hostname === 'job-boards.greenhouse.io' || here.hostname === 'boards.greenhouse.io') &&
    here.port === '' &&
    parts.length === 3 &&
    (parts[0] ?? '').toLowerCase() === plan.board.toLowerCase() &&
    parts[1] === 'jobs' &&
    parts[2] === plan.jobId;
  if (!onPosting) return { ok: false, reason: 'wrong_page' };

  const form = doc.getElementById('application-form');
  if (form === null || form.tagName !== 'FORM') return { ok: false, reason: 'no_form' };

  const inputValue = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value');
  const areaValue = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value');
  const fire = (el: Element, type: 'input' | 'change'): void => {
    el.dispatchEvent(new view.Event(type, { bubbles: true }));
  };
  const clean = (s: string): string =>
    s
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*\*$/, '')
      .trim();
  // Labels are compared whole; the report shows at most 200 characters of one.
  const shown = (s: string): string => clean(s).slice(0, 200);
  const norm = (s: string): string => clean(s).toLowerCase();
  // Whether the form hides this element: it (when `self`) or any container of it up to the form
  // is hidden, aria-hidden, inert, display:none or visibility:hidden. Nothing hidden is filled.
  const concealed = (el: Element, self: boolean): boolean => {
    for (let n: Element | null = self ? el : el.parentElement; n !== null; n = n.parentElement) {
      if (n.hasAttribute('hidden') || n.hasAttribute('inert')) return true;
      if (n.getAttribute('aria-hidden') === 'true') return true;
      const style = view.getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      if (n === form) break;
    }
    return false;
  };
  // A dropdown widget is a choice whatever its markup carries, not only when it has its role:
  // writing into its search box would open and filter its menu.
  const isChoice = (el: Element): boolean =>
    el.getAttribute('role') === 'combobox' ||
    el.hasAttribute('aria-autocomplete') ||
    el.hasAttribute('aria-haspopup') ||
    el.classList.contains('select__input') ||
    el.closest('.select, .select__container') !== null;

  const STANDARD_IDS = ['first_name', 'last_name', 'email', 'phone'];
  const TEXT_TYPES = ['', 'text', 'tel', 'email', 'url'];
  const filled: string[] = [];
  const notFilled: { label: string; reason: NotFilledReason }[] = [];

  const fields: { el: Element; id: string; label: string; key: string; text: boolean }[] = [];
  for (const label of Array.from(form.querySelectorAll('label[for]'))) {
    const id = label.getAttribute('for') ?? '';
    if (id === '' || id === 'resume') continue;
    const el = doc.getElementById(id);
    if (el === null || !form.contains(el)) continue;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    // Never a hidden input.
    if (type === 'hidden') continue;
    const text =
      ((el.tagName === 'INPUT' && TEXT_TYPES.includes(type)) || el.tagName === 'TEXTAREA') &&
      !isChoice(el);
    const raw = label.textContent ?? '';
    fields.push({ el, id, label: raw, key: norm(raw), text });
  }
  // How many questions on the form carry each label: a label on two is ambiguous. A choice
  // control the form shows counts too (a select, a dropdown widget, a radio or checkbox, or the
  // legend of a group of them): its label beside a text question's means the reviewed value may
  // be the answer to either, so neither is filled (tl on #187, #192).
  const sameLabel = new Map<string, number>();
  const count = (key: string): void => {
    sameLabel.set(key, (sameLabel.get(key) ?? 0) + 1);
  };
  const CHOICE_TYPES = ['radio', 'checkbox'];
  for (const f of fields) {
    const type = (f.el.getAttribute('type') ?? '').toLowerCase();
    const choice =
      !f.text &&
      (f.el.tagName === 'SELECT' ||
        isChoice(f.el) ||
        (f.el.tagName === 'INPUT' && CHOICE_TYPES.includes(type)));
    if (f.text && !STANDARD_IDS.includes(f.id)) count(f.key);
    else if (choice && !concealed(f.el, true)) count(f.key);
  }
  for (const group of Array.from(form.querySelectorAll('fieldset'))) {
    const legend = group.querySelector('legend');
    const choices = group.querySelector('input[type="radio"], input[type="checkbox"]');
    if (legend === null || choices === null || concealed(group, true)) continue;
    count(norm(legend.textContent ?? ''));
  }

  const used = new Set<string>();
  for (const f of fields) {
    const text = shown(f.label);
    const standardAt = plan.standard.findIndex((s) => s.id === f.id);
    const matches = !f.text
      ? []
      : STANDARD_IDS.includes(f.id)
        ? standardAt < 0
          ? []
          : [`s${standardAt}`]
        : plan.questions.flatMap((q, i) =>
            q.labels.some((l) => norm(l) === f.key) ? [`q${i}`] : [],
          );
    // A field the server withheld (#196): nothing to fill it with, so it is reported once, as
    // withheld, under the form's label (never also as not reviewed: tl on #201).
    const withheldAt = !f.text
      ? -1
      : (plan.withheld ?? []).findIndex((w) =>
          STANDARD_IDS.includes(f.id) ? w.id === f.id : w.labels.some((l) => norm(l) === f.key),
        );
    if (withheldAt >= 0) {
      used.add(`w${withheldAt}`);
      notFilled.push({ label: text, reason: 'withheld' });
      continue;
    }
    // Nor anything the form does not show: reported only when there was a value for it.
    if (concealed(f.el, true)) {
      if (matches.length > 0) {
        for (const m of matches) used.add(m);
        notFilled.push({ label: text, reason: 'not_shown' });
      }
      continue;
    }
    if (!f.text) {
      // Another file input (a cover letter): never set, but say so in the words that fit.
      if (f.el.tagName === 'INPUT' && (f.el.getAttribute('type') ?? '').toLowerCase() === 'file') {
        notFilled.push({ label: text, reason: 'attach_file_yourself' });
      } else if (f.el.tagName === 'INPUT' || f.el.tagName === 'SELECT') {
        notFilled.push({ label: text, reason: 'choose_on_form' });
      }
      continue;
    }
    if (matches.length === 0) {
      notFilled.push({ label: text, reason: 'not_in_review' });
      continue;
    }
    for (const m of matches) used.add(m);
    // Two answers for this label, or two questions with it: which goes where cannot be known.
    if (matches.length > 1 || (sameLabel.get(f.key) ?? 0) > 1) {
      notFilled.push({ label: text, reason: 'ambiguous' });
      continue;
    }
    const only = matches[0] ?? '';
    const entry = only.startsWith('s')
      ? plan.standard.at(Number(only.slice(1)))
      : plan.questions.at(Number(only.slice(1)));
    if (entry === undefined) continue;
    const field = f.el as HTMLInputElement | HTMLTextAreaElement;
    if (field.value === entry.value) {
      filled.push(text);
      continue;
    }
    if (field.value !== '') {
      notFilled.push({ label: text, reason: 'has_value' });
      continue;
    }
    const setter = (f.el.tagName === 'TEXTAREA' ? areaValue : inputValue)?.set;
    if (setter === undefined) {
      notFilled.push({ label: text, reason: 'choose_on_form' });
      continue;
    }
    // One write of the whole value, then one input and one change event.
    setter.call(field, entry.value);
    fire(field, 'input');
    fire(field, 'change');
    filled.push(text);
  }

  plan.standard.forEach((s, i) => {
    if (!used.has(`s${i}`)) notFilled.push({ label: s.name, reason: 'no_matching_question' });
  });
  plan.questions.forEach((q, i) => {
    if (!used.has(`q${i}`)) notFilled.push({ label: q.name, reason: 'no_matching_question' });
  });
  // A withheld field the form does not ask for is still listed, by its name.
  (plan.withheld ?? []).forEach((w, i) => {
    if (!used.has(`w${i}`)) notFilled.push({ label: w.name, reason: 'withheld' });
  });

  // The resume: the only hidden input this sets, and only with the ready copy.
  const file = doc.getElementById('resume');
  const fileInput =
    file !== null &&
    form.contains(file) &&
    file.tagName === 'INPUT' &&
    (file.getAttribute('type') ?? '').toLowerCase() === 'file'
      ? (file as HTMLInputElement)
      : null;
  const accept = (fileInput?.getAttribute('accept') ?? '').toLowerCase();
  const takesPdf =
    accept === '' || accept.split(',').some((a) => ['.pdf', 'application/pdf'].includes(a.trim()));
  // The input itself is visually hidden by design; a hidden container of it is not.
  const name = plan.resume?.filename ?? '';
  let attached: { filename: string; size: number; before: number } | null = null;
  if (
    plan.resume === null ||
    name === '' ||
    fileInput === null ||
    !takesPdf ||
    concealed(fileInput, false)
  ) {
    notFilled.push({ label: 'Resume', reason: 'attach_yourself' });
  } else if ((fileInput.files?.length ?? 0) > 0) {
    notFilled.push({ label: 'Resume', reason: 'has_value' });
  } else {
    // How often the name is on the form now: the popup looks for one more.
    const before = (form.textContent ?? '').split(name).length - 1;
    const raw = view.atob(plan.resume.base64);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const pdf = new view.File([bytes], name, { type: 'application/pdf' });
    const carrier = new view.DataTransfer();
    carrier.items.add(pdf);
    fileInput.files = carrier.files;
    fire(fileInput, 'input');
    fire(fileInput, 'change');
    attached = { filename: name, size: pdf.size, before };
  }

  return { ok: true, filled, notFilled, resume: attached };
}

/**
 * How often the resume's name is on the form now, read only: no event, no write. Null when the
 * page is no longer the posting, or has no form. The popup calls it at fixed gaps after the fill.
 */
export function resumeShown(check: ResumeCheck, doc: Document = document): number | null {
  let here: URL | null;
  try {
    here = new URL(doc.location.href);
  } catch {
    here = null;
  }
  const parts = here === null ? [] : here.pathname.split('/').filter((p) => p !== '');
  const onPosting =
    here !== null &&
    here.protocol === 'https:' &&
    (here.hostname === 'job-boards.greenhouse.io' || here.hostname === 'boards.greenhouse.io') &&
    here.port === '' &&
    parts.length === 3 &&
    (parts[0] ?? '').toLowerCase() === check.board.toLowerCase() &&
    parts[1] === 'jobs' &&
    parts[2] === check.jobId;
  if (!onPosting || check.filename === '') return null;
  const form = doc.getElementById('application-form');
  if (form === null || form.tagName !== 'FORM') return null;
  return (form.textContent ?? '').split(check.filename).length - 1;
}

/**
 * Takes the resume back out when the form never showed it: only if #resume still holds exactly
 * the one file the filler set (its name and size), so a file the user chose meanwhile is kept.
 * It looks for the name once more first ('shown': nothing written), and an input empty by now
 * is 'empty'. One write, then one plain input and one change, as the filler does.
 */
export function clearResume(
  check: ResumeCheck & { size: number; before: number },
  doc: Document = document,
): 'cleared' | 'shown' | 'kept' | 'empty' | 'wrong_page' | 'no_input' {
  const view = doc.defaultView;
  if (view === null) return 'no_input';
  let here: URL | null;
  try {
    here = new URL(doc.location.href);
  } catch {
    here = null;
  }
  const parts = here === null ? [] : here.pathname.split('/').filter((p) => p !== '');
  const onPosting =
    here !== null &&
    here.protocol === 'https:' &&
    (here.hostname === 'job-boards.greenhouse.io' || here.hostname === 'boards.greenhouse.io') &&
    here.port === '' &&
    parts.length === 3 &&
    (parts[0] ?? '').toLowerCase() === check.board.toLowerCase() &&
    parts[1] === 'jobs' &&
    parts[2] === check.jobId;
  if (!onPosting) return 'wrong_page';
  const form = doc.getElementById('application-form');
  const file = doc.getElementById('resume');
  if (
    form === null ||
    form.tagName !== 'FORM' ||
    file === null ||
    !form.contains(file) ||
    file.tagName !== 'INPUT' ||
    (file.getAttribute('type') ?? '').toLowerCase() !== 'file'
  ) {
    return 'no_input';
  }
  // Look once more first: a name the form has just shown means it took the file (tl on #187).
  if (
    check.filename !== '' &&
    (form.textContent ?? '').split(check.filename).length - 1 > check.before
  ) {
    return 'shown';
  }
  const fileInput = file as HTMLInputElement;
  const held = fileInput.files;
  // Nothing in it by now (a reload, or the form's own handler): nothing to take back.
  if (held === null || held.length === 0) return 'empty';
  const ours =
    held !== null &&
    held.length === 1 &&
    held[0]?.name === check.filename &&
    held[0]?.size === check.size;
  if (!ours) return 'kept';
  const fire = (el: Element, type: 'input' | 'change'): void => {
    el.dispatchEvent(new view.Event(type, { bubbles: true }));
  };
  fileInput.files = new view.DataTransfer().files;
  fire(fileInput, 'input');
  fire(fileInput, 'change');
  return 'cleared';
}
