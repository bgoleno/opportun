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
//   bubbling Event 'input' and Event 'change' on that element: no key, pointer, drag or focus
//   events, no InputEvent, no per-character loop;
// - choose the one option of a single-choice list that equals the reviewed value (slice 2 of
//   https://github.com/bgoleno/opportun/issues/402: tl's rule 3, issuecomment-6794050298 and
//   6808214454 with its step 2.6, 6808394836; sec's rulings 6808114453 and 6808390283), only in
//   the named controls and in a list question whose label is a reviewed answer's. It writes the
//   value into the list's search box as above, opens the list with one plain bubbling
//   MouseEvent 'mouseup' on that box (one helper, `press`), waits for the options with one
//   MutationObserver and one 3 second timer (one helper, `waitFor`), and clicks the option once
//   (one helper, `pick`). A list it opened and chose nothing from gets one more mouseup, to
//   close it, after the box is emptied the same way. Nothing in a self-identification block,
//   no multi-select, and nothing else is ever pressed;
// - attach the resume through DataTransfer on #resume only, the one hidden input it touches,
//   and return how often its name was on the form before. It does not judge whether the form
//   took it: React renders the name after a macrotask, and the page side keeps no timer. The
//   popup looks with resumeShown, read-only, at fixed gaps on its own timer, and if the name
//   never appears, clearResume takes the file back out, and only if it is still exactly ours;
// - leave alone any other dropdown widget however it is marked up, and a label that is
//   ambiguous (two questions, or two reviewed answers, carry it): which value goes where cannot
//   be known;
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
  /**
   * Lists chosen in by the form's own control id (#402 slice 2): `country` (the phone's country
   * code), `candidate-location`, `school--0` and `degree--0`, with the reviewed value.
   */
  lists: { id: string; name: string; value: string }[];
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
  | 'withheld'
  /** No option on the form's list equals the reviewed value (`detail`), by the bound. */
  | 'no_option'
  /** More than one option equals the reviewed value (`detail`): none is chosen. */
  | 'several_options'
  /** The form's list did not appear (no list named by aria-controls) by the bound. */
  | 'list_not_shown'
  /** An option (`detail`) was clicked but the control does not show it: check the field. */
  | 'not_confirmed';

