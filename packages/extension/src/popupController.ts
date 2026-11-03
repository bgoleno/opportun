// The popup's behavior, with every browser API injected (popup.ts wires the real ones), so it
// runs under happy-dom in tests. The page is read only inside the Capture click handler (C-1).
import { postCapture, testConnection, type FetchLike, type Outcome } from './api';
import { captureSiteOf, indeedJobKey, type CaptureSiteId } from './canonical';
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
  for (const id of ['capture', 'save', 'test', 'prefill']) {
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
  const buttons = ['capture', 'save', 'test', 'prefill'].map((id) =>
    element<HTMLButtonElement>(doc, id),
  );
  const [captureButton, , testButton, prefillButton] = buttons as [
    HTMLButtonElement,
    HTMLButtonElement,
    HTMLButtonElement,
    HTMLButtonElement,
  ];
  const assist = element<HTMLElement>(doc, 'assist');
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
    list('Filled in', lines.filled);
    list('Not filled in', lines.notFilled);
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
      const { attempt } = current;
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
      const filled = await deps.runFill(tab.id, plan);
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
      const report = { ...filled, filled: [...filled.filled], notFilled: [...filled.notFilled] };
      if (filled.resume !== null) {
        show({ tone: 'info', text: 'Checking that the form shows your resume...' });
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
        if (reason === null) report.filled.push('Resume');
        else report.notFilled.push({ label: 'Resume', reason });
      }
      const lines = reportLines(report);
      show({ tone: 'info', text: lines.reminder });
      showReport(lines);
    });
  });

  // The Assisted apply section shows only over a Greenhouse posting tab: decided from the tab's
  // address, which the popup already knows; nothing in the page is read for it.
  void (async () => {
    try {
      const tab = await deps.activeTab();
      assist.hidden = tab?.url === undefined || greenhouseJobOf(tab.url) === null;
    } catch {
      assist.hidden = true;
    }
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
