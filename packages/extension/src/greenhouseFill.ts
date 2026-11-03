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
//   and report it as attached only when the form then shows the file's name (absent before,
//   shown after); otherwise clear it again the same way and say to attach it yourself;
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
   * The resume: no ready copy, no shown file input that takes a PDF, or the form did not show
   * the file's name once it was set (then it is cleared again).
   */
  | 'attach_yourself';

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
  // How many questions on the form carry each label: a label on two is ambiguous.
  const sameLabel = new Map<string, number>();
  for (const f of fields) {
    if (f.text && !STANDARD_IDS.includes(f.id))
      sameLabel.set(f.key, (sameLabel.get(f.key) ?? 0) + 1);
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
    // Nor anything the form does not show: reported only when there was a value for it.
    if (concealed(f.el, true)) {
      if (matches.length > 0) {
        for (const m of matches) used.add(m);
        notFilled.push({ label: text, reason: 'not_shown' });
      }
      continue;
    }
    if (!f.text) {
      if (f.el.tagName === 'INPUT' || f.el.tagName === 'SELECT') {
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
    // The name must appear because of the attach: shown once more after it than before.
    const named = (): number => (form.textContent ?? '').split(name).length - 1;
    const namedBefore = named();
    const raw = view.atob(plan.resume.base64);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const pdf = new view.File([bytes], name, { type: 'application/pdf' });
    const carrier = new view.DataTransfer();
    carrier.items.add(pdf);
    fileInput.files = carrier.files;
    fire(fileInput, 'input');
    fire(fileInput, 'change');
    // Let the form render what it did with the file (two microtasks, no clock), then look.
    await Promise.resolve();
    await Promise.resolve();
    if (named() > namedBefore) {
      filled.push('Resume');
    } else {
      // Not shown: take the file back out, the same way, and say to attach it yourself.
      fileInput.files = new view.DataTransfer().files;
      fire(fileInput, 'input');
      fire(fileInput, 'change');
      notFilled.push({ label: 'Resume', reason: 'attach_yourself' });
    }
  }

  return { ok: true, filled, notFilled };
}
