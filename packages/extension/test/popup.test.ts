import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/api';
import type { CaptureSiteId } from '../src/canonical';
import { extractIndeedJob, type ExtractResult, type RawPage } from '../src/extract';
import { COMPANY, JK, NEVER_SENT, splitView, TITLE, viewjobPage } from './fixtures/indeedPages';
import { load, type FixturePage } from './fixtures/pages';
import { mountPopup, type PopupDeps } from '../src/popupController';
import type { SettingsStorage } from '../src/settings';

const TOKEN = `odt_${'C'.repeat(43)}`;
const SERVER = 'https://opportun.example.com';
const POPUP_HTML = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');

const JOB_TAB = 'https://www.linkedin.com/jobs/search/?currentJobId=3901234567&keywords=platform';
const JOB_RAW: RawPage = {
  url: JOB_TAB,
  title: 'Staff Platform Engineer | Initech | LinkedIn',
  text: 'Initech\nStaff Platform Engineer\nAustin, TX\n\nAbout the job\nOwn the platform.',
};

function setup(
  opts: {
    stored?: Record<string, unknown>;
    tabUrl?: string;
    raw?: RawPage | null;
    /** What the injected function returns, when a test needs more than a RawPage. */
    extract?: (site: CaptureSiteId) => ExtractResult | null;
    status?: number;
    body?: unknown;
    granted?: boolean;
    baked?: string;
  } = {},
) {
  const window = new Window({
    url: 'chrome-extension://abc/popup.html',
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  window.document.write(POPUP_HTML);
  const doc = window.document as unknown as Document;
  const data: Record<string, unknown> = { ...(opts.stored ?? {}) };
  const storage: SettingsStorage = {
    get: async (keys) => Object.fromEntries(Object.entries(data).filter(([k]) => keys.includes(k))),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
  const fetch = vi.fn<FetchLike>(async () => ({
    status: opts.status ?? 201,
    headers: { get: () => null },
    json: async () =>
      opts.body ?? {
        kind: 'job',
        resultId: 'r1',
        duplicate: false,
        refined: false,
        opportunityId: 'o1',
        stage: 'interested',
      },
  }));
  const deps: PopupDeps = {
    storage,
    fetch,
    activeTab: vi.fn(async () => ({ id: 7, url: opts.tabUrl ?? JOB_TAB })),
    runExtract: vi.fn(async (_tabId: number, site: CaptureSiteId) => {
      if (opts.extract !== undefined) return opts.extract(site);
      const raw = opts.raw === undefined ? JOB_RAW : opts.raw;
      return raw === null ? null : { ok: true as const, page: raw };
    }),
    requestOrigin: vi.fn(async () => opts.granted ?? true),
    hasOrigin: vi.fn(async () => opts.granted ?? true),
    bakedServerUrl: vi.fn(async () => opts.baked ?? ''),
  };
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  return { doc, data, deps, fetch, $ };
}

const SAVED = { serverUrl: SERVER, token: TOKEN };
const status = (doc: Document) => doc.getElementById('status')!;

async function click(el: HTMLElement, done: () => boolean) {
  el.click();
  await vi.waitFor(() => expect(done()).toBe(true));
}

describe('popup settings', () => {
  it('saves the server and token, asking for the server origin only', async () => {
    const { doc, data, deps, $ } = setup();
    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = 'https://opportun.example.com/';
    $<HTMLInputElement>('token').value = TOKEN;
    await click($('save'), () => status(doc).textContent !== '');
    expect(deps.requestOrigin).toHaveBeenCalledWith('https://opportun.example.com/*');
    expect(data).toEqual(SAVED);
    expect(status(doc).textContent).toBe('Settings saved.');
  });

  it('does not ask for a permission it already holds (issue #49)', async () => {
    // Chrome closes the popup whenever the host-permission prompt opens, so a save that
    // prompts needlessly throws the window away under the user.
    const { doc, data, deps, $ } = setup({ stored: SAVED, granted: true });
    await mountPopup(doc, deps);
    $<HTMLInputElement>('token').value = `odt_${'D'.repeat(43)}`;
    await click($('save'), () => status(doc).textContent !== '');
    expect(deps.requestOrigin).not.toHaveBeenCalled();
    expect(data.token).toBe(`odt_${'D'.repeat(43)}`);
    expect(status(doc).textContent).toBe('Settings saved.');
  });

  it('writes the settings before the prompt can tear the popup down (issue #49)', async () => {
    // A prompt that never resolves stands in for the popup's context being destroyed while
    // Chrome asks. The token must already be on disk by then, or the user loses it.
    const { doc, data, deps, $ } = setup({ granted: false });
    deps.requestOrigin = vi.fn(() => new Promise<boolean>(() => {}));
    deps.hasOrigin = vi.fn(async () => false);
    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = SERVER;
    $<HTMLInputElement>('token').value = TOKEN;
    $('save').click();
    await vi.waitFor(() => expect(data).toEqual(SAVED));
    expect(deps.requestOrigin).toHaveBeenCalledWith(`${SERVER}/*`);
  });

  it('pre-fills the server address the download was built with (design D9)', async () => {
    const { doc, data, deps, $ } = setup({ baked: SERVER });
    await mountPopup(doc, deps);
    expect($<HTMLInputElement>('server-url').value).toBe(SERVER);
    // Shown, not stored: nothing is saved until the user presses Save.
    expect(data).toEqual({});
  });

  it('prefers a saved address over the baked one', async () => {
    const { doc, deps, $ } = setup({ stored: SAVED, baked: 'https://stale.example.com' });
    await mountPopup(doc, deps);
    expect($<HTMLInputElement>('server-url').value).toBe(SERVER);
  });

  it('never puts a saved token back into the page, and keeps it when left blank', async () => {
    const { doc, data, deps, $ } = setup({ stored: SAVED });
    await mountPopup(doc, deps);
    expect($<HTMLInputElement>('server-url').value).toBe(SERVER);
    expect($<HTMLInputElement>('token').value).toBe('');
    expect(doc.body.innerHTML).not.toContain(TOKEN);
    await click($('save'), () => status(doc).textContent !== '');
    expect(data).toEqual(SAVED);
  });

  it('shows why settings were not saved, and stores nothing', async () => {
    const { doc, data, deps, $ } = setup();
    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = 'http://opportun.example.com';
    $<HTMLInputElement>('token').value = TOKEN;
    await click($('save'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toMatch(/https/);
    expect(data).toEqual({});
  });

  it('checks the token format before asking for any permission', async () => {
    const { doc, data, deps, $ } = setup();
    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = SERVER;
    $<HTMLInputElement>('token').value = 'my-password';
    await click($('save'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toMatch(/starts with odt_/);
    expect(deps.requestOrigin).not.toHaveBeenCalled();
    expect(data).toEqual({});
  });

  it('a blank token with nothing saved is refused before any permission prompt', async () => {
    const { doc, data, deps, $ } = setup();
    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = SERVER;
    await click($('save'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toMatch(/starts with odt_/);
    expect(deps.requestOrigin).not.toHaveBeenCalled();
    expect(data).toEqual({});
  });

  it('a new server origin with a blank token asks for the token again', async () => {
    const { doc, data, deps, $ } = setup({ stored: SAVED });
    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = 'https://other.example.net';
    await click($('save'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toBe('Server changed: re-enter the token for the new server.');
    expect(deps.requestOrigin).not.toHaveBeenCalled();
    expect(data).toEqual(SAVED);
  });

  it('the same origin with a blank token keeps the saved token', async () => {
    const { doc, data, deps, $ } = setup({ stored: SAVED });
    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = `${SERVER}/opportun/`;
    await click($('save'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toBe('Settings saved.');
    expect(data).toEqual({ serverUrl: `${SERVER}/opportun`, token: TOKEN });
  });

  it('a new server origin with a new token saves both', async () => {
    const other = `odt_${'D'.repeat(43)}`;
    const { doc, data, deps, $ } = setup({ stored: SAVED });
    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = 'https://other.example.net';
    $<HTMLInputElement>('token').value = other;
    await click($('save'), () => status(doc).textContent !== '');
    expect(deps.requestOrigin).toHaveBeenCalledWith('https://other.example.net/*');
    expect(data).toEqual({ serverUrl: 'https://other.example.net', token: other });
  });

  it('does not save when the user declines the server permission', async () => {
    const { doc, data, deps, $ } = setup({ granted: false });
    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = SERVER;
    $<HTMLInputElement>('token').value = TOKEN;
    await click($('save'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toMatch(/permission to contact your server/);
    // The invariant is that refusing leaves no token behind, not that the keys are absent:
    // the settings are written before the prompt now, so a decline rolls them back (#49).
    expect(data).toEqual({ serverUrl: '', token: '' });
  });
});

describe('popup capture', () => {
  it('reads the tab only on click, sends the canonical URL, and shows the result', async () => {
    const { doc, deps, fetch, $ } = setup({ stored: SAVED });
    await mountPopup(doc, deps);
    expect(deps.runExtract).not.toHaveBeenCalled();
    await click($('capture'), () => status(doc).textContent !== '');
    expect(deps.runExtract).toHaveBeenCalledWith(7, 'linkedin');
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.url).toBe('https://www.linkedin.com/jobs/view/3901234567/');
    expect(status(doc).textContent).toBe('Added to your pipeline as Interested.');
    expect(status(doc).dataset.tone).toBe('success');
  });

  it('does not touch a tab that is not LinkedIn', async () => {
    const { doc, deps, fetch, $ } = setup({ stored: SAVED, tabUrl: 'https://bank.example/' });
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(deps.runExtract).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(status(doc).textContent).toMatch(/Open a LinkedIn profile or job page/);
  });

  it('asks for settings first', async () => {
    const { doc, deps, fetch, $ } = setup();
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(fetch).not.toHaveBeenCalled();
    expect(status(doc).textContent).toMatch(/Save your server address and token first/);
  });

  it('renders the server’s refusal of a feed', async () => {
    const { doc, deps, $ } = setup({
      stored: SAVED,
      tabUrl: 'https://www.linkedin.com/feed/',
      raw: {
        url: 'https://www.linkedin.com/feed/',
        title: 'Feed | LinkedIn',
        text: 'Start a post',
      },
      status: 422,
      body: { error: { code: 'unrecognized_page', reason: 'unsupported_path' } },
    });
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toMatch(/^Not captured: open a single profile/);
    expect(status(doc).dataset.tone).toBe('error');
  });

  it('renders the server’s title_too_long refusal of a LinkedIn job (#92)', async () => {
    const { doc, deps, $ } = setup({
      stored: SAVED,
      tabUrl: 'https://www.linkedin.com/jobs/view/3901234567/',
      raw: {
        url: 'https://www.linkedin.com/jobs/view/3901234567/',
        title: 'A very long job title | Example Corp | LinkedIn',
        text: 'About the job',
      },
      status: 422,
      body: { error: { code: 'unrecognized_page', reason: 'title_too_long' } },
    });
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toMatch(
      /^Not captured: the job title is longer than 300 characters/,
    );
    expect(status(doc).textContent).not.toMatch(/finished loading/);
    expect(status(doc).dataset.tone).toBe('error');
  });

  it('a failed injection is reported, nothing sent', async () => {
    const { doc, deps, fetch, $ } = setup({ stored: SAVED, raw: null });
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(fetch).not.toHaveBeenCalled();
    expect(status(doc).textContent).toMatch(/could not read this tab/);
  });

  it('a revoked token gets the 401 message', async () => {
    const { doc, deps, $ } = setup({ stored: SAVED, status: 401, body: {} });
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toMatch(/rejected the token/);
    expect(doc.body.innerHTML).not.toContain(TOKEN);
  });
});

// https://github.com/bgoleno/opportun/issues/74. runExtract runs the real extractIndeedJob over a
// synthetic fixture, so these cover the popup and the page reading together.
describe('popup capture on Indeed', () => {
  const realIndeed =
    (fixture: FixturePage) =>
    (site: CaptureSiteId): ExtractResult | null =>
      site === 'indeed' ? extractIndeedJob(load(fixture)) : null;
  const sent = (fetch: ReturnType<typeof setup>['fetch']) =>
    JSON.parse(fetch.mock.calls[0]![1].body) as { url: string; title: string; text: string };

  it('a /viewjob page sends the job with its canonical URL and shows the result', async () => {
    const fixture = viewjobPage();
    const { doc, deps, fetch, $ } = setup({
      stored: SAVED,
      tabUrl: fixture.url,
      extract: realIndeed(fixture),
    });
    await mountPopup(doc, deps);
    expect(deps.runExtract).not.toHaveBeenCalled();
    await click($('capture'), () => status(doc).textContent !== '');
    expect(deps.runExtract).toHaveBeenCalledWith(7, 'indeed');
    const body = sent(fetch);
    expect(body.url).toBe(`https://www.indeed.com/viewjob?jk=${JK}`);
    expect(body.title).toBe(TITLE);
    expect(body.text.split('\n').slice(0, 2)).toEqual([TITLE, COMPANY]);
    expect(status(doc).textContent).toBe('Added to your pipeline as Interested.');
  });

  it('the split view sends exactly what /viewjob sends, and the job title, not the search', async () => {
    const bodies = [];
    for (const fixture of [viewjobPage(), splitView({ compactHeaderShowing: true })]) {
      const { doc, deps, fetch, $ } = setup({
        stored: SAVED,
        tabUrl: fixture.url,
        extract: realIndeed(fixture),
      });
      await mountPopup(doc, deps);
      await click($('capture'), () => status(doc).textContent !== '');
      bodies.push(sent(fetch));
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]!.title).toBe(TITLE);
    expect(bodies[1]!.title).not.toMatch(/Now Hiring|Jobs in/);
    for (const never of NEVER_SENT) expect(JSON.stringify(bodies[1])).not.toContain(never);
  });

  it('a missing job pane is refused visibly and nothing is sent', async () => {
    const fixture = splitView({}, false);
    const { doc, deps, fetch, $ } = setup({
      stored: SAVED,
      tabUrl: fixture.url,
      extract: realIndeed(fixture),
    });
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(fetch).not.toHaveBeenCalled();
    expect(status(doc).textContent).toMatch(/Indeed’s layout was not recognized/);
    expect(status(doc).dataset.tone).toBe('error');
  });

  it.each([
    ['search results with no job open', 'https://www.indeed.com/jobs?q=placeholder&l=x'],
    ['a company page', 'https://www.indeed.com/cmp/Example-Corp'],
    ['a malformed job key', 'https://www.indeed.com/viewjob?jk=not-a-key'],
  ])('%s is refused in the popup without reading the tab', async (_name, tabUrl) => {
    const { doc, deps, fetch, $ } = setup({ stored: SAVED, tabUrl });
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(deps.runExtract).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(status(doc).textContent).toMatch(/open a single Indeed job/i);
  });

  it.each([
    ['verification_wall', /Indeed is showing a sign-in or verification page/],
    ['unsupported_path', /single Indeed job/],
    ['no_title_company', /finished loading/],
    ['no_description', /finished loading/],
    ['unsupported_site', /not a site Opportun captures from/],
    ['title_too_long', /job title is longer than 300 characters/],
  ])('shows the server’s %s refusal, naming Indeed', async (reason, pattern) => {
    const fixture = viewjobPage();
    const { doc, deps, $ } = setup({
      stored: SAVED,
      tabUrl: fixture.url,
      extract: realIndeed(fixture),
      status: 422,
      body: { error: { code: 'unrecognized_page', reason } },
    });
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toMatch(/^Not captured: /);
    expect(status(doc).textContent).toMatch(pattern);
    expect(status(doc).textContent).not.toMatch(/LinkedIn/);
  });

  it('look-alike hosts and Indeed country sites are not read at all', async () => {
    for (const tabUrl of [
      `https://notindeed.com/viewjob?jk=${JK}`,
      `https://uk.indeed.com/viewjob?jk=${JK}`,
    ]) {
      const { doc, deps, fetch, $ } = setup({ stored: SAVED, tabUrl });
      await mountPopup(doc, deps);
      await click($('capture'), () => status(doc).textContent !== '');
      expect(deps.runExtract).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(status(doc).textContent).toMatch(
        /Open a LinkedIn profile or job page, or an Indeed job/,
      );
    }
  });

  it('a page that navigated off its job between the click and the read is not sent', async () => {
    const { doc, deps, fetch, $ } = setup({
      stored: SAVED,
      tabUrl: viewjobPage().url,
      extract: () => ({
        ok: true,
        page: { url: 'https://www.indeed.com/jobs?q=x', title: TITLE, text: 'x\ny' },
      }),
    });
    await mountPopup(doc, deps);
    await click($('capture'), () => status(doc).textContent !== '');
    expect(fetch).not.toHaveBeenCalled();
    expect(status(doc).textContent).toMatch(/open a single Indeed job/i);
  });
});

describe('popup connection test', () => {
  it('a 422 refusal means connected', async () => {
    const { doc, deps, fetch, $ } = setup({
      stored: SAVED,
      status: 422,
      body: { error: { code: 'unrecognized_page', reason: 'unsupported_path' } },
    });
    await mountPopup(doc, deps);
    await click($('test'), () => status(doc).textContent !== '');
    expect(deps.runExtract).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(status(doc).textContent).toBe('Connected: the server accepted the token.');
  });
});

describe('popup startup failure (issue #80)', () => {
  // Before this fix, a throw anywhere in mountPopup's own setup (everything before its click
  // listeners attach) left the popup's static markup looking normal with every button silently
  // inert: busy()'s "Something went wrong. Try again." only wraps work done after a click, so it
  // could never catch a failure that happened before any listener existed to wrap.

  it('renders a visible failure and disables every button, instead of leaving them silently inert', async () => {
    // bakedServerUrl is no longer part of this path (issue #79): storage.get is, so that is
    // what this failure has to come from now to still be testing mount's critical setup.
    const { doc, deps, $ } = setup();
    deps.storage.get = vi.fn(async () => {
      throw new Error('storage unavailable');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(mountPopup(doc, deps)).resolves.toBeUndefined();

    expect(status(doc).textContent).toMatch(/failed to start/i);
    expect(status(doc).dataset.tone).toBe('error');
    for (const id of ['capture', 'save', 'test']) {
      expect($<HTMLButtonElement>(id).disabled).toBe(true);
    }
  });

  it('logs the underlying error to the console', async () => {
    const { doc, deps } = setup();
    const failure = new Error('storage unavailable');
    deps.storage.get = vi.fn(async () => {
      throw failure;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await mountPopup(doc, deps);

    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/popup/i), failure);
  });

  it('does not touch the status or buttons when startup succeeds', async () => {
    const { doc, deps, $ } = setup();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await mountPopup(doc, deps);

    expect(status(doc).textContent).toBe('');
    expect(status(doc).dataset.tone).toBeUndefined();
    for (const id of ['capture', 'save', 'test']) {
      expect($<HTMLButtonElement>(id).disabled).toBe(false);
    }
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('mount does not block on anything that can hang (issue #79, characterization)', () => {
  // The owner's toolbar icon went into its pressed state and nothing painted for close to a
  // minute, then resolved on its own. setupPopup awaits bakedServerUrl() (twice) before it ever
  // reaches the lines that attach the capture/save/test listeners, so a slow or hung baked-config
  // read holds the whole popup unusable for exactly as long as it takes, with nothing on screen
  // to say why. This pins the fix's shape rather than its cause: whatever that call turns out to
  // be waiting on, listeners must already be attached before it's awaited, not after.
  it('wires the settings form before a never-resolving bakedServerUrl resolves', async () => {
    const { doc, deps, $ } = setup();
    deps.bakedServerUrl = vi.fn(() => new Promise<string>(() => {}));

    // Awaited directly: the fix this characterizes is exactly that mountPopup no longer hangs
    // on this, so the standard awaited pattern used throughout this file now applies here too.
    await mountPopup(doc, deps);

    // Submitting the form validates synchronously, before anything async: if the submit listener
    // is attached, the empty-address message shows with no wait at all, hang or no hang.
    await click($('save'), () => status(doc).textContent !== '');
    expect(status(doc).textContent).toMatch(/server address/i);
  });

  it('mountPopup itself resolves without waiting for bakedServerUrl at all', async () => {
    const { doc, deps } = setup();
    deps.bakedServerUrl = vi.fn(() => new Promise<string>(() => {}));

    // No test-level race or timeout needed: if mount still awaited this, this line would hang
    // and the test would time out on its own, the same failure shape as the test above.
    await expect(mountPopup(doc, deps)).resolves.toBeUndefined();
  });

  it('fills an empty server address from the baked config once it resolves, without blocking mount on it', async () => {
    const { doc, deps, $ } = setup();
    let resolveBaked!: (url: string) => void;
    deps.bakedServerUrl = vi.fn(() => new Promise<string>((resolve) => (resolveBaked = resolve)));

    await mountPopup(doc, deps);
    expect($<HTMLInputElement>('server-url').value).toBe('');

    resolveBaked(SERVER);
    await vi.waitFor(() => expect($<HTMLInputElement>('server-url').value).toBe(SERVER));
  });

  it('never overwrites an address the person already started typing before the baked config arrives', async () => {
    const { doc, deps, $ } = setup();
    let resolveBaked!: (url: string) => void;
    deps.bakedServerUrl = vi.fn(() => new Promise<string>((resolve) => (resolveBaked = resolve)));
    const typedByHand = 'https://typed-by-hand.example.com';

    await mountPopup(doc, deps);
    $<HTMLInputElement>('server-url').value = typedByHand;
    resolveBaked(SERVER);
    // Let the now-resolved baked-config microtasks run, with nothing left to wait for: if the
    // field were about to be overwritten, it already would be by the time this resolves.
    await Promise.resolve();
    await Promise.resolve();

    expect($<HTMLInputElement>('server-url').value).toBe(typedByHand);
  });
});
