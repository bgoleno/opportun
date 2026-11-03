// Assisted apply prefill in the popup (#183): from the click to the report, against a stubbed
// server (the GET /connector/apply contract of #182) and the synthetic forms, with the real
// filler run on them. Every value here is a placeholder.
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import type { FetchResponse } from '../src/api';
import { fillGreenhouseForm, type FillPlan } from '../src/greenhouseFill';
import { buildPlan, MAX_RESUME_BYTES, type GetLike, type PrefillAttempt } from '../src/prefill';
import { mountPopup, type PopupDeps } from '../src/popupController';
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

function attempt(over: Partial<PrefillAttempt> = {}): PrefillAttempt {
  return {
    id: 'sub-1',
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

function setup(opts: {
  tabUrl?: string;
  current?: FetchResponse | (() => Promise<FetchResponse>);
  snapshot?: FetchResponse;
  showsFileName?: boolean;
  fill?: 'fixture' | 'fails';
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
  const page = loadForm(MANY_QUESTIONS, {
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
  const deps: PopupDeps = {
    storage,
    fetch: vi.fn(async () => {
      throw new Error('prefill never POSTs');
    }),
    get,
    activeTab: vi.fn(async () => ({ id: 7, url: opts.tabUrl ?? TAB_URL })),
    runExtract: vi.fn(async () => null),
    runFill: vi.fn(async (_tabId: number, plan: FillPlan) => {
      // As executeScript's args travel: JSON only. A plan that did not survive would differ.
      const sent = JSON.parse(JSON.stringify(plan)) as FillPlan;
      expect(sent).toEqual(plan);
      plans.push(sent);
      return opts.fill === 'fails' ? null : fillGreenhouseForm(sent, page.doc);
    }),
    requestOrigin: vi.fn(async () => true),
    hasOrigin: vi.fn(async () => true),
    bakedServerUrl: vi.fn(async () => ''),
  };
  const $ = (id: string) => doc.getElementById(id)!;
  return { doc, deps, get, page, plans, $ };
}

async function clickFill(s: ReturnType<typeof setup>) {
  await mountPopup(s.doc, s.deps);
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
        'Country: choose it on the form',
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

describe('buildPlan', () => {
  it('maps the four standard fields by id and the two links and answers by label, leaving out empty values', () => {
    const p = buildPlan(
      attempt({ fields: { firstName: 'Jane', websiteUrl: 'https://jane.example.com' } }),
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
});
