// Synthetic Greenhouse application forms for assisted apply prefill (#183), built from the
// structure the Tech Lead recorded on real forms (tl's design on
// https://github.com/bgoleno/opportun/issues/120): the ids, the label `for`, the `*` marker, the
// visually hidden file input with its four buttons, react-select comboboxes with their hidden
// required input, single-line and multi-line questions, a self-identification block, and a
// captcha badge and frame stand-in. Every company, board, id, question and value here is a
// placeholder; nothing was copied from a real posting. sec reviews these fixtures.
import { Window } from 'happy-dom';

export const BOARD = 'examplecorp';
export const JOB_ID = '1000001';
export const POSTING_URL = `https://job-boards.greenhouse.io/${BOARD}/jobs/${JOB_ID}`;

export const text = (id: string, label: string, required = false, type = 'text', extra = '') => `
    <div class="field-wrapper">
      <div class="input-wrapper">
        <div class="text-input-wrapper">
          <label id="${id}-label" for="${id}">${label}${required ? '<span aria-hidden="true">*</span>' : ''}</label>
          <input id="${id}" class="input input__single-line" type="${type}" maxlength="255"
            aria-describedby="${id}-description" ${extra} />
        </div>
      </div>
    </div>`;

export const area = (id: string, label: string, required = false) => `
    <div class="field-wrapper">
      <div class="input-wrapper">
        <label id="${id}-label" for="${id}">${label}${required ? '<span aria-hidden="true">*</span>' : ''}</label>
        <textarea id="${id}" class="input input__multi-line" rows="4"
          aria-describedby="${id}-description" ${required ? 'aria-required="true"' : ''}></textarea>
      </div>
    </div>`;

/**
 * A react-select: a combobox whose options are not in the page until its menu opens. As on the
 * real form (tl's structure check on #402, issuecomment-6808089483), the search box sits in the
 * value container, which carries `select__value-container--is-multi` on a multi-select.
 */
export const select = (id: string, label: string, required = false, multi = false) => `
    <div class="field-wrapper">
      <div class="select">
        <div class="select__container">
          <label id="${id}-label" for="${id}">${label}${required ? '<span aria-hidden="true">*</span>' : ''}</label>
          <div class="select-shell">
            <div class="select__control">
              <div class="select__value-container${multi ? ' select__value-container--is-multi' : ''}">
                <div class="select__placeholder">Select...</div>
                <div class="select__input-container">
                  <input id="${id}" class="select__input" role="combobox" aria-autocomplete="list"
                    aria-haspopup="true" aria-expanded="false" aria-labelledby="${id}-label" value="" />
                </div>
              </div>
            </div>
          </div>
          ${required ? `<input class="${id}-requiredInput" aria-hidden="true" tabindex="-1" value="" />` : ''}
        </div>
      </div>
    </div>`;

export const STANDARD = `
    <fieldset>
      <legend>Apply</legend>
      ${text('first_name', 'First Name', true, 'text', 'autocomplete="given-name"')}
      ${text('last_name', 'Last Name', true, 'text', 'autocomplete="family-name"')}
      ${text('email', 'Email', true, 'text', 'autocomplete="email"')}
      <div class="phone-input__country">${select('country', 'Country', true)}</div>
      <div class="field-wrapper">
        <label id="phone-label" for="phone">Phone</label>
        <div class="iti">
          <button type="button" class="iti__selected-country" aria-label="Country code">+1</button>
          <div class="iti__dropdown-content" hidden><input id="iti-0__search-input" type="search" /></div>
          <input id="phone" class="input input__single-line" type="tel" maxlength="255" />
        </div>
      </div>
    </fieldset>
    <div class="file-upload">
      <label id="resume-label" for="resume">Resume/CV<span aria-hidden="true">*</span></label>
      <div class="file-upload__wrapper">
        <div class="button-container">
          <div class="secondary-button">
            <input id="resume" class="visually-hidden" type="file"
              accept=".pdf,.doc,.docx,.txt,.rtf" />
          </div>
          <button type="button" class="btn btn--rounded">Attach</button>
          <button type="button" class="btn btn--rounded">Dropbox</button>
          <button type="button" class="btn btn--rounded">Google Drive</button>
          <button type="button" class="btn btn--rounded">Enter manually</button>
        </div>
        <p class="file-upload__filename"></p>
      </div>
    </div>`;

