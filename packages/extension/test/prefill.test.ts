// Assisted apply prefill in the popup (#183): from the click to the report, against a stubbed
// server (the GET /connector/apply contract of #182) and the synthetic forms, with the real
// filler run on them. Every value here is a placeholder.
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import type { FetchResponse } from '../src/api';
import {
  clearResume,
  fillGreenhouseForm,
  resumeShown,
  type FillPlan,
  type ResumeCheck,
} from '../src/greenhouseFill';
import {
  buildPlan,
  MAX_RESUME_BYTES,
  reportLines,
  RESUME_CHECKS,
  type GetLike,
  type PrefillAttempt,
} from '../src/prefill';
import {
  FILL_UNSEEN,
  FILLING,
  mountPopup,
  RESUME_CHECKING,
  RESUME_UNCONFIRMED,
  type PopupDeps,
} from '../src/popupController';
import type { SettingsStorage } from '../src/settings';
import {
  BOARD,
  JOB_ID,
  MANY_QUESTIONS,
  POSTING_URL,
  loadForm,
  valueOf,
} from './fixtures/greenhousePages';

const TOKEN = `odt_${'C'.repeat(43)}`;
const SERVER = 'https://opportun.example.com';
const POPUP_HTML = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const PDF = new TextEncoder().encode('%PDF-1.4\n% placeholder resume\n%%EOF\n');
const TAB_URL = `${POSTING_URL}?gh_src=placeholder`;

/**
 * The attempt as /current sends it. `withheld` is absent unless a test sets it, as the server
 * leaves it out when nothing is withheld (#196).
 */
// `firstRead` too is absent unless a test sets it, as a server from before #403 sends it.
type AttemptJson = Omit<PrefillAttempt, 'withheld' | 'firstRead'> & {
  withheld?: string[];
  firstRead?: boolean;
};

function attempt(over: Partial<AttemptJson> = {}): AttemptJson {
  return {
    id: 'sub-1',
    opportunityTitle: 'Senior Platform Engineer',
    companyName: 'Example Corp',
    destinationUrl: `https://boards.greenhouse.io/${BOARD}/jobs/${JOB_ID}`,
    fields: {
      firstName: 'Jane',
      lastName: 'Doe-Example',
      fullName: 'Jane Doe-Example',
      email: 'jane@example.com',
      phone: '555 0100',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe-example',
      websiteUrl: 'https://jane.example.com',
      links: 'never split',
    },
    answers: [{ label: 'Why us?', value: 'Placeholder answer.' }],
    resume: { snapshotState: 'ready', filename: 'Jane-Resume.pdf', bytes: PDF.length },
    ...over,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  }) as FetchResponse;

const pdf = (bytes: Uint8Array = PDF, type = 'application/pdf') =>
  ({
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? type : null) },
    json: async () => undefined,
    arrayBuffer: async () => bytes.slice().buffer,
  }) as FetchResponse;

/** An in-memory stand-in for storage.session. */
function memoryStore(): SettingsStorage & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (keys) => Object.fromEntries(Object.entries(data).filter(([k]) => keys.includes(k))),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
}

function setup(opts: {
  tabUrl?: string;
  current?: FetchResponse | (() => Promise<FetchResponse>);
  snapshot?: FetchResponse;
  showsFileName?: boolean | 'macrotask';
  /** The form, when a test needs another than MANY_QUESTIONS. */
  html?: string;
  /** Runs inside each of the popup's waits between resume checks, as the user or page might. */
  duringWait?: (page: ReturnType<typeof loadForm>, n: number) => void;
  fill?: 'fixture' | 'fails';
  /** storage.session, shared between two popups opened one after the other (#191). */
  checkStore?: SettingsStorage | null;
  tabId?: number;
}) {
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
  const page = loadForm(opts.html ?? MANY_QUESTIONS, {
    url: opts.tabUrl ?? TAB_URL,
    showsFileName: opts.showsFileName,
  });
  const get = vi.fn<GetLike>(async (url) => {
    if (url.includes('/connector/apply/current?')) {
      const c = opts.current ?? json(200, { attempt: attempt(), reason: null });
      return typeof c === 'function' ? c() : c;
    }
    if (url.endsWith('/snapshot')) return opts.snapshot ?? pdf();
    throw new Error(`unexpected GET ${url}`);
  });
  const plans: FillPlan[] = [];
  let waits = 0;
  const deps: PopupDeps = {
    storage,
    fetch: vi.fn(async () => {
      throw new Error('prefill never POSTs');
    }),
    runReadPage: vi.fn(async () => null),
    checkStore: opts.checkStore === undefined ? memoryStore() : opts.checkStore,
    get,
    activeTab: vi.fn(async () => ({ id: opts.tabId ?? 7, url: opts.tabUrl ?? TAB_URL })),
    runExtract: vi.fn(async () => null),
    runFill: vi.fn(async (_tabId: number, plan: FillPlan) => {
      // As executeScript's args travel: JSON only. A plan that did not survive would differ.
      const sent = JSON.parse(JSON.stringify(plan)) as FillPlan;
      expect(sent).toEqual(plan);
      plans.push(sent);
      return opts.fill === 'fails' ? null : fillGreenhouseForm(sent, page.doc);
    }),
    runResumeCheck: vi.fn(async (_tabId: number, check: ResumeCheck) =>
      resumeShown(JSON.parse(JSON.stringify(check)) as ResumeCheck, page.doc),
    ),
    runResumeClear: vi.fn(
      async (_tabId: number, check: ResumeCheck & { size: number; before: number }) =>
        clearResume(
          JSON.parse(JSON.stringify(check)) as ResumeCheck & { size: number; before: number },
          page.doc,
        ),
    ),
    // The popup's own timer, made deterministic: each wait lets the page's pending timers run.
    wait: vi.fn(async () => {
      waits += 1;
      opts.duringWait?.(page, waits);
      await new Promise((r) => page.window.setTimeout(r, 1));
    }),
    requestOrigin: vi.fn(async () => true),
    hasOrigin: vi.fn(async () => true),
    bakedServerUrl: vi.fn(async () => ''),
  };
  const $ = (id: string) => doc.getElementById(id)!;
  return { doc, deps, get, page, plans, $ };
}