export type FillReport =
  | {
      ok: true;
      /** Each option chosen from a list, with the text chosen: listed first, to be checked. */
      chosen: { label: string; text: string }[];
      filled: string[];
      /** `detail` is the value looked for, or the option chosen, for the list reasons only. */
      notFilled: { label: string; reason: NotFilledReason; detail?: string }[];
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
  // How often the name is in the form's visible text: text inside an element that is, or sits
  // in one that is, hidden, aria-hidden, inert, display:none or visibility:hidden does not
  // count, so a copy the user cannot see never passes for the form showing the file (#191).
  const seenIn = (root: Element, name: string): number => {
    const win = root.ownerDocument.defaultView;
    if (win === null || name === '') return 0;
    const hiddenByIt = (n: Element): boolean => {
      if (n.hasAttribute('hidden') || n.hasAttribute('inert')) return true;
      if (n.getAttribute('aria-hidden') === 'true') return true;
      const style = win.getComputedStyle(n);
      return style.display === 'none' || style.visibility === 'hidden';
    };
    const verdicts = new Map<Element, boolean>();
    const hidden = (el: Element): boolean => {
      const known = verdicts.get(el);
      if (known !== undefined) return known;
      const parent = el.parentElement;
      const result = hiddenByIt(el) || (el !== root && parent !== null && hidden(parent));
      verdicts.set(el, result);
      return result;
    };
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    let text = '';
    for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
      const parent = t.parentElement;
      if (parent !== null && !hidden(parent)) text += t.nodeValue ?? '';
    }
    return text.split(name).length - 1;
  };
  // A dropdown widget is a choice whatever its markup carries, not only when it has its role:
  // writing into its search box would open and filter its menu.
  const isChoice = (el: Element): boolean =>
    el.getAttribute('role') === 'combobox' ||
    el.hasAttribute('aria-autocomplete') ||
    el.hasAttribute('aria-haspopup') ||
    el.classList.contains('select__input') ||
    el.closest('.select, .select__container') !== null;

  // The lists it may choose in (tl's rule 3.1): these named controls, and a list question whose
  // label is a reviewed answer's. Nothing inside a self-identification block, whatever its id or
  // label, and nothing else in the education block (Discipline, the dates, a second entry).
  const LIST_IDS = ['country', 'candidate-location', 'school--0', 'degree--0'];
  // Erased in the serialized source, with any comment just before it: kept above the helpers.
  type Found =
    { kind: 'one'; option: Element } | { kind: 'several' } | { kind: 'none' } | { kind: 'no_list' };

  // list helpers: start. greenhouseListHelpers below holds the same code, for tests to call; a
  // test pins the two copies equal.
  const inBlock = (el: Element): boolean =>
    el.closest('div.eeoc__container, div#demographic-section') !== null;
  // A single-choice list's own search box, in this form and outside both blocks: the only
  // element `press` sends anything to.
  const isBox = (el: Element): boolean => {
    const shell = el.closest('div.select-shell');
    const holder = el.closest('div.select__value-container');
    return (
      el.tagName === 'INPUT' &&
      el.classList.contains('select__input') &&
      el.getAttribute('role') === 'combobox' &&
      form.contains(el) &&
      !inBlock(el) &&
      shell !== null &&
      holder !== null &&
      shell.contains(holder) &&
      !holder.classList.contains('select__value-container--is-multi')
    );
  };
  // One mouseup on a list's search box, to open its list (only while aria-expanded is "false")
  // or to close one this fill opened (only while it is "true"). A plain bubbling mouse event with
  // nothing else set; it refuses any other element.
  const press = (box: Element, open: boolean): boolean => {
    if (!isBox(box) || box.getAttribute('aria-expanded') !== (open ? 'false' : 'true')) {
      return false;
    }
    box.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true }));
    return true;
  };
  // The options of the list the box names in aria-controls while it is open, when that list is
  // a listbox inside the box's own select-shell; null when there is no such list.
  const optionsOf = (box: Element): Element[] | null => {
    const shell = box.closest('div.select-shell');
    const listId = box.getAttribute('aria-controls') ?? '';
    const list = listId === '' ? null : doc.getElementById(listId);
    if (shell === null || list === null) return null;
    if (list.getAttribute('role') !== 'listbox' || !shell.contains(list)) return null;
    return Array.from(list.querySelectorAll('[role="option"]')).filter(
      (o) =>
        o.closest('[role="listbox"]') === list &&
        !['A', 'BUTTON', 'INPUT', 'LABEL'].includes(o.tagName),
    );
  };
  // The one click: only on an option of the list this box names, inside its own select-shell.
  const pick = (box: Element, option: Element): boolean => {
    if (!(optionsOf(box) ?? []).includes(option)) return false;
    (option as HTMLElement).click();
    return true;
  };
  // Waits until `look` has an answer, with one observer on the control and one timer of `ms`;
  // when the timer ends, `late` gives the answer. The observer is disconnected and the timer
  // cleared on every way out.
  const watchFor = <T>(box: Element, look: () => T | null, late: () => T, ms: number): Promise<T> =>
    new Promise((resolve) => {
      const shell = box.closest('div.select-shell') ?? box;
      let over = false;
      let timer = 0;
      const end = (answer: T): void => {
        if (over) return;
        over = true;
        watch.disconnect();
        view.clearTimeout(timer);
        resolve(answer);
      };
      const watch = new view.MutationObserver(() => {
        const answer = look();
        if (answer !== null) end(answer);
      });
      watch.observe(shell, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      timer = view.setTimeout(() => end(late()), ms);
      const now = look();
      if (now !== null) end(now);
    });
  // list helpers: end
  const STANDARD_IDS = ['first_name', 'last_name', 'email', 'phone'];
  const TEXT_TYPES = ['', 'text', 'tel', 'email', 'url'];
  const chosen: { label: string; text: string }[] = [];
  const filled: string[] = [];
  const notFilled: { label: string; reason: NotFilledReason; detail?: string }[] = [];
  // The lists to choose in, in the form's order, done one at a time once the rest is filled.
  const lists: { box: HTMLInputElement; label: string; value: string; country: boolean }[] = [];

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
    // Nothing inside a self-identification block is written to, whatever its id or label
    // (sec on #402, tl's blocking 3 at 8084132): such a field is never text here, so it is only
    // ever reported for the user to answer on the form.
    fields.push({ el, id, label: raw, key: norm(raw), text: text && !inBlock(el) });
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
    // Its own legend only, never a nested fieldset's (tl on #205, #206).
    const legend = group.querySelector(':scope > legend');
    const choices = group.querySelector('input[type="radio"], input[type="checkbox"]');
    if (legend === null || choices === null || concealed(group, true)) continue;
    count(norm(legend.textContent ?? ''));
  }

  const used = new Set<string>();
  for (const f of fields) {
    // The phone's country code is named as such, never "Country", so it is not read as where the
    // user lives (sec's ruling 2.3 on #402).
    const text = f.id === 'country' ? 'Phone country code' : shown(f.label);
    const standardAt = plan.standard.findIndex((s) => s.id === f.id);
    const named = !f.text && LIST_IDS.includes(f.id);
    const listAt = named ? plan.lists.findIndex((l) => l.id === f.id) : -1;
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
      ? named
        ? (plan.withheld ?? []).findIndex((w) => w.id === f.id)
        : -1
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
      if (listAt >= 0) used.add(`l${listAt}`);
      if (matches.length > 0 || listAt >= 0) {
        for (const m of matches) used.add(m);
        notFilled.push({ label: text, reason: 'not_shown' });
      }
      continue;
    }
    if (!f.text) {
      // Another file input (a cover letter): never set, but say so in the words that fit.
      if (f.el.tagName === 'INPUT' && (f.el.getAttribute('type') ?? '').toLowerCase() === 'file') {
        notFilled.push({ label: text, reason: 'attach_file_yourself' });
      } else if (
        f.el.tagName === 'INPUT' ||
        f.el.tagName === 'SELECT' ||
        (f.el.tagName === 'TEXTAREA' && inBlock(f.el))
      ) {
        // A reviewed answer for this choice is accounted for here: it is never also reported as
        // having no question (#204).
        const answered = plan.questions.flatMap((q, i) =>
          q.labels.some((l) => norm(l) === f.key) ? [i] : [],
        );
        for (const i of answered) used.add(`q${i}`);
        if (listAt >= 0) used.add(`l${listAt}`);
        // A named control takes its list detail by id; any other list, outside the education
        // block, a reviewed answer by its label.
        const listable =
          isBox(f.el) && (named || f.el.closest('div.education--container') === null);
        // Read by index only when there is one: at(-1) would be the last entry, another field's.
        const only = answered.length === 1 ? answered[0] : undefined;
        const value = named
          ? listAt >= 0
            ? plan.lists.at(listAt)?.value
            : undefined
          : only === undefined
            ? undefined
            : plan.questions.at(only)?.value;
        const box = f.el as HTMLInputElement;
        if (listable && !named && (answered.length > 1 || (sameLabel.get(f.key) ?? 0) > 1)) {
          notFilled.push({ label: text, reason: 'ambiguous' });
        } else if (!listable || value === undefined) {
          notFilled.push({ label: text, reason: 'choose_on_form' });
        } else if (box.getAttribute('aria-expanded') !== 'false') {
          // Open already (the user opened it), or not a list this can open: never touched.
          notFilled.push({ label: text, reason: 'choose_on_form' });
        } else if (
          box.value !== '' ||
          box.closest('div.select__value-container')?.querySelector('.select__single-value')
        ) {
          notFilled.push({ label: text, reason: 'has_value' });
        } else {
          lists.push({ box, label: text, value, country: f.id === 'country' });
        }
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

  // A radio or checkbox group the form shows, whose legend is a reviewed answer's label: one
  // "choose it on the form" line under the legend, and the answer is accounted for (#204).
  for (const group of Array.from(form.querySelectorAll('fieldset'))) {
    // Its own legend only, never a nested fieldset's (tl on #205, #206).
    const legend = group.querySelector(':scope > legend');
    const choices = group.querySelector('input[type="radio"], input[type="checkbox"]');
    if (legend === null || choices === null || concealed(group, true)) continue;
    const key = norm(legend.textContent ?? '');
    const answered = plan.questions.flatMap((q, i) =>
      q.labels.some((l) => norm(l) === key) ? [`q${i}`] : [],
    );
    if (answered.length === 0) continue;
    for (const m of answered) used.add(m);
    notFilled.push({ label: shown(legend.textContent ?? ''), reason: 'choose_on_form' });
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
    // How often the name is on the form now, where the user can see it: the popup looks for
    // one more.
    const before = seenIn(form, name);
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

  // Options are compared with case and spaces normalised only: `norm` also drops a trailing `*`
  // (a required field's mark), which would make "Other *" equal "Other" (tl at 8084132).
  const same = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  // Whether the control shows the option chosen: its text, or for the phone's country code the
  // option's "+digits" and, where the control exposes the flag's country, that country.
  // 'flag' is a flag that names another country (sec 2.2: choose it on the form).
  const showsChoice = (box: Element, option: string, phoneCode: boolean): 'yes' | 'no' | 'flag' => {
    const holder = box.closest('div.select__value-container');
    if (holder === null) return 'no';
    const seen = same(holder.textContent ?? '');
    if (!phoneCode) return seen === same(option) ? 'yes' : 'no';
    const code = / (\+\d{1,4})$/.exec(same(option))?.[1];
    if (code === undefined || !seen.split(' ').includes(code)) return 'no';
    const flag = Array.from(holder.querySelectorAll('[alt], [title], [aria-label]')).find(
      (n) => n !== box,
    );
    if (flag === undefined) return 'yes';
    const says =
      flag.getAttribute('alt') ?? flag.getAttribute('title') ?? flag.getAttribute('aria-label');
    return same(says ?? '') === same(option).replace(/ \+\d{1,4}$/, '') ? 'yes' : 'flag';
  };
  // Whether the control shows a choice already, or its box holds text.
  const inUse = (box: HTMLInputElement): boolean =>
    box.value !== '' ||
    box.closest('div.select__value-container')?.querySelector('.select__single-value') != null;

  // The lists, one at a time: write the value, open the list, wait, choose the one equal option.
  for (const job of lists) {
    const { box, label, value } = job;
    const setter = inputValue?.set;
    // Checked again just before acting (tl's blocking 1 at 8084132): seconds may have passed
    // since the fields were read, and the user may have opened this list or typed in it. Then
    // it is theirs, and it is left as it is.
    if (setter === undefined || box.getAttribute('aria-expanded') !== 'false') {
      notFilled.push({ label, reason: 'choose_on_form' });
      continue;
    }
    if (inUse(box)) {
      notFilled.push({ label, reason: 'has_value' });
      continue;
    }
    const want = same(value);
    // The phone's country code: each option's text without one trailing " +digits" (sec 2.1).
    const equal = job.country
      ? (t: string): boolean => same(t).replace(/ \+\d{1,4}$/, '') === want
      : (t: string): boolean => same(t) === want;
    // Emptied only while it still holds what this fill wrote, never over the user's own text.
    const empty = (): void => {
      if (box.value !== value) return;
      setter.call(box, '');
      fire(box, 'input');
      fire(box, 'change');
    };
    // Written before the list opens: the education lists ask their service, when they open, for
    // the text the box holds then.
    setter.call(box, value);
    fire(box, 'input');
    fire(box, 'change');
    if (!press(box, true)) {
      // It opened meanwhile, or is no longer a list box: nothing is waited for or clicked.
      empty();
      notFilled.push({ label, reason: 'choose_on_form' });
      continue;
    }
    // One 3 second wait for the options: "none" only when the timer ends, since they arrive more
    // than once; when an equal option is seen, the equal ones in the list then are counted.
    const found = await watchFor<Found>(
      box,
      () => {
        const equals = (optionsOf(box) ?? []).filter((o) => equal(o.textContent ?? ''));
        const first = equals[0];
        if (first === undefined) return null;
        return equals.length === 1 ? { kind: 'one', option: first } : { kind: 'several' };
      },
      () => (optionsOf(box) === null ? { kind: 'no_list' } : { kind: 'none' }),
      3000,
    );
    // Found, then replaced before the click: there was one, so the field is "choose it on the
    // form", not "no option" (tl's optional point at 8084132). It leaves by the same way out.
    let replaced = false;
    if (found.kind === 'one') {
      const text = found.option.textContent ?? '';
      if (pick(box, found.option)) {
        // The form shows the choice in its own time: React applies a click's update after the
        // click returns (tl's blocking 2 at 8084132). Waited for within a second, the same way.
        const verdict = await watchFor<'yes' | 'no' | 'flag'>(
          box,
          () => (showsChoice(box, text, job.country) === 'yes' ? 'yes' : null),
          () => showsChoice(box, text, job.country),
          1000,
        );
        if (verdict === 'yes') chosen.push({ label, text: shown(text) });
        // A flag naming another country: choose it on the form (sec 2.2).
        else if (verdict === 'flag') notFilled.push({ label, reason: 'choose_on_form' });
        else notFilled.push({ label, reason: 'not_confirmed', detail: shown(text) });
        continue;
      }
      replaced = true;
    }
    // Nothing chosen: the box is emptied the same way first, then the list this fill opened is
    // closed with one more mouseup (step 2.6).
    empty();
    press(box, false);
    notFilled.push(
      replaced
        ? { label, reason: 'choose_on_form' }
        : {
            label,
            reason:
              found.kind === 'several'
                ? 'several_options'
                : found.kind === 'no_list'
                  ? 'list_not_shown'
                  : 'no_option',
            detail: shown(value),
          },
    );
  }

  return { ok: true, chosen, filled, notFilled, resume: attached };
}

/**
 * How often the resume's name is on the form now, where the user can see it (#191), read only:
 * no event, no write. Null when the
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
  // How often the name is in the form's visible text: text inside an element that is, or sits
  // in one that is, hidden, aria-hidden, inert, display:none or visibility:hidden does not
  // count, so a copy the user cannot see never passes for the form showing the file (#191).
  const seenIn = (root: Element, name: string): number => {
    const win = root.ownerDocument.defaultView;
    if (win === null || name === '') return 0;
    const hiddenByIt = (n: Element): boolean => {
      if (n.hasAttribute('hidden') || n.hasAttribute('inert')) return true;
      if (n.getAttribute('aria-hidden') === 'true') return true;
      const style = win.getComputedStyle(n);
      return style.display === 'none' || style.visibility === 'hidden';
    };
    const verdicts = new Map<Element, boolean>();
    const hidden = (el: Element): boolean => {
      const known = verdicts.get(el);
      if (known !== undefined) return known;
      const parent = el.parentElement;
      const result = hiddenByIt(el) || (el !== root && parent !== null && hidden(parent));
      verdicts.set(el, result);
      return result;
    };
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    let text = '';
    for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
      const parent = t.parentElement;
      if (parent !== null && !hidden(parent)) text += t.nodeValue ?? '';
    }
    return text.split(name).length - 1;
  };
  return seenIn(form, check.filename);
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
  // How often the name is in the form's visible text: text inside an element that is, or sits
  // in one that is, hidden, aria-hidden, inert, display:none or visibility:hidden does not
  // count, so a copy the user cannot see never passes for the form showing the file (#191).
  const seenIn = (root: Element, name: string): number => {
    const win = root.ownerDocument.defaultView;
    if (win === null || name === '') return 0;
    const hiddenByIt = (n: Element): boolean => {
      if (n.hasAttribute('hidden') || n.hasAttribute('inert')) return true;
      if (n.getAttribute('aria-hidden') === 'true') return true;
      const style = win.getComputedStyle(n);
      return style.display === 'none' || style.visibility === 'hidden';
    };
    const verdicts = new Map<Element, boolean>();
    const hidden = (el: Element): boolean => {
      const known = verdicts.get(el);
      if (known !== undefined) return known;
      const parent = el.parentElement;
      const result = hiddenByIt(el) || (el !== root && parent !== null && hidden(parent));
      verdicts.set(el, result);
      return result;
    };
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    let text = '';
    for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
      const parent = t.parentElement;
      if (parent !== null && !hidden(parent)) text += t.nodeValue ?? '';
    }
    return text.split(name).length - 1;
  };
  // Look once more first: a name the form has just shown means it took the file (tl on #187).
  if (check.filename !== '' && seenIn(form, check.filename) > check.before) {
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

/**
 * The list helpers the filler uses, built on their own for tests (sec on #402, point 1.1: each
 * refusal is fed to the helper itself). The filler cannot call this: it is serialized alone, so
 * it carries its own copy, and test/greenhouseFill.test.ts pins the two copies equal. Nothing in
 * the extension calls this function.
 */
export function greenhouseListHelpers(doc: Document, form: Element) {
  const view = doc.defaultView as Window & typeof globalThis;
  // list helpers: start. greenhouseListHelpers below holds the same code, for tests to call; a
  // test pins the two copies equal.
  const inBlock = (el: Element): boolean =>
    el.closest('div.eeoc__container, div#demographic-section') !== null;
  // A single-choice list's own search box, in this form and outside both blocks: the only
  // element `press` sends anything to.
  const isBox = (el: Element): boolean => {
    const shell = el.closest('div.select-shell');
    const holder = el.closest('div.select__value-container');
    return (
      el.tagName === 'INPUT' &&
      el.classList.contains('select__input') &&
      el.getAttribute('role') === 'combobox' &&
      form.contains(el) &&
      !inBlock(el) &&
      shell !== null &&
      holder !== null &&
      shell.contains(holder) &&
      !holder.classList.contains('select__value-container--is-multi')
    );
  };
  // One mouseup on a list's search box, to open its list (only while aria-expanded is "false")
  // or to close one this fill opened (only while it is "true"). A plain bubbling mouse event with
  // nothing else set; it refuses any other element.
  const press = (box: Element, open: boolean): boolean => {
    if (!isBox(box) || box.getAttribute('aria-expanded') !== (open ? 'false' : 'true')) {
      return false;
    }
    box.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true }));
    return true;
  };
  // The options of the list the box names in aria-controls while it is open, when that list is
  // a listbox inside the box's own select-shell; null when there is no such list.
  const optionsOf = (box: Element): Element[] | null => {
    const shell = box.closest('div.select-shell');
    const listId = box.getAttribute('aria-controls') ?? '';
    const list = listId === '' ? null : doc.getElementById(listId);
    if (shell === null || list === null) return null;
    if (list.getAttribute('role') !== 'listbox' || !shell.contains(list)) return null;
    return Array.from(list.querySelectorAll('[role="option"]')).filter(
      (o) =>
        o.closest('[role="listbox"]') === list &&
        !['A', 'BUTTON', 'INPUT', 'LABEL'].includes(o.tagName),
    );
  };
  // The one click: only on an option of the list this box names, inside its own select-shell.
  const pick = (box: Element, option: Element): boolean => {
    if (!(optionsOf(box) ?? []).includes(option)) return false;
    (option as HTMLElement).click();
    return true;
  };
  // Waits until `look` has an answer, with one observer on the control and one timer of `ms`;
  // when the timer ends, `late` gives the answer. The observer is disconnected and the timer
  // cleared on every way out.
  const watchFor = <T>(box: Element, look: () => T | null, late: () => T, ms: number): Promise<T> =>
    new Promise((resolve) => {
      const shell = box.closest('div.select-shell') ?? box;
      let over = false;
      let timer = 0;
      const end = (answer: T): void => {
        if (over) return;
        over = true;
        watch.disconnect();
        view.clearTimeout(timer);
        resolve(answer);
      };
      const watch = new view.MutationObserver(() => {
        const answer = look();
        if (answer !== null) end(answer);
      });
      watch.observe(shell, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      timer = view.setTimeout(() => end(late()), ms);
      const now = look();
      if (now !== null) end(now);
    });
  // list helpers: end
  return { inBlock, isBox, press, optionsOf, pick, watchFor };
}