const CAPTCHA_AND_SUBMIT = `
    <div class="captcha-badge" data-sitekey="placeholder-site-key"></div>
    <iframe title="captcha placeholder" src="about:blank"></iframe>
    <button type="submit" class="btn btn--rounded">Submit application</button>`;

export const form = (body: string) => `<!doctype html><html><body><main>
  <h1>Placeholder Engineer</h1>
  <form id="application-form" class="application--form" method="get" action="/${BOARD}/jobs/${JOB_ID}">
    ${body}
    ${CAPTCHA_AND_SUBMIT}
  </form>
</main></body></html>`;

/** The fixed self-identification block (tl on #120): left alone whatever its ids or labels. */
export const EEOC = `
    <div class="eeoc__container">
      <h2>Voluntary Self-Identification</h2>
      ${select('gender', 'Gender')}
      ${select('hispanic_ethnicity', 'Are you Hispanic/Latino?')}
      ${select('veteran_status', 'Veteran Status')}
    </div>`;

/**
 * A board's own self-identification block (tl's structure check on #402): bare numeric ids, one
 * of them a multi-select. Everything inside it is left alone too.
 */
export const DEMOGRAPHIC = `
    <div id="demographic-section" class="demographic--container">
      ${select('4000001', 'Placeholder demographic question', false)}
      ${select('4000002', 'Placeholder demographic choices', false, true)}
    </div>`;

/** Location (City), with the Locate me button the filler must never press. */
export const LOCATION = `
    ${select('candidate-location', 'Location (City)', true)}
    <button type="button" id="locate-me" class="btn btn--rounded">Locate me</button>`;

/** The education block's first entry: School, Degree, Discipline and the months. */
export const EDUCATION = `
    <div class="education--container">
      <div class="education--form">
        ${select('school--0', 'School')}
        ${select('degree--0', 'Degree')}
        ${select('discipline--0', 'Discipline')}
        ${select('start-month--0', 'Start date month')}
        ${text('start-year--0', 'Start date year', false, 'number')}
      </div>
      <button type="button" id="add-education" class="btn btn--rounded">Add another</button>
    </div>`;

/** Posting C: every list slice 2 chooses in, a list question, and both self-identification blocks. */
export const LIST_QUESTIONS = form(`
    ${STANDARD}
    ${LOCATION}
    ${EDUCATION}
    ${select('question_9000201', 'How did you hear about this role?', true)}
    ${select('question_9000202', 'Placeholder favourite colours', false, true)}
    ${EEOC}
    ${DEMOGRAPHIC}`);

/** Posting A: the standard fields, the resume, and one required choice. */
export const FEW_QUESTIONS = form(`
    ${STANDARD}
    ${select('question_9000001', 'Are you able to work from the placeholder office?', true)}`);

/** Posting B: many custom questions in the recorded order, then self-identification. */
export const MANY_QUESTIONS = form(`
    ${STANDARD}
    ${text('question_9000101', 'Preferred First Name')}
    ${text('question_9000102', 'Website')}
    ${select('question_9000103', 'Which placeholder team would you most like to join first?', true)}
    ${text('question_9000104', 'What is your placeholder notice period?')}
    ${text('question_9000105', 'Which placeholder city do you live in today?')}
    ${select('question_9000106', 'Do you need sponsorship?', true)}
    ${area('question_9000107', 'Why us?', true)}
    ${select('question_9000108', 'How did you hear about us?', true)}
    ${area('question_9000109', 'Anything else?')}
    ${text('question_9000110', 'LinkedIn Profile')}
    ${text('question_9000111', 'Website URL')}
    ${EEOC}`);

export interface LoadedForm {
  window: Window;
  doc: Document;
  /** Every event dispatched on the form or inside it, in order. */
  events: { type: string; target: string; ctor: string; bubbles: boolean }[];
  /** Plain assignments to `.value` that the controlled stand-in swallowed. */
  ignoredAssignments: string[];
  /**
   * The page's own timers, with `timers: 'manual'`: how many are pending, and fire them all. A
   * filler's bounded wait can then be ended without waiting for it in real time.
   */
  timers: { pending: () => number; ids: () => number[]; fire: (only?: number[]) => void };
  /** How many MutationObservers on the page are observing and not yet disconnected. */
  observing: () => number;
}

