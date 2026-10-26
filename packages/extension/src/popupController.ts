// The popup's behavior, with every browser API injected (popup.ts wires the real ones), so it
// runs under happy-dom in tests. The page is read only inside the Capture click handler (C-1).
import { postCapture, testConnection, type FetchLike, type Outcome } from './api';
import { isLinkedInUrl } from './canonical';
import type { RawPage } from './extract';
import { normalizeCapture } from './normalize';
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
  /** The tab the popup was opened over (tabs.query active + currentWindow). */
  activeTab(): Promise<{ id: number; url: string | undefined } | null>;
  /** Runs extractPage once in that tab (scripting.executeScript); null on failure. */
  runExtract(tabId: number): Promise<RawPage | null>;
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
  for (const id of ['capture', 'save', 'test']) {
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
  const buttons = ['capture', 'save', 'test'].map((id) => element<HTMLButtonElement>(doc, id));
  const [captureButton, , testButton] = buttons as [
    HTMLButtonElement,
    HTMLButtonElement,
    HTMLButtonElement,
  ];

  const show = ({ tone, text }: Rendered): void => {
    status.dataset.tone = tone;
    status.textContent = text;
  };
  const showOutcome = (o: Outcome): void => show(renderOutcome(o));

  /** Disables the buttons while `work` runs; a thrown error is shown, never swallowed. */
  const busy = async (work: () => Promise<void>): Promise<void> => {
    for (const b of buttons) b.disabled = true;
    status.textContent = '';
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
      // Only LinkedIn tabs are read: any other page stays untouched and unsent.
      if (tab === null || tab.url === undefined || !isLinkedInUrl(tab.url)) {
        showOutcome({ kind: 'not_linkedin' });
        return;
      }
      const raw = await deps.runExtract(tab.id);
      if (raw === null) {
        showOutcome({ kind: 'inject_failed' });
        return;
      }
      const normalized = normalizeCapture(raw);
      if (!normalized.ok) {
        showOutcome({ kind: normalized.error });
        return;
      }
      showOutcome(await postCapture(deps.fetch, s, normalized.payload));
    });
  });

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
