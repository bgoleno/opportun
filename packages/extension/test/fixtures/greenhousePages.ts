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

const text = (id: string, label: string, required = false, type = 'text', extra = '') => `
    <div class="field-wrapper">
      <div class="input-wrapper">
        <div class="text-input-wrapper">
          <label id="${id}-label" for="${id}">${label}${required ? '<span aria-hidden="true">*</span>' : ''}</label>
          <input id="${id}" class="input input__single-line" type="${type}" maxlength="255"
            aria-describedby="${id}-description" ${extra} />
        </div>
      </div>
    </div>`;

const area = (id: string, label: string, required = false) => `
    <div class="field-wrapper">
      <div class="input-wrapper">
        <label id="${id}-label" for="${id}">${label}${required ? '<span aria-hidden="true">*</span>' : ''}</label>
        <textarea id="${id}" class="input input__multi-line" rows="4"
          aria-describedby="${id}-description" ${required ? 'aria-required="true"' : ''}></textarea>
      </div>
    </div>`;

/** A react-select: a combobox whose options are not in the page until its menu opens. */
const select = (id: string, label: string, required = false) => `
    <div class="field-wrapper">
      <div class="select">
        <div class="select__container">
          <label id="${id}-label" for="${id}">${label}${required ? '<span aria-hidden="true">*</span>' : ''}</label>
          <div class="select-shell">
            <input id="${id}" class="select__input" role="combobox" aria-autocomplete="list"
              aria-haspopup="true" aria-expanded="false" value="" />
          </div>
          ${required ? `<input class="${id}-requiredInput" aria-hidden="true" tabindex="-1" value="" />` : ''}
        </div>
      </div>
    </div>`;

const STANDARD = `
    <fieldset>
      <legend>Apply</legend>
      ${text('first_name', 'First Name', true, 'text', 'autocomplete="given-name"')}
      ${text('last_name', 'Last Name', true, 'text', 'autocomplete="family-name"')}
      ${text('email', 'Email', true, 'text', 'autocomplete="email"')}
      ${select('country', 'Country', true)}
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

const form = (body: string) => `<!doctype html><html><body><main>
  <h1>Placeholder Engineer</h1>
  <form id="application-form" class="application--form" method="get" action="/${BOARD}/jobs/${JOB_ID}">
    ${body}
    ${CAPTCHA_AND_SUBMIT}
  </form>
</main></body></html>`;

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
    <h2>Voluntary Self-Identification</h2>
    ${select('gender', 'Gender')}
    ${select('hispanic_ethnicity', 'Are you Hispanic/Latino?')}
    ${select('veteran_status', 'Veteran Status')}`);

export interface LoadedForm {
  window: Window;
  doc: Document;
  /** Every event dispatched on the form or inside it, in order. */
  events: { type: string; target: string; ctor: string; bubbles: boolean }[];
  /** Plain assignments to `.value` that the controlled stand-in swallowed. */
  ignoredAssignments: string[];
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
  opts: { url?: string; showsFileName?: boolean | 'macrotask' } = {},
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
  return { window, doc, events, ignoredAssignments };
}

/** The value the form holds, read through the native getter. */
export const valueOf = (doc: Document, id: string): string =>
  (doc.getElementById(id) as HTMLInputElement | HTMLTextAreaElement).value;