/** Event types a filler must never cause, recorded alongside input and change. */
const WATCHED = [
  'input',
  'change',
  'beforeinput',
  'keydown',
  'keypress',
  'keyup',
  'mousedown',
  'mouseup',
  'click',
  'pointerdown',
  'pointerup',
  'focus',
  'blur',
  'focusin',
  'focusout',
  'submit',
  'drop',
  'paste',
];

/**
 * The page at `url` (the posting by default), with every text input and textarea controlled the
 * way React's value tracker makes it: a plain `.value =` from script is ignored, only the
 * prototype's native setter changes what the form holds. `showsFileName` stands in for the
 * form's own handler on #resume, which renders the chosen file's name: after a microtask, or
 * after a macrotask with 'macrotask' (as React 19 does, qa on #187); false leaves it unshown.
 */
export function loadForm(
  html: string,
  opts: { url?: string; showsFileName?: boolean | 'macrotask'; timers?: 'manual' } = {},
): LoadedForm {
  const window = new Window({
    url: opts.url ?? POSTING_URL,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
    },
  });
  window.document.write(html);
  const doc = window.document as unknown as Document;
  const events: LoadedForm['events'] = [];
  const ignoredAssignments: string[] = [];
  for (const type of WATCHED) {
    doc.addEventListener(
      type,
      (e) => {
        const target = e.target as Element | null;
        events.push({
          type: e.type,
          target: target?.id ?? '',
          ctor: e.constructor.name,
          bubbles: e.bubbles,
        });
      },
      true,
    );
  }
  const inputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!;
  const areaValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!;
  for (const el of Array.from(doc.querySelectorAll('input, textarea'))) {
    if ((el.getAttribute('type') ?? '') === 'file') continue;
    const native = el.tagName === 'TEXTAREA' ? areaValue : inputValue;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get(this: HTMLInputElement) {
        return native.get!.call(this) as string;
      },
      set(this: HTMLInputElement) {
        ignoredAssignments.push(this.id);
      },
    });
  }
  const input = doc.getElementById('resume') as HTMLInputElement | null;
  if (input !== null && (opts.showsFileName ?? true)) {
    input.addEventListener('change', () => {
      const name = input.files?.[0]?.name ?? '';
      const render = () => {
        doc.querySelector('.file-upload__filename')!.textContent = name;
      };
      // React 19 renders it after a macrotask (qa on #187); a microtask otherwise.
      if (opts.showsFileName === 'macrotask') window.setTimeout(render, 0);
      else queueMicrotask(render);
    });
  }
  const pending = new Map<number, () => void>();
  let nextTimer = 1;
  if (opts.timers === 'manual') {
    const page = window as unknown as {
      setTimeout: (fn: () => void) => number;
      clearTimeout: (id: number) => void;
    };
    page.setTimeout = (fn: () => void) => {
      const id = nextTimer;
      nextTimer += 1;
      pending.set(id, fn);
      return id;
    };
    page.clearTimeout = (id: number) => {
      pending.delete(id);
    };
  }
  const timers = {
    pending: () => pending.size,
    ids: () => [...pending.keys()],
    fire: (only?: number[]) => {
      const due = [...pending.entries()].filter(([id]) => only === undefined || only.includes(id));
      for (const [id] of due) pending.delete(id);
      for (const [, fn] of due) fn();
    },
  };
  // Every observer the page makes, counted while it observes.
  const live = new Set<MutationObserver>();
  const page = window as unknown as { MutationObserver: typeof MutationObserver };
  const NativeObserver = page.MutationObserver;
  page.MutationObserver = class extends NativeObserver {
    override observe(target: Node, options?: MutationObserverInit): void {
      live.add(this);
      super.observe(target, options);
    }
    override disconnect(): void {
      live.delete(this);
      super.disconnect();
    }
  };
  return { window, doc, events, ignoredAssignments, timers, observing: () => live.size };
}