/**
 * Lets what the popup does as it opens finish (#403: over a Greenhouse posting it asks the
 * server once), then forgets those reads, so a test of the button counts the button's own.
 */
async function settleOpen(s: ReturnType<typeof setup>) {
  await vi.waitFor(() => expect(s.deps.activeTab).toHaveBeenCalled());
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  s.get.mockClear();
}

async function clickFill(s: ReturnType<typeof setup>) {
  await mountPopup(s.doc, s.deps);
  await settleOpen(s);
  s.$('prefill').click();
  await vi.waitFor(() => expect(s.$('status').textContent).not.toBe(''));
  await vi.waitFor(() => expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false));
}

const listed = (s: ReturnType<typeof setup>, heading: string): string[] => {
  const h = Array.from(s.$('prefill-report').querySelectorAll('h3')).find(
    (x) => x.textContent === heading,
  );
  const ul = h?.nextElementSibling;
  return ul === null || ul === undefined
    ? []
    : Array.from(ul.querySelectorAll('li')).map((li) => li.textContent ?? '');
};

describe('the section shows only on a Greenhouse posting tab', () => {
  it('shown over the posting, hidden elsewhere, decided from the address alone', async () => {
    const on = setup({});
    await mountPopup(on.doc, on.deps);
    await vi.waitFor(() => expect(on.$('assist').hidden).toBe(false));
    const off = setup({ tabUrl: 'https://www.linkedin.com/jobs/view/3901234567/' });
    await mountPopup(off.doc, off.deps);
    await vi.waitFor(() => expect(off.deps.activeTab).toHaveBeenCalled());
    expect(off.$('assist').hidden).toBe(true);
    expect(off.get).not.toHaveBeenCalled();
  });
});

describe('acceptance 1, 3 and 5: fill from the reviewed attempt, then report', () => {
  it('reads /current for this tab with the bearer token, fetches the ready copy, fills and lists everything', async () => {
    const s = setup({});
    await clickFill(s);
    const [current, snapshot] = s.get.mock.calls;
    expect(current![0]).toBe(
      `${SERVER}/api/v1/connector/apply/current?url=${encodeURIComponent(TAB_URL)}`,
    );
    expect(current![1]).toEqual({
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
    });
    expect(snapshot![0]).toBe(`${SERVER}/api/v1/connector/apply/sub-1/snapshot`);
    expect(s.deps.runFill).toHaveBeenCalledTimes(1);
    expect(valueOf(s.page.doc, 'first_name')).toBe('Jane');
    expect(valueOf(s.page.doc, 'question_9000110')).toBe(
      'https://www.linkedin.com/in/jane-doe-example',
    );
    expect(listed(s, 'Filled in')).toEqual([
      'First Name',
      'Last Name',
      'Email',
      'Phone',
      'Website',
      'Why us?',
      'LinkedIn Profile',
      'Resume',
    ]);
    expect(listed(s, 'Not filled in')).toEqual(
      expect.arrayContaining([
        'Phone country code: choose it on the form',
        'Gender: choose it on the form',
        'Website URL: not in what you reviewed: answer it on the form',
      ]),
    );
    expect(s.$('status').textContent).toMatch(/has not submitted anything.*own Submit button/);
  });

  it('the plan carries the reviewed values only: no full name split, no free-text links, no token', async () => {
    const s = setup({});
    await clickFill(s);
    const [plan] = s.plans;
    expect(plan!.standard.map((x) => x.value)).toEqual([
      'Jane',
      'Doe-Example',
      'jane@example.com',
      '555 0100',
    ]);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('never split');
    expect(serialized).not.toContain('Jane Doe-Example');
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(SERVER);
  });

  it('a snapshot that is not ready is never fetched, and the report says to attach it yourself', async () => {
    const s = setup({
      current: json(200, {
        attempt: attempt({
          resume: { snapshotState: 'unsupported', filename: null, bytes: null },
        }),
        reason: null,
      }),
    });
    await clickFill(s);
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.plans[0]!.resume).toBeNull();
    expect(listed(s, 'Not filled in')).toContain('Resume: attach your resume yourself');
  });

  for (const [why, snapshot] of [
    ['refused (409)', json(409, { error: { code: 'snapshot_not_ready' } })],
    ['no longer handed off (404)', json(404, { error: { code: 'not_found' } })],
    ['not a PDF', pdf(PDF, 'text/html')],
    ['not the announced size', pdf(PDF.slice(0, 10))],
    ['without the PDF signature', pdf(new TextEncoder().encode('<html>placeholder....</html>'))],
  ] as const) {
    it(`a copy that is ${why} is not attached: attach it yourself`, async () => {
      const s = setup({ snapshot });
      await clickFill(s);
      expect(s.plans[0]!.resume).toBeNull();
      expect((s.page.doc.getElementById('resume') as HTMLInputElement).files).toHaveLength(0);
      expect(listed(s, 'Not filled in')).toContain('Resume: attach your resume yourself');
    });
  }

  it('a copy with no file name (deleted, while the state still reads ready) is not fetched (tl on #185)', async () => {
    const s = setup({
      current: json(200, {
        attempt: attempt({ resume: { snapshotState: 'ready', filename: null, bytes: null } }),
        reason: null,
      }),
    });
    await clickFill(s);
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.plans[0]!.resume).toBeNull();
    expect(listed(s, 'Not filled in')).toContain('Resume: attach your resume yourself');
  });

  it('a deleted copy (state deleted, #185) is not fetched: attach it yourself', async () => {
    const s = setup({
      current: json(200, {
        attempt: attempt({ resume: { snapshotState: 'deleted', filename: null, bytes: null } }),
        reason: null,
      }),
    });
    await clickFill(s);
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.plans[0]!.resume).toBeNull();
    expect(listed(s, 'Not filled in')).toContain('Resume: attach your resume yourself');
  });

  it('a copy refused as review_stale (409, #185) stops everything: nothing is filled', async () => {
    const s = setup({ snapshot: json(409, { error: { code: 'review_stale' } }) });
    await clickFill(s);
    expect(s.deps.runFill).not.toHaveBeenCalled();
    expect(valueOf(s.page.doc, 'first_name')).toBe('');
    expect(s.$('status').textContent).toMatch(/changed after you reviewed it/);
    expect(s.$('status').dataset.tone).toBe('error');
  });

  it('a copy with an empty file name is not fetched (tl on #187)', async () => {
    const s = setup({
      current: json(200, {
        attempt: attempt({ resume: { snapshotState: 'ready', filename: '', bytes: PDF.length } }),
        reason: null,
      }),
    });
    await clickFill(s);
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.plans[0]!.resume).toBeNull();
  });

  it('a copy larger than the server’s ceiling is not even fetched', async () => {
    const s = setup({
      current: json(200, {
        attempt: attempt({
          resume: { snapshotState: 'ready', filename: 'big.pdf', bytes: MAX_RESUME_BYTES + 1 },
        }),
        reason: null,
      }),
    });
    await clickFill(s);
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.plans[0]!.resume).toBeNull();
  });
});

