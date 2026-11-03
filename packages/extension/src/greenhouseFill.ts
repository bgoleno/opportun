// The one function that runs inside a Greenhouse application tab for assisted apply prefill (M3,
// https://github.com/bgoleno/opportun/issues/183; tl's design on #120 and sec's six conditions
// on #183). The popup runs it once, on the user's click, in the top frame of the active tab
// (chrome.scripting.executeScript serializes it with toString()). It must stay self-contained,
// as extract.ts's readers are: no imports, no module-level names, only its parameters, its own
// body and the page's globals. Type-only names are erased before it is serialized.
//
// What it may do, enforced by a scan of its own source (test/greenhouseFill.test.ts):
// - set a text input's or textarea's value once, with the element prototype's native setter
//   (the form is React-controlled: a plain assignment is not seen), then dispatch a plain
//   bubbling Event 'input' and Event 'change' on that element, and nothing else: no key,
//   pointer, mouse, drag or focus events, no InputEvent, no per-character loop, no timers;
// - attach the resume through DataTransfer on #resume only, the one hidden input it touches,
//   and report it as attached only when the form then shows the file's name;
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
  /** The resume: no ready copy, or no file input that takes a PDF. */
  | 'attach_yourself'
  /** The file was set, but the form did not show its name. */
  | 'resume_not_shown';

export type FillReport =
  | {
      ok: true;
      filled: string[];
      notFilled: { label: string; reason: NotFilledReason }[];
    }
  | { ok: false; reason: 'wrong_page' | 'no_form' };

export async function fillGreenhouseForm(
  plan: FillPlan,
  doc: Document = document,
): Promise<FillReport> {
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
  const shown = (s: string): string =>
    s
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s*\*$/, '')
      .trim()
      .slice(0, 200);
  const norm = (s: string): string => shown(s).toLowerCase();

  const STANDARD_IDS = ['first_name', 'last_name', 'email', 'phone'];
  const TEXT_TYPES = ['', 'text', 'tel', 'email', 'url'];
  const filled: string[] = [];
  const notFilled: { label: string; reason: NotFilledReason }[] = [];
  const used = new Set<string>();

  for (const label of Array.from(form.querySelectorAll('label[for]'))) {
    const id = label.getAttribute('for') ?? '';
    if (id === '' || id === 'resume') continue;
    const el = doc.getElementById(id);
    if (el === null || !form.contains(el)) continue;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    // Never a hidden input.
    if (type === 'hidden' || el.getAttribute('aria-hidden') === 'true') continue;
    const text = shown(label.textContent ?? '');
    const isText =
      (el.tagName === 'INPUT' &&
        TEXT_TYPES.includes(type) &&
        el.getAttribute('role') !== 'combobox') ||
      el.tagName === 'TEXTAREA';
    if (!isText) {
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
        notFilled.push({ label: text, reason: 'choose_on_form' });
      }
      continue;
    }
    const entry = STANDARD_IDS.includes(id)
      ? plan.standard.find((s) => s.id === id)
      : plan.questions.find((q) => q.labels.some((l) => norm(l) === norm(text)));
    if (entry === undefined) {
      notFilled.push({ label: text, reason: 'not_in_review' });
      continue;
    }
    used.add(entry.name);
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    if (field.value === entry.value) {
      filled.push(text);
      continue;
    }
    if (field.value !== '') {
      notFilled.push({ label: text, reason: 'has_value' });
      continue;
    }
    const setter = (el.tagName === 'TEXTAREA' ? areaValue : inputValue)?.set;
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

  for (const entry of [...plan.standard, ...plan.questions]) {
    if (!used.has(entry.name))
      notFilled.push({ label: entry.name, reason: 'no_matching_question' });
  }

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
  if (plan.resume === null || fileInput === null || !takesPdf) {
    notFilled.push({ label: 'Resume', reason: 'attach_yourself' });
  } else if ((fileInput.files?.length ?? 0) > 0) {
    notFilled.push({ label: 'Resume', reason: 'has_value' });
  } else {
    const raw = view.atob(plan.resume.base64);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const pdf = new view.File([bytes], plan.resume.filename, { type: 'application/pdf' });
    const carrier = new view.DataTransfer();
    carrier.items.add(pdf);
    fileInput.files = carrier.files;
    fire(fileInput, 'input');
    fire(fileInput, 'change');
    // Let the form render what it did with the file (two microtasks, no clock), then look.
    await Promise.resolve();
    await Promise.resolve();
    if ((form.textContent ?? '').includes(plan.resume.filename)) filled.push('Resume');
    else notFilled.push({ label: 'Resume', reason: 'resume_not_shown' });
  }

  return { ok: true, filled, notFilled };
}
