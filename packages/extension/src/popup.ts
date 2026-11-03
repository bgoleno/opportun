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
import { clearResume, fillGreenhouseForm, resumeShown, type FillReport } from './greenhouseFill';
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

const NOT_FILLED_REASONS: readonly unknown[] = [
  'choose_on_form',
  'not_in_review',
  'no_matching_question',
  'has_value',
  'not_shown',
  'ambiguous',
  'attach_yourself',
  'attach_file_yourself',
  'resume_unchecked',
];

/** What fillGreenhouseForm may return; anything else from the tab is treated as a failure. */
const isFillReport = (v: unknown): v is FillReport => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { ok?: unknown; reason?: unknown; filled?: unknown; notFilled?: unknown };
  if (r.ok === false) return r.reason === 'wrong_page' || r.reason === 'no_form';
  const resume = (v as { resume?: unknown }).resume;
  const resumeOk =
    resume === null ||
    (typeof resume === 'object' &&
      resume !== null &&
      typeof (resume as { filename?: unknown }).filename === 'string' &&
      typeof (resume as { size?: unknown }).size === 'number' &&
      typeof (resume as { before?: unknown }).before === 'number');
  return (
    r.ok === true &&
    resumeOk &&
    Array.isArray(r.filled) &&
    r.filled.every((l) => typeof l === 'string') &&
    Array.isArray(r.notFilled) &&
    r.notFilled.every(
      (n: unknown) =>
        typeof n === 'object' &&
        n !== null &&
        typeof (n as { label?: unknown }).label === 'string' &&
        NOT_FILLED_REASONS.includes((n as { reason?: unknown }).reason),
    )
  );
};

void mountPopup(document, {
  storage: chrome.storage.local,
  fetch: (url, init) => fetch(url, init),
  get: (url, init) => fetch(url, init),
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
  runFill: async (tabId, plan) => {
    try {
      // The top frame only: no allFrames and no frameIds, so no embedded frame is ever reached
      // (sec's condition 4 on #183). The plan is the only argument: the reviewed values and the
      // resume copy as base64, nothing else of the popup's.
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId },
        func: fillGreenhouseForm,
        args: [plan],
      });
      return isFillReport(frame?.result) ? frame.result : null;
    } catch {
      return null;
    }
  },
  // The resume check and clear (tl and sec on #187): top frame only, a bare func and inline
  // args, like the filler; the check only reads.
  runResumeCheck: async (tabId, check) => {
    try {
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId },
        func: resumeShown,
        args: [check],
      });
      const n = frame?.result;
      return typeof n === 'number' ? n : null;
    } catch {
      return null;
    }
  },
  runResumeClear: async (tabId, check) => {
    try {
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId },
        func: clearResume,
        args: [check],
      });
      const r = frame?.result;
      return r === 'cleared' ||
        r === 'shown' ||
        r === 'kept' ||
        r === 'empty' ||
        r === 'wrong_page' ||
        r === 'no_input'
        ? r
        : null;
    } catch {
      return null;
    }
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestOrigin: (pattern) => chrome.permissions.request({ origins: [pattern] }),
  hasOrigin: (pattern) => chrome.permissions.contains({ origins: [pattern] }),
});
