// The popup's behavior, with every browser API injected (popup.ts wires the real ones), so it
// runs under happy-dom in tests. The page is read only inside the Capture click handler (C-1).
import { postCapture, testConnection, type FetchLike, type Outcome } from './api';
import { captureSiteOf, indeedJobKey, type CaptureSiteId } from './canonical';
import {
  fetchConfirmable,
  postConfirmation,
  renderConfirmation,
  type ReadPage,
} from './confirmation';
import type { ExtractResult } from './extract';
import type { FillPlan, FillReport, NotFilledReason, ResumeCheck } from './greenhouseFill';
import { normalizeCapture } from './normalize';
import {
  buildPlan,
  fetchCurrent,
  fetchResume,
  greenhouseJobOf,
  RESUME_CHECKS,
  RESUME_GAP_MS,
  type GetLike,
  type PrefillAttempt,
  renderPrefillStop,
  reportLines,
  samePosting,
} from './prefill';
import { renderOutcome, type Rendered } from './render';
import {
  loadSettings,
  originPattern,
  parseServerUrl,
  isDeviceToken,
  saveSettings,
  type Settings,
  type SettingsStorage,
} from './settings';

export interface PopupDeps {
  storage: SettingsStorage;
  /**
   * The extension's session storage (storage.session: this browser session only, never synced),
   * or null where the browser has none. It holds one note while the resume check runs, so a
   * popup that closed before the check ended can be told about by the next one (#191).
   */
  checkStore: SettingsStorage | null;
  /** The address this copy was downloaded from, '' for a build made from source (design D9). */
  bakedServerUrl: () => Promise<string>;
  fetch: FetchLike;
  /** GET on the user's server, for assisted apply's reads (prefill.ts). */
  get: GetLike;
  /** The tab the popup was opened over (tabs.query active + currentWindow). */
  activeTab(): Promise<{ id: number; url: string | undefined } | null>;
  /**
   * Runs the site's reader once in that tab (scripting.executeScript): extractPage on LinkedIn,
   * extractIndeedJob on Indeed. `site` comes from the tab's URL alone, never from page content.
   * Null when the injection itself failed.
   */
  runExtract(tabId: number, site: CaptureSiteId): Promise<ExtractResult | null>;
  /**
   * Runs the Greenhouse filler once in that tab's top frame (scripting.executeScript, assisted
   * apply prefill, #183), with the plan as its only argument. Null when the injection failed.
   */
  runFill(tabId: number, plan: FillPlan): Promise<FillReport | null>;
  /** Runs resumeShown once in that tab's top frame (read only): the name's count, or null. */
  runResumeCheck(tabId: number, check: ResumeCheck): Promise<number | null>;
  /** Runs clearResume once in that tab's top frame; null when the injection failed. */
  runResumeClear(
    tabId: number,
    check: ResumeCheck & { size: number; before: number },
  ): Promise<'cleared' | 'shown' | 'kept' | 'empty' | 'wrong_page' | 'no_input' | null>;
  /**
   * Runs readConfirmationPage once in that tab's top frame (read only, no args): the page's text
   * for "Record confirmation page" (#121). Null when the injection failed.
   */
  runReadPage(tabId: number): Promise<ReadPage | null>;
  /** The popup's own timer between resume checks (the page side keeps none). */
  wait(ms: number): Promise<void>;
  /** permissions.request for one origin pattern; must be called inside the click gesture. */
  requestOrigin(pattern: string): Promise<boolean>;
  /** permissions.contains for one origin pattern. */
  hasOrigin(pattern: string): Promise<boolean>;
}

const SERVER_URL_ERRORS = {
  invalid: 'Enter the server address, for example https://opportun.example.com.',
  insecure:
    'Use https for the server. Plain http works only on a private network: localhost, a .local, .lan or .home.arpa name, a name with no dots, or a private address such as 192.168.1.10.',
  ipv6: 'An IPv6 address cannot be used here. Use the hostname instead.',
} as const;
const TOKEN_ERROR = 'Paste a device token (it starts with odt_).';
const SERVER_CHANGED = 'Server changed: re-enter the token for the new server.';

