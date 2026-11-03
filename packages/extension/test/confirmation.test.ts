// "Record confirmation page" in the popup (assisted apply M4,
// https://github.com/bgoleno/opportun/issues/121): from the click to the message, against a
// stubbed server (GET /connector/apply/confirmable and POST /connector/apply/:id/confirmation).
// Every value here is a placeholder.
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import type { FetchInit, FetchLike, FetchResponse } from '../src/api';
import { CONFIRMATION_TEXT_MAX, readConfirmationPage, type ReadPage } from '../src/confirmation';
import type { GetLike } from '../src/prefill';
import { mountPopup, type PopupDeps } from '../src/popupController';
import type { SettingsStorage } from '../src/settings';

const TOKEN = `odt_${'D'.repeat(43)}`;
const SERVER = 'https://opportun.example.com';
const POPUP_HTML = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const TAB = 'https://boards.greenhouse.io/examplecorp/jobs/4000001/confirmation?step=done';
const FOUND = {
  attempt: {
    id: 'sub-1',
    opportunityTitle: 'Platform Engineer',
    companyName: 'Example Corp',
  },
  reason: null,
};

const json = (status: number, body: unknown) =>
  ({ status, headers: { get: () => null }, json: async () => body }) as FetchResponse;

function setup(
  opts: {
    tabUrl?: string;
    confirmable?: FetchResponse;
    read?: ReadPage | null;
    posted?: FetchResponse;
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
  const data: Record<string, unknown> = { serverUrl: SERVER, token: TOKEN };
  const storage: SettingsStorage = {
    get: async (keys) => Object.fromEntries(Object.entries(data).filter(([k]) => keys.includes(k))),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
  const tabUrl = opts.tabUrl ?? TAB;
  const get = vi.fn<GetLike>(async (url) => {
    if (url.includes('/connector/apply/confirmable?')) return opts.confirmable ?? json(200, FOUND);
    throw new Error(`unexpected GET ${url}`);
  });
  const posts: { url: string; init: FetchInit }[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    posts.push({ url, init });
    return opts.posted ?? json(200, { submissionId: 'sub-1', recorded: true });
  });
  const read =
    opts.read === undefined
      ? { href: tabUrl, title: 'Thank you for applying', text: 'Thank you for applying!' }
      : opts.read;
  const deps: PopupDeps = {
    storage,
    fetch,
    get,
    activeTab: vi.fn(async () => ({ id: 7, url: tabUrl })),
    runExtract: vi.fn(async () => null),
    runFill: vi.fn(async () => null),
    runResumeCheck: vi.fn(async () => null),
    runResumeClear: vi.fn(async () => null),
    runReadPage: vi.fn(async () => read),
    wait: vi.fn(async () => undefined),
    requestOrigin: vi.fn(async () => true),
    hasOrigin: vi.fn(async () => true),
    bakedServerUrl: vi.fn(async () => ''),
  };
  const $ = (id: string) => doc.getElementById(id)!;
  return { doc, deps, get, fetch, posts, $ };
}

async function clickRecord(s: ReturnType<typeof setup>): Promise<string> {
  await mountPopup(s.doc, s.deps);
  s.$('record').click();
  await vi.waitFor(() => expect(s.$('status').textContent).not.toBe(''));
  await vi.waitFor(() => expect((s.$('record') as HTMLButtonElement).disabled).toBe(false));
  return s.$('status').textContent ?? '';
}

describe('the Confirmation page section', () => {
  it('shows on an https tab and is hidden elsewhere, decided from the address alone', async () => {
    const on = setup();
    await mountPopup(on.doc, on.deps);
    await vi.waitFor(() => expect(on.$('confirm').hidden).toBe(false));
    for (const url of ['chrome://extensions/', 'http://boards.greenhouse.io/x/jobs/1']) {
      const off = setup({ tabUrl: url });
      await mountPopup(off.doc, off.deps);
      await new Promise((r) => setTimeout(r, 5));
      expect(off.$('confirm').hidden, url).toBe(true);
    }
    // Nothing was asked of the server or the page just by opening the popup.
    expect(on.get).not.toHaveBeenCalled();
    expect(on.deps.runReadPage).not.toHaveBeenCalled();
  });
});

describe('Record confirmation page', () => {
  it("asks which application, reads the page once, and sends the tab's own address", async () => {
    const s = setup();
    const text = await clickRecord(s);
    expect(text).toBe(
      'Confirmation page recorded for Platform Engineer at Example Corp. You can see or delete it in Opportun.',
    );
    expect(s.get).toHaveBeenCalledTimes(1);
    const [lookupUrl, lookupInit] = s.get.mock.calls[0]!;
    expect(lookupUrl).toBe(
      `${SERVER}/api/v1/connector/apply/confirmable?url=${encodeURIComponent(TAB)}`,
    );
    expect(lookupInit).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(s.deps.runReadPage).toHaveBeenCalledTimes(1);
    expect(s.posts).toHaveLength(1);
    const [post] = s.posts;
    expect(post!.url).toBe(`${SERVER}/api/v1/connector/apply/sub-1/confirmation`);
    expect(post!.init).toMatchObject({
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      credentials: 'omit',
      redirect: 'error',
    });
    expect(JSON.parse(post!.init.body)).toEqual({
      url: TAB,
      title: 'Thank you for applying',
      text: 'Thank you for applying!',
    });
  });

  it('sends at most 20,000 characters of the page', async () => {
    const s = setup({
      read: { href: TAB, title: 't', text: 'x'.repeat(CONFIRMATION_TEXT_MAX + 50) },
    });
    await clickRecord(s);
    expect(JSON.parse(s.posts[0]!.init.body).text).toHaveLength(CONFIRMATION_TEXT_MAX);
  });

  it('a tab that moved after the lookup, an empty page, or a failed read records nothing', async () => {
    for (const [read, message] of [
      [{ href: `${TAB}#elsewhere`, title: 't', text: 'x' }, 'The tab moved to another page.'],
      [{ href: TAB, title: 't', text: '   ' }, 'This page has no text to record.'],
      [null, 'The extension could not read this tab.'],
    ] as const) {
      const s = setup({ read });
      expect(await clickRecord(s)).toContain(message);
      expect(s.posts).toHaveLength(0);
    }
  });

  it('a LinkedIn or Indeed tab is neither asked about nor read (sec on #199)', async () => {
    for (const url of [
      'https://www.linkedin.com/jobs/view/4000001/',
      'https://www.indeed.com/viewjob?jk=0123456789abcdef',
    ]) {
      const s = setup({ tabUrl: url });
      expect(await clickRecord(s), url).toContain('never an application');
      expect(s.get).not.toHaveBeenCalled();
      expect(s.deps.runReadPage).not.toHaveBeenCalled();
      expect(s.posts).toHaveLength(0);
    }
  });

  it('a page that is not https is not asked about or read', async () => {
    const s = setup({ tabUrl: 'chrome://newtab/' });
    expect(await clickRecord(s)).toContain("Open the application site's thank-you page");
    expect(s.get).not.toHaveBeenCalled();
    expect(s.deps.runReadPage).not.toHaveBeenCalled();
  });

  it('says why when the server names no application, and neither reads nor sends', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { reason: 'needs_submitted_first' },
        'In Opportun, say you submitted this application first (I submitted it), then record this page. Nothing was recorded.',
      ],
      [
        { reason: 'already_recorded' },
        'A confirmation page is already recorded for the application this page belongs to. Nothing was recorded.',
      ],
      [
        { reason: 'several_matching' },
        'More than one of your applications could match this page. Mark the right one confirmed in Opportun instead. Nothing was recorded.',
      ],
      [
        { reason: 'no_matching_attempt' },
        'None of your submitted applications is on this site. Open the thank-you page the application site showed you. Nothing was recorded.',
      ],
    ];
    for (const [miss, message] of cases) {
      const s = setup({ confirmable: json(200, { attempt: null, ...miss }) });
      expect(await clickRecord(s)).toBe(message);
      expect(s.deps.runReadPage).not.toHaveBeenCalled();
      expect(s.posts).toHaveLength(0);
    }
  });

  it("shows the server's refusal of the page, and its other answers", async () => {
    const refused = (code: string, status = 409) => json(status, { error: { code } });
    expect(await clickRecord(setup({ posted: refused('wrong_site', 422) }))).toBe(
      "This page is not on the application's site. Nothing was recorded.",
    );
    expect(await clickRecord(setup({ posted: refused('different_job') }))).toBe(
      'This page is for another job. Nothing was recorded.',
    );
    expect(await clickRecord(setup({ posted: refused('not_submitted') }))).toContain(
      'say you submitted this application first',
    );
    expect(
      await clickRecord(setup({ posted: json(200, { submissionId: 'sub-1', recorded: false }) })),
    ).toBe('This application is already confirmed. Nothing was recorded.');
    expect(await clickRecord(setup({ confirmable: json(403, {}) }))).toContain(
      "can't record confirmation pages",
    );
    expect(await clickRecord(setup({ confirmable: json(404, {}) }))).toContain(
      'Assisted apply is not turned on',
    );
  });
});

describe('readConfirmationPage', () => {
  it("returns the page's own address, title and visible text", () => {
    const window = new Window({
      url: 'https://boards.greenhouse.io/examplecorp/jobs/1/confirmation',
    });
    window.document.write(
      '<html><head><title>Thanks!</title></head><body><h1>Thank you</h1><p>We got it.</p></body></html>',
    );
    const page = readConfirmationPage(window.document as unknown as Document);
    expect(page.href).toBe('https://boards.greenhouse.io/examplecorp/jobs/1/confirmation');
    expect(page.title).toBe('Thanks!');
    expect(page.text).toContain('Thank you');
    expect(page.text).toContain('We got it.');
  });
});