/** How a stand-in list behaves (tl's structure check and addendum on #402). */
export interface ListBehaviour {
  /** The options the list's service gives for the text the box holds when asked. */
  options: (search: string) => string[];
  /**
   * When they come: at once; late (first `early`, then the rest after a real 20 ms, as Location
   * and the education lists answer more than once); or never (only `early`).
   */
  arrive?: 'now' | 'late' | 'never';
  early?: string[];
  /** false: a mouseup does nothing, and the list never opens. */
  opens?: boolean;
  /** false: the list opens (aria-expanded "true") but aria-controls is never set. */
  setsControls?: boolean;
  /** Names this in aria-controls instead of its own listbox. */
  controls?: string;
  /** What the control shows once an option is chosen (by default, its text). */
  shows?: (option: string) => string;
  /** A flag beside the shown value, with this aria-label (the phone's country). */
  flag?: (option: string) => string;
  /** How each option is marked up (refusal tests); by default a div with role="option". */
  optionMarkup?: 'option' | 'link' | 'button' | 'no-role';
  /** The form shows nothing after a choice. */
  ignoresChoice?: boolean;
  /**
   * When the choice is shown after the click: at once, after a microtask (as React 18 applies a
   * click's update on a concurrent root), or after a macrotask.
   */
  renders?: 'sync' | 'microtask' | 'macrotask';
}

/**
 * A react-select stand-in on the control `id`, as the form's scripts behave (tl's structure check
 * on #402): its list opens and closes on a mouseup on the search box, never on an input event;
 * while open, the box names the list in aria-controls; the list asks its service for the text the
 * box holds when it opens, and again on each input while open; a click on an option shows it,
 * sets the hidden required input, empties the box and closes the list.
 */
export function standInList(page: LoadedForm, id: string, b: ListBehaviour) {
  const { doc, window } = page;
  const box = doc.getElementById(id) as HTMLInputElement;
  const shell = box.closest('.select-shell')!;
  const holder = box.closest('.select__value-container')!;
  const native = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!;
  const listId = `react-select-${id}-listbox`;
  /** Each text the list's service was asked for, in order. */
  const asked: string[] = [];
  let menu: Element | null = null;
  const pick = (option: string): void => {
    const when = b.renders ?? 'sync';
    if (when === 'microtask') queueMicrotask(() => show(option));
    else if (when === 'macrotask') setTimeout(() => show(option), 0);
    else show(option);
  };
  const show = (option: string): void => {
    if (b.ignoresChoice !== true) {
      holder.querySelector('.select__placeholder')?.remove();
      const shown = doc.createElement('div');
      shown.className = 'select__single-value';
      if (b.flag !== undefined) {
        const flag = doc.createElement('span');
        flag.className = 'flag';
        flag.setAttribute('aria-label', b.flag(option));
        shown.append(flag);
      }
      shown.append((b.shows ?? ((o: string) => o))(option));
      holder.prepend(shown);
      const required = shell.parentElement?.querySelector(`[class="${id}-requiredInput"]`);
      if (required) native.set!.call(required, option);
    }
    native.set!.call(box, '');
    close();
  };
  const render = (texts: string[]): void => {
    const list = menu?.firstElementChild;
    if (!list) return;
    list.replaceChildren(
      ...texts.map((t, i) => {
        const markup = b.optionMarkup ?? 'option';
        const el = doc.createElement(
          markup === 'link' ? 'a' : markup === 'button' ? 'button' : 'div',
        );
        if (markup !== 'no-role') el.setAttribute('role', 'option');
        el.id = `react-select-${id}-option-${i}`;
        el.textContent = t;
        el.addEventListener('click', () => pick(t));
        return el;
      }),
    );
  };
  const ask = (): void => {
    const search = native.get!.call(box) as string;
    asked.push(search);
    const all = b.options(search);
    const arrive = b.arrive ?? 'now';
    if (arrive === 'now') render(all);
    else {
      render(b.early ?? []);
      if (arrive === 'late') setTimeout(() => render(all), 20);
    }
  };
  const open = (): void => {
    if (b.opens === false) return;
    menu = doc.createElement('div');
    menu.className = 'select__menu';
    const list = doc.createElement('div');
    list.id = listId;
    list.setAttribute('role', 'listbox');
    menu.append(list);
    shell.append(menu);
    box.setAttribute('aria-expanded', 'true');
    if (b.setsControls !== false) box.setAttribute('aria-controls', b.controls ?? listId);
    ask();
  };
  const close = (): void => {
    menu?.remove();
    menu = null;
    box.setAttribute('aria-expanded', 'false');
    box.removeAttribute('aria-controls');
  };
  box.addEventListener('mouseup', () => (menu === null ? open() : close()));
  box.addEventListener('input', () => {
    if (menu !== null) ask();
  });
  return { asked, isOpen: () => menu !== null, box };
}

/** The value the form holds, read through the native getter. */
export const valueOf = (doc: Document, id: string): string =>
  (doc.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value;