describe('the resume is confirmed by the popup, not the page (tl and sec on #187)', () => {
  const resumeFiles = (s: ReturnType<typeof setup>) =>
    (s.page.doc.getElementById('resume') as HTMLInputElement).files;

  it('a name the form shows at once: attached, after one look, with no wait', async () => {
    const s = setup({});
    await clickFill(s);
    expect(s.deps.runResumeCheck).toHaveBeenCalledTimes(1);
    expect(s.deps.wait).not.toHaveBeenCalled();
    expect(s.deps.runResumeClear).not.toHaveBeenCalled();
    expect(listed(s, 'Filled in')).toContain('Resume');
    expect(resumeFiles(s)).toHaveLength(1);
  });

  it('a name the form shows after a macrotask, as React 19 does: attached', async () => {
    const s = setup({ showsFileName: 'macrotask' });
    await clickFill(s);
    expect((s.deps.runResumeCheck as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      1,
    );
    expect(s.deps.runResumeClear).not.toHaveBeenCalled();
    expect(listed(s, 'Filled in')).toContain('Resume');
    expect(resumeFiles(s)).toHaveLength(1);
  });

  it('a name the form never shows: looked for a bounded number of times, then the file is taken back out', async () => {
    const s = setup({ showsFileName: false });
    await clickFill(s);
    expect(s.deps.runResumeCheck).toHaveBeenCalledTimes(RESUME_CHECKS);
    expect(s.deps.wait).toHaveBeenCalledTimes(RESUME_CHECKS - 1);
    expect(s.deps.runResumeClear).toHaveBeenCalledTimes(1);
    expect(resumeFiles(s)).toHaveLength(0);
    expect(listed(s, 'Filled in')).not.toContain('Resume');
    expect(listed(s, 'Not filled in')).toContain('Resume: attach your resume yourself');
  });

  it('a name already on the form before the fill, and never shown after it: cleared, not attached (tl on #187)', async () => {
    const s = setup({
      showsFileName: false,
      html: MANY_QUESTIONS.replace('>Country<', '>Country (Jane-Resume.pdf)<'),
    });
    await clickFill(s);
    expect(s.deps.runResumeClear).toHaveBeenCalledTimes(1);
    expect(resumeFiles(s)).toHaveLength(0);
    expect(listed(s, 'Filled in')).not.toContain('Resume');
    expect(listed(s, 'Not filled in')).toContain('Resume: attach your resume yourself');
  });

  it('a name the form shows just before the clear: the clear looks again, and the resume is attached (tl on #187)', async () => {
    const s = setup({ showsFileName: false });
    const real = s.deps.runResumeClear;
    s.deps.runResumeClear = vi.fn(async (tabId: number, check: Parameters<typeof real>[1]) => {
      s.page.doc.querySelector('.file-upload__filename')!.textContent = 'Jane-Resume.pdf';
      return real(tabId, check);
    });
    await clickFill(s);
    expect(resumeFiles(s)).toHaveLength(1);
    expect(listed(s, 'Filled in')).toContain('Resume');
  });

  it('an input emptied meanwhile: attach your resume yourself, not "already had something" (tl on #187)', async () => {
    const s = setup({
      showsFileName: false,
      duringWait: (page, n) => {
        if (n === 1) {
          (page.doc.getElementById('resume') as HTMLInputElement).files =
            new page.window.DataTransfer().files as unknown as FileList;
        }
      },
    });
    await clickFill(s);
    expect(listed(s, 'Not filled in')).toContain('Resume: attach your resume yourself');
  });

  it('a cover letter is "attach this file yourself", never "your resume" (tl on #187)', async () => {
    const s = setup({
      html: MANY_QUESTIONS.replace(
        '<div class="file-upload">',
        '<div class="field-wrapper"><label for="cover_letter">Cover Letter</label><input id="cover_letter" type="file" class="visually-hidden" /></div><div class="file-upload">',
      ),
    });
    await clickFill(s);
    expect(listed(s, 'Not filled in')).toContain('Cover Letter: attach this file yourself');
  });

  it('a file the user attached meanwhile is kept, and the report says so', async () => {
    const s = setup({
      showsFileName: false,
      duringWait: (page, n) => {
        if (n !== 1) return;
        const theirs = new page.window.DataTransfer();
        theirs.items.add(
          new page.window.File(['their own'], 'My-Own-CV.pdf', { type: 'application/pdf' }),
        );
        (page.doc.getElementById('resume') as HTMLInputElement).files =
          theirs.files as unknown as FileList;
      },
    });
    await clickFill(s);
    expect(resumeFiles(s)?.[0]?.name).toBe('My-Own-CV.pdf');
    expect(listed(s, 'Not filled in')).toContain(
      'Resume: it already had something in it, so it was left as it was',
    );
  });

  it('the tab moving on between looks stops the checks; nothing is cleared, and the report says to check it', async () => {
    const s = setup({
      showsFileName: false,
      duringWait: (page, n) => {
        if (n === 1)
          page.window.happyDOM.setURL(`https://job-boards.greenhouse.io/${BOARD}/jobs/1000002`);
      },
    });
    await clickFill(s);
    expect(s.deps.runResumeCheck).toHaveBeenCalledTimes(2);
    expect(s.deps.runResumeClear).not.toHaveBeenCalled();
    expect(listed(s, 'Not filled in')).toContain(
      'Resume: it could not be checked: look at the resume on the form, and attach it yourself if it is missing or wrong',
    );
  });
});

describe('acceptance 4: a tab that is not the pinned posting fills nothing and says why', () => {
  it('not a Greenhouse posting: nothing is asked of the server', async () => {
    const s = setup({ tabUrl: 'https://careers.example.com/jobs/1000001' });
    await clickFill(s);
    expect(s.get).not.toHaveBeenCalled();
    expect(s.deps.runFill).not.toHaveBeenCalled();
    expect(s.$('status').textContent).toMatch(/Open the application's page on Greenhouse/);
  });

  it('an attempt pinned to another posting: no copy fetched, nothing injected', async () => {
    const s = setup({
      current: json(200, {
        attempt: attempt({
          destinationUrl: `https://boards.greenhouse.io/${BOARD}/jobs/1000002`,
        }),
        reason: null,
      }),
    });
    await clickFill(s);
    expect(s.get).toHaveBeenCalledTimes(1);
    expect(s.deps.runFill).not.toHaveBeenCalled();
    expect(s.$('status').textContent).toMatch(/not the posting this application was handed off to/);
    expect(valueOf(s.page.doc, 'first_name')).toBe('');
  });

  it('an attempt pinned to the same job id on another board: nothing injected (tl on #187)', async () => {
    const s = setup({
      current: json(200, {
        attempt: attempt({
          destinationUrl: `https://boards.greenhouse.io/othercorp/jobs/${JOB_ID}`,
        }),
        reason: null,
      }),
    });
    await clickFill(s);
    expect(s.deps.runFill).not.toHaveBeenCalled();
    expect(s.$('status').textContent).toMatch(/not the posting this application was handed off to/);
  });

  it('a tab on a non-default port is not a Greenhouse posting: nothing is asked (tl on #187)', async () => {
    const s = setup({ tabUrl: `https://job-boards.greenhouse.io:8443/${BOARD}/jobs/${JOB_ID}` });
    await clickFill(s);
    expect(s.get).not.toHaveBeenCalled();
    expect(s.deps.runFill).not.toHaveBeenCalled();
  });

  it('the tab moved on before the fill: the filler’s own check stops it', async () => {
    const s = setup({});
    // The popup saw the posting; the page is elsewhere by the time the filler runs.
    s.page.window.happyDOM.setURL(`https://job-boards.greenhouse.io/${BOARD}/jobs/1000002`);
    await clickFill(s);
    expect(s.deps.runFill).toHaveBeenCalledTimes(1);
    expect(s.$('status').textContent).toMatch(/moved off this application's posting/);
    expect(valueOf(s.page.doc, 'first_name')).toBe('');
    expect(s.$('prefill-report').textContent).toBe('');
  });
});

describe('every stop before a fill says why, and fills nothing', () => {
  for (const [what, current, words] of [
    [
      'no attempt for this page',
      json(200, { attempt: null, reason: 'no_matching_attempt' }),
      /None of your applications was handed off to this posting/,
    ],
    [
      'two attempts',
      json(200, { attempt: null, reason: 'several_handed_off' }),
      // Reachable through the real routes: a re-application from a second opportunity handed off
      // while the first still is (qa, tl on #183). Which one is meant cannot be known: refuse.
      /You have two applications open for this job\. In Opportun, record the earlier one \(I submitted it, or I did not submit it\), then try again\. Nothing was filled\./,
    ],
    [
      'a stale review',
      json(200, { attempt: null, reason: 'review_stale' }),
      /changed after you reviewed it/,
    ],
    [
      'a token without apply:assist (403)',
      json(403, { error: { code: 'insufficient_scope' } }),
      /can't fill in applications.*Also let it fill in applications you hand off.*revoke the old/,
    ],
    ['a rejected token (401)', json(401, {}), /rejected the token/],
    ['the feature off (404)', json(404, {}), /not turned on/],
    ['a rate limit (429)', json(429, {}, { 'retry-after': '120' }), /about 2 minute/],
    ['a malformed answer', json(200, { attempt: { id: 1 } }), /unexpected response \(200\)/],
    ['the server down', () => Promise.reject(new Error('offline')), /Could not reach the server/],
  ] as const) {
    it(`${what}`, async () => {
      const s = setup({ current });
      await clickFill(s);
      expect(s.deps.runFill).not.toHaveBeenCalled();
      expect(s.$('status').textContent).toMatch(words);
      expect(s.$('status').dataset.tone).toBe('error');
    });
  }

  it('an injection that failed says so', async () => {
    const s = setup({ fill: 'fails' });
    await clickFill(s);
    expect(s.$('status').textContent).toMatch(/could not run in this tab/);
  });
});

describe('the report is text, never markup', () => {
  it('a label the page wrote as markup is shown as plain text', async () => {
    const s = setup({});
    const label = s.page.doc.getElementById('question_9000111-label')!;
    label.textContent = '<img src=x onerror=alert(1)>';
    await clickFill(s);
    expect(s.$('prefill-report').querySelector('img')).toBeNull();
    expect(listed(s, 'Not filled in')).toContain(
      '<img src=x onerror=alert(1)>: not in what you reviewed: answer it on the form',
    );
  });
});

describe('#192 in the popup: a shared label is listed for the user to fill', () => {
  it('a text question and a dropdown both labelled Website: listed as not filled, with why', async () => {
    const s = setup({
      html: MANY_QUESTIONS.replace(
        '<h2>Voluntary Self-Identification</h2>',
        '<div class="field-wrapper"><label for="q_select">Website</label><select id="q_select"><option>Yes</option></select></div><h2>Voluntary Self-Identification</h2>',
      ),
    });
    await clickFill(s);
    expect(valueOf(s.page.doc, 'question_9000102')).toBe('');
    expect(listed(s, 'Filled in')).not.toContain('Website');
    expect(listed(s, 'Not filled in')).toContain(
      'Website: more than one question or answer has this label, so it was not filled: answer it on the form',
    );
  });
});

describe('#196: a field the server withholds is listed for the user, with its own reason', () => {
  it("a withheld LinkedIn address is not filled, and is listed once, under the form's label (tl on #201)", async () => {
    const fields: Record<string, string> = { ...attempt().fields };
    delete fields.linkedinUrl;
    const s = setup({
      current: json(200, {
        attempt: { ...attempt({ fields }), withheld: ['linkedinUrl'] },
        reason: null,
      }),
    });
    await clickFill(s);
    expect(valueOf(s.page.doc, 'question_9000110')).toBe('');
    const lines = listed(s, 'Not filled in');
    expect(lines).toContain(
      "LinkedIn Profile: it no longer passes Opportun's checks: correct it in Opportun, or fill it in yourself",
    );
    // Once, with that reason only: never also "not in what you reviewed".
    expect(lines.filter((l) => l.startsWith('LinkedIn'))).toHaveLength(1);
    // The plan carries the field's name and labels, never a value.
    expect(s.plans[0]!.withheld).toEqual([
      { id: null, labels: ['LinkedIn Profile', 'LinkedIn'], name: 'LinkedIn profile' },
    ]);
    // The rest of the form is filled as usual.
    expect(listed(s, 'Filled in')).toContain('First Name');
  });

  it("each withheld key is listed once: under the form's label, or its own name when the form lacks it", async () => {
    const s = setup({
      current: json(200, {
        attempt: {
          ...attempt({ fields: { email: 'jane@example.com' } }),
          withheld: ['firstName', 'websiteUrl', 'someOther'],
        },
        reason: null,
      }),
    });
    await clickFill(s);
    const lines = listed(s, 'Not filled in');
    for (const label of ['First Name', 'Website', 'someOther']) {
      expect(lines).toContain(
        `${label}: it no longer passes Opportun's checks: correct it in Opportun, or fill it in yourself`,
      );
    }
    for (const label of ['First Name', 'Website']) {
      expect(lines.filter((l) => l.startsWith(`${label}:`))).toHaveLength(1);
    }
    expect(valueOf(s.page.doc, 'first_name')).toBe('');
  });

  it('a withheld list that is not a list of names is an unexpected answer: nothing is filled', async () => {
    const s = setup({
      current: json(200, { attempt: { ...attempt(), withheld: 'linkedinUrl' }, reason: null }),
    });
    await clickFill(s);
    expect(s.deps.runFill).not.toHaveBeenCalled();
    expect(s.$('status').textContent).toMatch(/unexpected response \(200\)/);
  });
});

describe('#203 in the popup: a withheld email or phone is listed once', () => {
  it("under the form's Email and Phone labels, and neither is filled", async () => {
    const fields: Record<string, string> = { ...attempt().fields };
    delete fields.email;
    delete fields.phone;
    const s = setup({
      current: json(200, {
        attempt: { ...attempt({ fields }), withheld: ['email', 'phone'] },
        reason: null,
      }),
    });
    await clickFill(s);
    expect(valueOf(s.page.doc, 'email')).toBe('');
    expect(valueOf(s.page.doc, 'phone')).toBe('');
    const lines = listed(s, 'Not filled in');
    for (const label of ['Email', 'Phone']) {
      expect(lines.filter((l) => l.startsWith(`${label}:`))).toEqual([
        `${label}: it no longer passes Opportun's checks: correct it in Opportun, or fill it in yourself`,
      ]);
    }
  });
});

describe('#204 in the popup: an answer for a dropdown is listed once', () => {
  it('a reviewed answer for Gender reads "choose it on the form", never also "no question"', async () => {
    const s = setup({
      current: json(200, {
        attempt: attempt({
          answers: [
            { label: 'Why us?', value: 'Placeholder answer.' },
            { label: 'Gender', value: 'Placeholder' },
          ],
        }),
        reason: null,
      }),
    });
    await clickFill(s);
    const gender = listed(s, 'Not filled in').filter((l) => l.startsWith('Gender:'));
    expect(gender).toEqual(['Gender: choose it on the form']);
  });
});

describe('buildPlan', () => {
  it('maps each withheld key to the field it names, with no value (#196, tl on #201)', () => {
    const p = buildPlan(
      { ...attempt(), firstRead: false, withheld: ['firstName', 'websiteUrl', 'someOther'] },
      { board: BOARD, jobId: JOB_ID },
      null,
    );
    expect(p.withheld).toEqual([
      { id: 'first_name', labels: [], name: 'First name' },
      { id: null, labels: ['Website'], name: 'Website' },
      { id: null, labels: [], name: 'someOther' },
    ]);
    expect(JSON.stringify(p.withheld)).not.toContain('@');
  });

  it('maps the four standard fields by id and the two links and answers by label, leaving out empty values', () => {
    const p = buildPlan(
      {
        withheld: [],
        firstRead: false,
        ...attempt({ fields: { firstName: 'Jane', websiteUrl: 'https://jane.example.com' } }),
      },
      { board: BOARD, jobId: JOB_ID },
      null,
    );
    expect(p.standard).toEqual([{ id: 'first_name', name: 'First name', value: 'Jane' }]);
    expect(p.questions).toEqual([
      { labels: ['Website'], name: 'Website', value: 'https://jane.example.com' },
      { labels: ['Why us?'], name: 'Why us?', value: 'Placeholder answer.' },
    ]);
    expect(p.resume).toBeNull();
  });

  it('the LinkedIn address matches a question labelled "LinkedIn Profile" or plain "LinkedIn" (qa on #187)', () => {
    const p = buildPlan(
      { withheld: [], firstRead: false, ...attempt() },
      { board: BOARD, jobId: JOB_ID },
      null,
    );
    expect(p.questions[0]).toEqual({
      labels: ['LinkedIn Profile', 'LinkedIn'],
      name: 'LinkedIn profile',
      value: 'https://www.linkedin.com/in/jane-doe-example',
    });
  });

  it('end to end: a form question labelled plain "LinkedIn" is filled from the reviewed attempt (qa on #187)', async () => {
    const s = setup({ html: MANY_QUESTIONS.replace('>LinkedIn Profile<', '>LinkedIn<') });
    await clickFill(s);
    expect(valueOf(s.page.doc, 'question_9000110')).toBe(
      'https://www.linkedin.com/in/jane-doe-example',
    );
    expect(listed(s, 'Filled in')).toContain('LinkedIn');
  });
});

describe('#191: a popup that closes before the resume check ends', () => {
  it('says to keep the window open while it checks, and leaves no note once it has its answer', async () => {
    const store = memoryStore();
    const seen: string[] = [];
    const s = setup({
      showsFileName: false,
      checkStore: store,
      duringWait: () => {
        seen.push(s.$('status').textContent ?? '');
        seen.push(JSON.stringify(store.data['resumeCheckPending:7']));
      },
    });
    await clickFill(s);
    expect(seen[0]).toBe(RESUME_CHECKING);
    // While it checks, the note names this tab and posting (and nothing of the resume).
    expect(JSON.parse(seen[1]!)).toEqual({
      tabId: 7,
      board: BOARD,
      jobId: JOB_ID,
      at: expect.any(Number),
      stage: 'resume',
    });
    expect(store.data['resumeCheckPending:7']).toBeNull();
  });

  it('the next popup on that tab says the resume was not confirmed, once', async () => {
    const store = memoryStore();
    const first = setup({ checkStore: store, showsFileName: false });
    // The popup is gone mid-check: its next look never comes back.
    first.deps.runResumeCheck = vi.fn(() => new Promise<number | null>(() => undefined));
    await mountPopup(first.doc, first.deps);
    // The open's lookup decides first: the button is held until it has (#403).
    await settleOpen(first);
    first.$('prefill').click();
    await vi.waitFor(() => expect(first.$('status').textContent).toBe(RESUME_CHECKING));
    expect(store.data['resumeCheckPending:7']).not.toBeNull();

    const next = setup({ checkStore: store });
    await mountPopup(next.doc, next.deps);
    await vi.waitFor(() => expect(next.$('status').textContent).toBe(RESUME_UNCONFIRMED));
    expect(store.data['resumeCheckPending:7']).toBeNull();
    // Nothing was asked of the page to say so, and of the server only the lookup that opening
    // the popup over the posting makes (#403): not a first read here, so nothing is filled.
    expect(next.get).toHaveBeenCalledTimes(1);
    expect(next.get.mock.calls[0]![0]).toContain('/connector/apply/current?');
    expect(next.deps.runFill).not.toHaveBeenCalled();
    expect(next.deps.runResumeCheck).not.toHaveBeenCalled();

    const again = setup({ checkStore: store });
    await mountPopup(again.doc, again.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(again.$('status').textContent).toBe('');
  });

  it('a popup on another tab says nothing and leaves the note for its own tab', async () => {
    const store = memoryStore();
    store.data['resumeCheckPending:7'] = { tabId: 7, board: BOARD, jobId: JOB_ID, at: Date.now() };
    const other = setup({ checkStore: store, tabId: 8 });
    await mountPopup(other.doc, other.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(other.$('status').textContent).toBe('');
    expect(store.data['resumeCheckPending:7']).not.toBeNull();
  });

  it("a fill in another tab keeps this tab's unfinished note (tl on #202)", async () => {
    const store = memoryStore();
    const pending = { tabId: 7, board: BOARD, jobId: JOB_ID, at: Date.now() };
    store.data['resumeCheckPending:7'] = pending;
    const other = setup({ checkStore: store, tabId: 8, showsFileName: false });
    await clickFill(other);
    expect(store.data['resumeCheckPending:7']).toEqual(pending);
    expect(store.data['resumeCheckPending:8']).toBeNull();
    const back = setup({ checkStore: store, tabId: 7 });
    await mountPopup(back.doc, back.deps);
    await vi.waitFor(() => expect(back.$('status').textContent).toBe(RESUME_UNCONFIRMED));
  });

  it('on that tab but another page, or after an hour, it is dropped without a word', async () => {
    for (const [note, tabUrl] of [
      [{ tabId: 7, board: BOARD, jobId: JOB_ID, at: Date.now() }, 'https://example.com/'],
      [{ tabId: 7, board: BOARD, jobId: JOB_ID, at: Date.now() - 61 * 60 * 1000 }, undefined],
    ] as const) {
      const store = memoryStore();
      store.data['resumeCheckPending:7'] = note;
      const s = setup({ checkStore: store, ...(tabUrl === undefined ? {} : { tabUrl }) });
      await mountPopup(s.doc, s.deps);
      await vi.waitFor(() => expect(store.data['resumeCheckPending:7']).toBeNull());
      expect(s.$('status').textContent).toBe('');
    }
  });

  it('a browser without storage.session still fills and checks, with no note', async () => {
    const s = setup({ checkStore: null });
    await clickFill(s);
    expect(listed(s, 'Filled in')).toContain('Resume');
  });
});

describe('#402 slice 2: the fill waits for lists, and the report lists every choice first', () => {
  it('says it is filling while it runs, with a note for this tab, and clears the note after', async () => {
    const store = memoryStore();
    const s = setup({ checkStore: store, snapshot: json(404, {}) });
    let finish: (() => void) | undefined;
    const run = s.deps.runFill;
    s.deps.runFill = vi.fn(async (tabId: number, plan: FillPlan) => {
      await new Promise<void>((r) => {
        finish = r;
      });
      return run(tabId, plan);
    });
    await mountPopup(s.doc, s.deps);
    // The open's lookup decides first: the button is held until it has (#403).
    await settleOpen(s);
    s.$('prefill').click();
    await vi.waitFor(() => expect(s.$('status').textContent).toBe(FILLING));
    expect(store.data['resumeCheckPending:7']).toEqual({
      tabId: 7,
      board: BOARD,
      jobId: JOB_ID,
      at: expect.any(Number),
      stage: 'fill',
    });
    finish!();
    await vi.waitFor(() => expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false));
    expect(store.data['resumeCheckPending:7']).toBeNull();
  });

  it('a popup closed before the report arrives: the next one on that tab says the result was not seen, once', async () => {
    const store = memoryStore();
    const first = setup({ checkStore: store });
    first.deps.runFill = vi.fn(() => new Promise<null>(() => undefined));
    await mountPopup(first.doc, first.deps);
    // The open's lookup decides first: the button is held until it has (#403).
    await settleOpen(first);
    first.$('prefill').click();
    await vi.waitFor(() => expect(first.$('status').textContent).toBe(FILLING));

    const next = setup({ checkStore: store });
    await mountPopup(next.doc, next.deps);
    await vi.waitFor(() => expect(next.$('status').textContent).toBe(FILL_UNSEEN));
    expect(store.data['resumeCheckPending:7']).toBeNull();
    expect(next.deps.runFill).not.toHaveBeenCalled();
  });

  it('every option chosen is listed first, as "field: the text chosen"', async () => {
    const s = setup({ snapshot: json(404, {}) });
    s.deps.runFill = vi.fn(async () => ({
      ok: true as const,
      chosen: [{ label: 'Phone country code', text: 'United States +1' }],
      filled: ['First Name'],
      notFilled: [
        { label: 'School', reason: 'no_option' as const, detail: 'University of Example' },
      ],
      resume: null,
    }));
    await clickFill(s);
    const headings = Array.from(s.$('prefill-report').querySelectorAll('h3')).map(
      (h) => h.textContent,
    );
    expect(headings[0]).toBe('Chosen from a list: check each before you submit');
    expect(listed(s, 'Chosen from a list: check each before you submit')).toEqual([
      'Phone country code: United States +1',
    ]);
    expect(listed(s, 'Not filled in')).toContain(
      'School: no option on the form\'s list is exactly "University of Example": choose it on the form',
    );
  });

  it('a value with replacement patterns is shown as it is (sec at 8084132)', () => {
    const lines = reportLines({
      ok: true,
      chosen: [],
      filled: [],
      notFilled: [{ label: 'School', reason: 'no_option', detail: "$& $' $` $$" }],
      resume: null,
    });
    expect(lines.notFilled).toEqual([
      'School: no option on the form\'s list is exactly "$& $\' $` $$": choose it on the form',
    ]);
  });

  it('the list reasons in words, each with its value', () => {
    const lines = reportLines({
      ok: true,
      chosen: [],
      filled: [],
      notFilled: [
        { label: 'Degree', reason: 'several_options', detail: 'BA' },
        { label: 'School', reason: 'list_not_shown', detail: 'University of Example' },
        { label: 'Degree', reason: 'not_confirmed', detail: "Bachelor's Degree" },
      ],
      resume: null,
    });
    expect(lines.notFilled).toEqual([
      'Degree: more than one option is exactly "BA": choose it on the form',
      "School: the form's list did not appear in time: choose it on the form",
      'Degree: the form did not show the choice "Bachelor\'s Degree": check this field',
    ]);
  });
});

// #403 slice 2 (tl's design note with sec's rulings, conditions 1 to 5): opening the popup over
// the handed-off posting fills it at once, the first time only. The server says which read is
// the first (firstRead); the popup's own checks are the button's, unchanged.
describe('#403: opening the popup on the handed-off posting fills it, once', () => {
  const HOST = new URL(TAB_URL).host;
  const first = (over: Partial<AttemptJson & { firstRead: boolean }> = {}) =>
    json(200, { attempt: { ...attempt(), firstRead: true, ...over }, reason: null });

  /** Mounts the popup, recording the status line whenever the filler is run. */
  async function open(s: ReturnType<typeof setup>) {
    const atFill: string[] = [];
    const run = s.deps.runFill;
    s.deps.runFill = vi.fn(async (tabId: number, plan: FillPlan) => {
      atFill.push(s.$('status').textContent ?? '');
      return run(tabId, plan);
    });
    await mountPopup(s.doc, s.deps);
    return atFill;
  }

  it('the first read: it says what it is filling, fills once, and shows the report', async () => {
    const s = setup({ current: first() });
    const atFill = await open(s);
    await vi.waitFor(() => expect(s.deps.runFill).toHaveBeenCalledTimes(1));
    expect(atFill).toEqual([
      `Filling the application for Senior Platform Engineer at Example Corp on ${HOST}. Keep this window open until the report shows (up to a few seconds for each list).`,
    ]);
    await vi.waitFor(() => expect(listed(s, 'Filled in')).toContain('First Name'));
    expect(valueOf(s.page.doc, 'first_name')).toBe('Jane');
    expect(s.$('status').textContent).toMatch(/has not submitted anything.*own Submit button/);
    // One lookup, for this tab, then the copy: the same reads the button makes.
    const urls = s.get.mock.calls.map(([u]) => u);
    expect(urls).toEqual([
      `${SERVER}/api/v1/connector/apply/current?url=${encodeURIComponent(TAB_URL)}`,
      `${SERVER}/api/v1/connector/apply/sub-1/snapshot`,
    ]);
    await vi.waitFor(() => expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false));
  });

  it.each([
    ['a later read', { firstRead: false }],
    ['a server that does not say (before #403)', {}],
  ])('%s: nothing is filled, and the button is there as today', async (_n, over) => {
    const s = setup({ current: json(200, { attempt: { ...attempt(), ...over }, reason: null }) });
    await open(s);
    await vi.waitFor(() => expect(s.get).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.deps.runFill).not.toHaveBeenCalled();
    expect(s.$('assist').hidden).toBe(false);
    expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false);
    expect(s.$('status').textContent).toBe('');
  });

  it.each([
    ['another posting', `https://boards.greenhouse.io/${BOARD}/jobs/1000002`],
    ['the same job id on another board', `https://boards.greenhouse.io/othercorp/jobs/${JOB_ID}`],
  ])('an attempt pinned to %s: nothing filled, nothing said', async (_n, destinationUrl) => {
    const s = setup({ current: first({ destinationUrl }) });
    await open(s);
    await vi.waitFor(() => expect(s.get).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.deps.runFill).not.toHaveBeenCalled();
    expect(s.$('status').textContent).toBe('');
    expect(valueOf(s.page.doc, 'first_name')).toBe('');
  });

  it.each([
    ['a miss', json(200, { attempt: null, reason: 'no_matching_attempt' })],
    ['a server error', json(500, {})],
    ['a revoked token', json(401, {})],
    [
      'no network',
      async () => {
        throw new Error('offline');
      },
    ],
  ] as const)('%s on open: no error shown, the button stays', async (_n, current) => {
    const s = setup({
      current: typeof current === 'function' ? current : (current as FetchResponse),
    });
    await open(s);
    await vi.waitFor(() => expect(s.get).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.deps.runFill).not.toHaveBeenCalled();
    expect(s.$('status').textContent).toBe('');
    expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ['a page that is not a Greenhouse posting', 'https://careers.example.com/jobs/1000001'],
    ['a capture site', 'https://www.linkedin.com/jobs/view/3901234567/'],
  ])('%s: nothing is asked on open', async (_n, tabUrl) => {
    const s = setup({ tabUrl, current: first() });
    await open(s);
    await vi.waitFor(() => expect(s.deps.activeTab).toHaveBeenCalled());
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.get).not.toHaveBeenCalled();
    expect(s.deps.runFill).not.toHaveBeenCalled();
  });

  it('no token saved: nothing is asked on open, and nothing is said', async () => {
    const s = setup({ current: first() });
    await s.deps.storage.set({ token: '' });
    await open(s);
    await vi.waitFor(() => expect(s.deps.activeTab).toHaveBeenCalled());
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.get).not.toHaveBeenCalled();
    expect(s.$('status').textContent).toBe('');
  });

  // tl's blocking 1 at 650aaf7 (qa reproduced it): a click while the open's lookup is out must not
  // start a second fill beside the one the open starts.
  it("a click while the open's lookup is out waits for it: one fill, never two at once", async () => {
    let release: (r: FetchResponse) => void = () => undefined;
    const held = new Promise<FetchResponse>((r) => {
      release = r;
    });
    const s = setup({ current: () => held });
    await open(s);
    await vi.waitFor(() => expect(s.get).toHaveBeenCalledTimes(1));
    // The section shows, but its button waits for the open to decide.
    expect(s.$('assist').hidden).toBe(false);
    expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(true);
    s.$('prefill').click();
    release(first());
    await vi.waitFor(() => expect(s.deps.runFill).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.deps.runFill).toHaveBeenCalledTimes(1);
    // Only the open's lookup and its copy: the click sent nothing.
    expect(s.get.mock.calls.filter(([u]) => u.includes('/current?'))).toHaveLength(1);
  });

  it('a failure before the lookup never leaves the button held', async () => {
    const s = setup({ current: first() });
    // tellUnfinishedCheck reads storage.session first: it fails here.
    s.deps.checkStore = {
      get: async () => {
        throw new Error('storage unavailable');
      },
      set: async () => undefined,
    };
    await open(s);
    await vi.waitFor(() => expect(s.deps.activeTab).toHaveBeenCalled());
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false);
  });

  // qa at 21274b2: the other window. Work that ends while the open's lookup is still out (Test
  // connection, here) must not free Fill either.
  it("another button's work ending during the open's lookup leaves Fill held: one fill", async () => {
    let release: (r: FetchResponse) => void = () => undefined;
    const held = new Promise<FetchResponse>((r) => {
      release = r;
    });
    const s = setup({ current: () => held });
    await open(s);
    await vi.waitFor(() => expect(s.get).toHaveBeenCalledTimes(1));
    // Test connection's work, which ends at once here (the harness refuses its request).
    s.$('test').click();
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(true);
    s.$('prefill').click();
    release(first());
    await vi.waitFor(() => expect(s.deps.runFill).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.deps.runFill).toHaveBeenCalledTimes(1);
  });

  // The count itself (tl's fix (a) at 21274b2): work that starts while the buttons are held, here
  // the settings form submitted directly, which a user cannot do while Save is disabled, ends
  // without freeing them while the open still decides.
  it('work that ends while the open still decides frees no button: the count, not the last finally', async () => {
    let release: (r: FetchResponse) => void = () => undefined;
    const held = new Promise<FetchResponse>((r) => {
      release = r;
    });
    const s = setup({ current: () => held });
    await open(s);
    await vi.waitFor(() => expect(s.get).toHaveBeenCalledTimes(1));
    s.$('settings').dispatchEvent(new s.doc.defaultView!.Event('submit', { cancelable: true }));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(true);
    s.$('prefill').click();
    release(first());
    await vi.waitFor(() => expect(s.deps.runFill).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(s.deps.runFill).toHaveBeenCalledTimes(1);
  });

  // tl at 21274b2: busy() was not exclusive, so another piece of work ending during the open's fill
  // (Record, here) re-enabled Fill mid-fill. No fill may start while any work runs.
  it("Record ending during the open's fill leaves Fill held: one fill, never two", async () => {
    let releaseCurrent: (r: FetchResponse) => void = () => undefined;
    const current = new Promise<FetchResponse>((r) => {
      releaseCurrent = r;
    });
    let releaseConfirm: (r: FetchResponse) => void = () => undefined;
    const confirmable = new Promise<FetchResponse>((r) => {
      releaseConfirm = r;
    });
    const s = setup({ current: () => current });
    const realGet = s.get.getMockImplementation()!;
    s.get.mockImplementation(async (url, init) =>
      url.includes('/connector/apply/confirmable?') ? confirmable : realGet(url, init),
    );
    // The open's fill stays in progress: runFill never answers in this test.
    const fills: number[] = [];
    s.deps.runFill = vi.fn(async () => {
      fills.push(fills.length);
      return new Promise<null>(() => undefined);
    });
    await mountPopup(s.doc, s.deps);
    await vi.waitFor(() => expect(s.get).toHaveBeenCalledTimes(1));
    // 1. While the open's lookup is out, Record is clicked.
    s.$('record').click();
    // 2. The open's lookup answers: its fill starts.
    releaseCurrent(first());
    await vi.waitFor(() => expect(fills).toHaveLength(1));
    // 3. Record's lookup answers, so its work ends while the open's fill is still running.
    releaseConfirm(json(404, { error: { code: 'feature_unavailable' } }));
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    // 4. Fill stays held, and a click on it starts nothing.
    expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(true);
    s.$('prefill').click();
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(fills).toHaveLength(1);
  });

  it('after a later read on open, the button is free again and fills on a click', async () => {
    const s = setup({ current: first({ firstRead: false }) });
    await open(s);
    await vi.waitFor(() => expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false));
    expect(s.deps.runFill).not.toHaveBeenCalled();
    s.$('prefill').click();
    await vi.waitFor(() => expect(s.deps.runFill).toHaveBeenCalledTimes(1));
  });

  it('after the fill on open, the button still fills again on purpose', async () => {
    const s = setup({ current: first() });
    await open(s);
    await vi.waitFor(() => expect(s.deps.runFill).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((s.$('prefill') as HTMLButtonElement).disabled).toBe(false));
    s.$('prefill').click();
    await vi.waitFor(() => expect(s.deps.runFill).toHaveBeenCalledTimes(2));
  });
});