/**
 * The note left while the resume check runs (#191): which tab and posting, and since when. One
 * key per tab (tl on #202), so a fill in another window never overwrites an unfinished note.
 */
const checkPendingKey = (tabId: number): string => `resumeCheckPending:${tabId}`;
/** A note older than this is not about the fill the user remembers: it is dropped silently. */
const CHECK_PENDING_MAX_AGE_MS = 60 * 60 * 1000;
export const RESUME_CHECKING =
  'Checking that the form shows your resume. Keep this window open until it finishes (about 2 seconds).';
export const RESUME_UNCONFIRMED =
  'Your resume was not confirmed: this window closed before the check finished. Look at the form, and attach your resume yourself if it is not shown there.';
const KEEP_OPEN =
  'Keep this window open until the report shows (up to a few seconds for each list).';
/** While the filler runs: it waits for each list it chooses in (#402 slice 2, tl's rule 4). */
export const FILLING = `Filling in the form. ${KEEP_OPEN}`;
/**
 * While a fill started by opening the popup runs (#403 slice 2, sec's condition 4): what is being
 * filled, said before the report, with the same advice as FILLING.
 */
export const fillingFor = (title: string, company: string, host: string): string =>
  `Filling the application for ${title} at ${company} on ${host}. ${KEEP_OPEN}`;
export const FILL_UNSEEN =
  "The last fill's result was not seen: this window closed before it finished. Check every field on the form, and choose or fill in yourself anything that is wrong or empty.";

/**
 * `stage` says what was unfinished: the fill itself (#402 slice 2) or the resume check after it.
 * A note from before slice 2 has none, and was left by the resume check.
 */
interface CheckPending {
  tabId: number;
  board: string;
  jobId: string;
  at: number;
  stage?: 'fill' | 'resume';
}

function isCheckPending(v: unknown): v is CheckPending {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<CheckPending>;
  return (
    typeof p.tabId === 'number' &&
    typeof p.board === 'string' &&
    typeof p.jobId === 'string' &&
    typeof p.at === 'number' &&
    (p.stage === undefined || p.stage === 'fill' || p.stage === 'resume')
  );
}

/** An https page, the only kind a confirmation page can be (the server's rule too). */
function isHttpsPage(href: string): boolean {
  try {
    return new URL(href).protocol === 'https:';
  } catch {
    return false;
  }
}

function element<T extends HTMLElement>(doc: Document, id: string): T {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`popup.html is missing #${id}`);
  return el as T;
}

/**
 * Renders a setup failure visibly (issue #80). Everything before mountPopup's click listeners
 * attach runs once, outside any of them, so busy()'s "Something went wrong. Try again." can
 * never catch a failure here: that message only wraps work done after a click, and no listener
 * exists yet to be clicked. Looked up independently of whatever mountPopup itself got through
 * before failing, so this still renders even when the very first element lookup is what threw.
 */
function reportStartupFailure(doc: Document, err: unknown): void {
  console.error('Opportun Capture: the popup failed to start.', err);
  const status = doc.getElementById('status');
  if (status !== null) {
    status.dataset.tone = 'error';
    status.textContent =
      'The popup failed to start. Reload the extension at chrome://extensions and try again; ' +
      'if it keeps happening, this is a bug worth reporting.';
  }
  for (const id of ['capture', 'save', 'test', 'prefill', 'record']) {
    const button = doc.getElementById(id) as HTMLButtonElement | null;
    if (button !== null) button.disabled = true;
  }
}

export async function mountPopup(doc: Document, deps: PopupDeps): Promise<void> {
  try {
    await setupPopup(doc, deps);
  } catch (err) {
    reportStartupFailure(doc, err);
  }
}

