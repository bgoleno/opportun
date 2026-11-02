// Popup entry: wires the real browser APIs into the popup controller. Chrome and Firefox both
// expose the promise-based `chrome.*` namespace in MV3, so one build serves both.
import {
  MIN_KEPT_CHARS,
  MIN_KEPT_FRACTION,
  TRAILING_NOISE_MARKER_PATTERNS,
} from '@opportun/core/linkedinMarkers';
import {
  extractIndeedJob,
  extractPage,
  type ExtractMarkers,
  type ExtractResult,
  type RawPage,
} from './extract';
import { mountPopup } from './popupController';
import { bakedServerUrl, type SettingsStorage } from './settings';

/** The few extension APIs the popup uses (no @types/chrome dependency). */
interface ExtensionApi {
  storage: { local: SettingsStorage };
  tabs: {
    query(q: { active: true; currentWindow: true }): Promise<{ id?: number; url?: string }[]>;
  };
  scripting: {
    executeScript<A extends unknown[]>(injection: {
      target: { tabId: number };
      func: (...args: A) => unknown;
      // Serialized separately from `func` (JSON-serializable, not structured-clone: see
      // ExtractMarkers' own comment in extract.ts) and passed positionally, so order must
      // match `func`'s own parameter order exactly.
      args: A;
    }): Promise<{ result?: unknown }[]>;
  };
  permissions: {
    request(p: { origins: string[] }): Promise<boolean>;
    contains(p: { origins: string[] }): Promise<boolean>;
  };
  runtime: { getURL(path: string): string };
}

declare const chrome: ExtensionApi;

const isRawPage = (v: unknown): v is RawPage =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as RawPage).url === 'string' &&
  typeof (v as RawPage).title === 'string' &&
  typeof (v as RawPage).text === 'string';

/** What extractIndeedJob may return; anything else from the tab is treated as a failure. */
const isExtractResult = (v: unknown): v is ExtractResult =>
  typeof v === 'object' &&
  v !== null &&
  (((v as { ok?: unknown }).ok === true && isRawPage((v as { page?: unknown }).page)) ||
    ((v as { ok?: unknown }).ok === false &&
      (v as { reason?: unknown }).reason === 'layout_unrecognized'));

void mountPopup(document, {
  storage: chrome.storage.local,
  fetch: (url, init) => fetch(url, init),
  // The address the server baked into this download, if it came from one.
  bakedServerUrl: () =>
    bakedServerUrl({ url: (path) => chrome.runtime.getURL(path), fetch: (input) => fetch(input) }),
  activeTab: async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id === undefined ? null : { id: tab.id, url: tab.url };
  },
  runExtract: async (tabId, site) => {
    try {
      if (site === 'indeed') {
        // Indeed's reader composes the job from named parts and needs no data from here
        // (https://github.com/bgoleno/opportun/issues/74). No args: `doc` defaults to the page's
        // own document, as for extractPage.
        const [frame] = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractIndeedJob,
          args: [],
        });
        return isExtractResult(frame?.result) ? frame.result : null;
      }
      // One injection, in the tab the user clicked on. The function itself is serialized
      // (not a wrapper: a wrapper's reference to extractPage would not exist in the page), and
      // the marker data travels separately through `args` (issue #275): extractPage's body
      // cannot import it, but this file is never serialized, so it reads the shared module
      // directly. `doc` is omitted here entirely (not even `undefined`) and defaults to the
      // injected page's own `document`.
      const markers: ExtractMarkers = {
        trailingNoisePatterns: TRAILING_NOISE_MARKER_PATTERNS,
        minKeptChars: MIN_KEPT_CHARS,
        minKeptFraction: MIN_KEPT_FRACTION,
      };
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPage,
        args: [markers],
      });
      return isRawPage(frame?.result) ? { ok: true, page: frame.result } : null;
    } catch {
      return null;
    }
  },
  requestOrigin: (pattern) => chrome.permissions.request({ origins: [pattern] }),
  hasOrigin: (pattern) => chrome.permissions.contains({ origins: [pattern] }),
});