async function setupPopup(doc: Document, deps: PopupDeps): Promise<void> {
  const form = element<HTMLFormElement>(doc, 'settings');
  const serverInput = element<HTMLInputElement>(doc, 'server-url');
  const tokenInput = element<HTMLInputElement>(doc, 'token');
  const panel = element<HTMLDetailsElement>(doc, 'settings-panel');
  const status = element<HTMLElement>(doc, 'status');
  const buttons = ['capture', 'save', 'test', 'prefill', 'record'].map((id) =>
    element<HTMLButtonElement>(doc, id),
  );
  const [captureButton, , testButton, prefillButton, recordButton] = buttons as [
    HTMLButtonElement,
    HTMLButtonElement,
    HTMLButtonElement,
    HTMLButtonElement,
    HTMLButtonElement,
  ];
  const assist = element<HTMLElement>(doc, 'assist');
  const confirm = element<HTMLElement>(doc, 'confirm');
  const report = element<HTMLElement>(doc, 'prefill-report');

  const show = ({ tone, text }: Rendered): void => {
    status.dataset.tone = tone;
    status.textContent = text;
  };
  const showOutcome = (o: Outcome, site?: CaptureSiteId): void => show(renderOutcome(o, site));

  /** Disables the buttons while `work` runs; a thrown error is shown, never swallowed. */
  const busy = async (work: () => Promise<void>): Promise<void> => {
    for (const b of buttons) b.disabled = true;
    status.textContent = '';
    report.replaceChildren();
    try {
      await work();
    } catch {
      show({ tone: 'error', text: 'Something went wrong. Try again.' });
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  };

  /** Stored settings that are complete and whose server we may contact, or why not. */
  const ready = async (): Promise<Settings | Outcome> => {
    const s = await loadSettings(deps.storage, await deps.bakedServerUrl());
    if (s.serverUrl === '' || s.token === '') return { kind: 'no_settings' };
    if (!(await deps.hasOrigin(originPattern(s.serverUrl)))) return { kind: 'permission_denied' };
    return s;
  };
  const isOutcome = (v: Settings | Outcome): v is Outcome => 'kind' in v;

  // What is stored, kept in memory so Save can validate synchronously (see below). Read without
  // the baked address (issue #79): that read can be slow (bounded, but still up to
  // BAKED_CONFIG_TIMEOUT_MS) or hang outright, and the UI below must not wait on it to become
  // usable. A saved address always wins over the baked one anyway, so skipping it here changes
  // nothing for anyone who already has one.
  let stored = await loadSettings(deps.storage);
  serverInput.value = stored.serverUrl;
  // The token is never put back into the page: a placeholder says one is saved.
  if (stored.token !== '') tokenInput.placeholder = 'Saved (paste a new one to replace it)';
  panel.open = stored.serverUrl === '' || stored.token === '';

  const originOf = (base: string): string => (base === '' ? '' : new URL(base).origin);

  /**
   * The origin pattern this browser already granted, so Save can tell synchronously whether a
   * prompt is needed. Chrome closes the popup whenever a host-permission prompt opens, so a
   * prompt we did not need throws the window away under the user (issue #49). A failure here
   * only costs one needless prompt, so it must never stop the listeners below from attaching.
   */
  const heldPattern = async (base: string): Promise<string | null> => {
    if (base === '') return null;
    const pattern = originPattern(base);
    try {
      return (await deps.hasOrigin(pattern)) ? pattern : null;
    } catch {
      return null;
    }
  };
  let grantedPattern = await heldPattern(stored.serverUrl);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Everything is validated synchronously: the permission prompt must open inside the click
    // gesture (no await before it), and it should not open for input that cannot be saved.
    const server = parseServerUrl(serverInput.value);
    if (!server.ok) {
      show({ tone: 'error', text: SERVER_URL_ERRORS[server.error] });
      return;
    }
    let token = tokenInput.value.trim();
    if (token === '' && stored.token !== '') {
      // A blank field keeps the saved token, but only for the server it was issued by: a
      // token is never sent to a different origin than the one it was saved with.
      if (originOf(stored.serverUrl) !== originOf(server.base)) {
        show({ tone: 'error', text: SERVER_CHANGED });
        return;
      }
      token = stored.token;
    }
    if (!isDeviceToken(token)) {
      show({ tone: 'error', text: TOKEN_ERROR });
      return;
    }
    const pattern = originPattern(server.base);
    // Ask only for a permission we do not already hold, and ask inside the gesture.
    const granted =
      pattern === grantedPattern ? Promise.resolve(true) : deps.requestOrigin(pattern);
    const previous = stored;
    void busy(async () => {
      // The write goes first. Chrome tears this popup down when it opens the permission
      // prompt, and everything after that await is simply lost, which is how a saved token
      // used to vanish while the permission it asked for was granted (issue #49). A decline
      // is rolled back below, so refusing still leaves no token behind.
      const saved = await saveSettings(deps.storage, { serverUrl: server.base, token });
      if (!saved.ok) {
        show({
          tone: 'error',
          text: saved.field === 'token' ? TOKEN_ERROR : SERVER_URL_ERRORS[saved.error],
        });
        return;
      }
      stored = saved.settings;
      serverInput.value = saved.settings.serverUrl;
      tokenInput.value = '';
      tokenInput.placeholder = 'Saved (paste a new one to replace it)';
      if (!(await granted)) {
        grantedPattern = null;
        // Only an explicit refusal reaches this line: a popup Chrome closed never runs it, so
        // the write above survives exactly the case it was moved for.
        await deps.storage.set({ serverUrl: previous.serverUrl, token: previous.token });
        stored = previous;
        serverInput.value = previous.serverUrl;
        tokenInput.placeholder =
          previous.token === '' ? 'odt_...' : 'Saved (paste a new one to replace it)';
        showOutcome({ kind: 'permission_denied' });
        return;
      }
      grantedPattern = pattern;
      show({ tone: 'success', text: 'Settings saved.' });
    });
  });

  testButton.addEventListener('click', () => {
    void busy(async () => {
      const s = await ready();
      showOutcome(isOutcome(s) ? s : await testConnection(deps.fetch, s));
    });
  });

  captureButton.addEventListener('click', () => {
    void busy(async () => {
      const s = await ready();
      if (isOutcome(s)) {
        showOutcome(s);
        return;
      }
      const tab = await deps.activeTab();
      // Only LinkedIn and Indeed tabs are read, decided from the tab's URL: any other page stays
      // untouched and unsent.
      const site = tab?.url === undefined ? null : captureSiteOf(tab.url);
      if (tab === null || tab.url === undefined || site === null) {
        showOutcome({ kind: 'unsupported_tab' });
        return;
      }
      // An Indeed tab is read only when its URL names one posting (issue #74): there is no
      // canonical URL to send otherwise, so the page is left alone.
      if (site === 'indeed' && indeedJobKey(tab.url) === null) {
        showOutcome({ kind: 'not_a_posting' }, site);
        return;
      }
      const read = await deps.runExtract(tab.id, site);
      if (read === null) {
        showOutcome({ kind: 'inject_failed' }, site);
        return;
      }
      if (!read.ok) {
        showOutcome({ kind: read.reason }, site);
        return;
      }
      // An Indeed page may have moved on since the click (a link followed in the tab): what is
      // sent must still be one posting, since its URL is what the server keys the job by.
      // LinkedIn keeps its behaviour from before Indeed (the server refuses what it cannot read).
      if (site === 'indeed' && indeedJobKey(read.page.url) === null) {
        showOutcome({ kind: 'not_a_posting' }, site);
        return;
      }
      const normalized = normalizeCapture(read.page);
      if (!normalized.ok) {
        showOutcome({ kind: normalized.error }, site);
        return;
      }
      showOutcome(await postCapture(deps.fetch, s, normalized.payload), site);
    });
  });

  /**
   * The prefill report, built with textContent only: labels come from the page, so they are
   * never markup here.
   */
  const showReport = (lines: ReturnType<typeof reportLines>): void => {
    const list = (title: string, items: string[]): void => {
      if (items.length === 0) return;
      const heading = doc.createElement('h3');
      heading.textContent = title;
      const ul = doc.createElement('ul');
      for (const item of items) {
        const li = doc.createElement('li');
        li.textContent = item;
        ul.append(li);
      }
      report.append(heading, ul);
    };
    list('Chosen from a list: check each before you submit', lines.chosen);
    list('Filled in', lines.filled);
    list('Not filled in', lines.notFilled);
  };

  /**
   * Fills the tab from the handed-off attempt and shows the report: the one path for the button
   * and for opening the popup on the posting (#403 slice 2), so every check the button makes
   * (the pinned posting, a stale review, the resume) holds for both. `filling` is the line shown
   * while the filler runs.
   */
  const fillAttempt = async (
    tab: { id: number },
    posting: { board: string; jobId: string },
    s: Settings,
    attempt: PrefillAttempt,
    filling: string,
  ): Promise<void> => {
    // The server matched the page to the attempt; the popup checks again against the pinned
    // destination itself, so a wrong answer can never fill another posting (acceptance 4).
    const pinned = greenhouseJobOf(attempt.destinationUrl);
    if (pinned === null || !samePosting(pinned, posting)) {
      show(renderPrefillStop({ kind: 'other_posting', destinationUrl: attempt.destinationUrl }));
      return;
    }
    const resume = await fetchResume(deps.get, s, attempt);
    if (resume.kind === 'review_stale') {
      show(renderPrefillStop({ kind: 'none', reason: 'review_stale' }));
      return;
    }
    const plan = buildPlan(attempt, pinned, resume.kind === 'file' ? resume.base64 : null);
    // The fill now waits for each list (#402 slice 2): say so, and leave a note for the next
    // popup on this tab in case this one closes before the report arrives.
    show({ tone: 'info', text: filling });
    const fillNote: CheckPending = {
      tabId: tab.id,
      board: pinned.board,
      jobId: pinned.jobId,
      at: Date.now(),
      stage: 'fill',
    };
    await deps.checkStore?.set({ [checkPendingKey(tab.id)]: fillNote }).catch(() => undefined);
    const filled = await deps.runFill(tab.id, plan);
    // The report is here (or the run failed, which the popup says now): the note is done.
    await deps.checkStore?.set({ [checkPendingKey(tab.id)]: null }).catch(() => undefined);
    if (filled === null) {
      show(renderPrefillStop({ kind: 'inject_failed' }));
      return;
    }
    if (!filled.ok) {
      show(renderPrefillStop({ kind: filled.reason }));
      return;
    }
    // The resume: confirmed here, not in the page (tl and sec on #187). Look for its name a
    // bounded number of times; if it never shows, take back exactly our file.
    const report = {
      ...filled,
      chosen: [...filled.chosen],
      filled: [...filled.filled],
      notFilled: [...filled.notFilled],
    };
    if (filled.resume !== null) {
      show({ tone: 'info', text: RESUME_CHECKING });
      // A popup closes when it loses focus, and this check would end with it, leaving the
      // file set and unconfirmed (sec on #187). The note says so to the next popup on this
      // tab, and is cleared once the check has its answer. Popup storage only: nothing new
      // runs in the page, and there is still no background worker (#191).
      const note: CheckPending = {
        tabId: tab.id,
        board: pinned.board,
        jobId: pinned.jobId,
        at: Date.now(),
        stage: 'resume',
      };
      await deps.checkStore?.set({ [checkPendingKey(tab.id)]: note }).catch(() => undefined);
      const check: ResumeCheck = {
        board: pinned.board,
        jobId: pinned.jobId,
        filename: filled.resume.filename,
      };
      let outcome: 'shown' | 'gone' | 'unseen' = 'unseen';
      for (let i = 0; i < RESUME_CHECKS; i += 1) {
        if (i > 0) await deps.wait(RESUME_GAP_MS);
        const count = await deps.runResumeCheck(tab.id, check);
        if (count === null) {
          outcome = 'gone';
          break;
        }
        if (count > filled.resume.before) {
          outcome = 'shown';
          break;
        }
      }
      let reason: NotFilledReason | null = null;
      if (outcome === 'gone') reason = 'resume_unchecked';
      if (outcome === 'unseen') {
        const cleared = await deps.runResumeClear(tab.id, {
          ...check,
          size: filled.resume.size,
          before: filled.resume.before,
        });
        // Shown at the last moment: attached. Taken back out, or already empty: attach it
        // yourself. Another file (the user's): left. Anything else: look at it yourself.
        reason =
          cleared === 'shown'
            ? null
            : cleared === 'cleared' || cleared === 'empty'
              ? 'attach_yourself'
              : cleared === 'kept'
                ? 'has_value'
                : 'resume_unchecked';
      }
      await deps.checkStore?.set({ [checkPendingKey(tab.id)]: null }).catch(() => undefined);
      if (reason === null) report.filled.push('Resume');
      else report.notFilled.push({ label: 'Resume', reason });
    }
    const lines = reportLines(report);
    show({ tone: 'info', text: lines.reminder });
    showReport(lines);
  };

  prefillButton.addEventListener('click', () => {
    void busy(async () => {
      const s = await ready();
      if (isOutcome(s)) {
        showOutcome(s);
        return;
      }
      // Decided from the tab's address alone: any other tab is neither asked about nor touched.
      const tab = await deps.activeTab();
      const posting = tab?.url === undefined ? null : greenhouseJobOf(tab.url);
      if (tab === null || tab.url === undefined || posting === null) {
        show(renderPrefillStop({ kind: 'not_greenhouse' }));
        return;
      }
      const current = await fetchCurrent(deps.get, s, tab.url);
      if (current.kind !== 'attempt') {
        show(renderPrefillStop(current));
        return;
      }
      await fillAttempt(tab, posting, s, current.attempt, FILLING);
    });
  });

  // "Record confirmation page" (#121): ask which application, then read the page once, then
  // send it with the tab's own address. The server checks everything again on the POST.
  recordButton.addEventListener('click', () => {
    void busy(async () => {
      const s = await ready();
      if (isOutcome(s)) {
        showOutcome(s);
        return;
      }
      const tab = await deps.activeTab();
      if (tab === null || tab.url === undefined || !isHttpsPage(tab.url)) {
        show(renderConfirmation({ kind: 'not_a_page' }));
        return;
      }
      // A second guard for C-1 (sec on https://github.com/bgoleno/opportun/pull/199): a capture
      // site is neither asked about nor read here; the server never matches it either.
      if (captureSiteOf(tab.url) !== null) {
        show(renderConfirmation({ kind: 'capture_site' }));
        return;
      }
      const found = await fetchConfirmable(deps.get, s, tab.url);
      if (found.kind !== 'attempt') {
        show(renderConfirmation(found));
        return;
      }
      const read = await deps.runReadPage(tab.id);
      if (read === null) {
        show(renderConfirmation({ kind: 'inject_failed' }));
        return;
      }
      // The page's own address is compared, never sent: a tab that moved since the lookup is
      // not recorded (the server would check the address sent, which is the tab's).
      if (read.href !== tab.url) {
        show(renderConfirmation({ kind: 'moved' }));
        return;
      }
      if (read.text.trim() === '') {
        show(renderConfirmation({ kind: 'empty' }));
        return;
      }
      const sent = await postConfirmation(deps.fetch, s, found.id, {
        url: tab.url,
        title: read.title,
        text: read.text,
      });
      show(renderConfirmation(sent, `${found.opportunityTitle} at ${found.companyName}`));
    });
  });

  /**
   * A resume check that a closed popup left unfinished on this tab's posting (#191): said once,
   * then forgotten. Another tab's note is under its own key, for that tab's popup; one older than
   * an hour, or for another page now, is dropped without a word.
   */
  const tellUnfinishedCheck = async (
    tabId: number | null,
    posting: { board: string; jobId: string } | null,
  ): Promise<void> => {
    if (deps.checkStore === null || tabId === null) return;
    const key = checkPendingKey(tabId);
    // Only this tab's key is asked for, so the one value back is its note, if any.
    const [note] = Object.values(await deps.checkStore.get([key]));
    if (!isCheckPending(note)) return;
    await deps.checkStore.set({ [key]: null });
    if (note.tabId !== tabId || Date.now() - note.at > CHECK_PENDING_MAX_AGE_MS) return;
    if (posting !== null && samePosting(posting, note)) {
      show({ tone: 'error', text: note.stage === 'fill' ? FILL_UNSEEN : RESUME_UNCONFIRMED });
    }
  };

  /**
   * Opening the popup over the handed-off posting fills it (#403 slice 2, tl's note with sec's
   * conditions 1 to 5): only over a Greenhouse posting (the tab's address alone decides, and
   * nothing in the page is read for it), only with settings saved, and only when the server says
   * this is the first read of an attempt pinned to this posting. Anything else, a failed lookup
   * included, leaves the popup as it was, with the button and no message.
   */
  const fillOnOpen = async (
    tab: { id: number; url: string },
    posting: { board: string; jobId: string },
  ): Promise<void> => {
    try {
      const s = await ready();
      if (isOutcome(s)) return;
      const current = await fetchCurrent(deps.get, s, tab.url);
      if (current.kind !== 'attempt' || !current.attempt.firstRead) return;
      const { attempt } = current;
      // fillAttempt checks the pinned posting again; checked here too, so another posting is
      // left without a word rather than told why on a popup the user only opened.
      const pinned = greenhouseJobOf(attempt.destinationUrl);
      if (pinned === null || !samePosting(pinned, posting)) return;
      const filling = fillingFor(
        attempt.opportunityTitle,
        attempt.companyName,
        new URL(tab.url).host,
      );
      await busy(() => fillAttempt(tab, posting, s, attempt, filling));
    } catch {
      // Opening the popup is not a request for anything: a failure here says nothing.
    }
  };

  // The Assisted apply section shows only over a Greenhouse posting tab: decided from the tab's
  // address, which the popup already knows; nothing in the page is read for it.
  void (async () => {
    let opened: {
      tab: { id: number; url: string };
      posting: { board: string; jobId: string };
    } | null = null;
    try {
      const tab = await deps.activeTab();
      const posting = tab?.url === undefined ? null : greenhouseJobOf(tab.url);
      assist.hidden = posting === null;
      // Any https page may be a thank-you page; which one counts is the server's to say.
      confirm.hidden = tab?.url === undefined || !isHttpsPage(tab.url);
      await tellUnfinishedCheck(tab?.id ?? null, posting);
      if (tab !== null && tab.url !== undefined && posting !== null) {
        opened = { tab: { id: tab.id, url: tab.url }, posting };
      }
    } catch {
      assist.hidden = true;
      confirm.hidden = true;
    }
    if (opened !== null) await fillOnOpen(opened.tab, opened.posting);
  })();

  // Fills an empty address field from the download's baked config, once that read finishes, but
  // never before the listeners above are already attached and never over something the person
  // has since typed (issue #79). Skipped entirely when a saved address already exists, since
  // loadSettings would have ignored the baked one anyway (the stored value always wins).
  if (stored.serverUrl === '') {
    void (async () => {
      try {
        const bakedUrl = await deps.bakedServerUrl();
        if (bakedUrl === '' || serverInput.value !== '') return;
        serverInput.value = bakedUrl;
        stored = { ...stored, serverUrl: bakedUrl };
      } catch (err) {
        // The popup is already usable by the time this runs: a background fill failing is
        // logged for debugging, not shown to the person, the same tolerance bakedServerUrl's
        // own every other failure path already has (issue #79). bakedServerUrl itself never
        // actually rejects; this only guards against something unexpected in that contract.
        console.error('Opportun Capture: could not read the baked server address.', err);
      }
    })();
  }
}
