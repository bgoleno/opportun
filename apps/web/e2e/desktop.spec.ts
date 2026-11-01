// Desktop widths (issue https://github.com/bgoleno/opportun/issues/33; the standard is
// docs/design.md section 9, "Layout widths"). The desktop counterpart of mobile.spec.ts: at four
// window widths it walks the same routes (e2e/routes.ts), plus seeded views that hold long text,
// and fails when
//   - a block of text that wraps onto two or more lines has a line wider than MAX_CH, measured
//     per line box with Range.getClientRects() against a 1ch probe in that block's own font
//     (text on a single line, such as a table cell, a truncated row or a kanban card, is scanned
//     rather than read, and is not measured), or
//   - a page-width view's content box is wider than the page cap or is off-centre in the main
//     area. The cap is read from the --container-page token, never written here: its value is
//     the owner's call.
// Views that do not conform yet are expected failures (KNOWN below), each naming the issue that
// fixes it. Playwright fails an expected failure that passes, so a fix has to remove its entry
// and the list can only shrink.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN } from './global-setup';
import { PASSWORD } from './helpers';
import { ADMIN_ROUTES, USER_ROUTES } from './routes';

const WIDTHS = [1280, 1536, 1920, 2560] as const;
const HEIGHT = 900;
const MAX_CH = 80;

/**
 * Views that do not meet the standard yet, by test title (the route, or a seeded view's name),
 * with the window widths they fail at and the issue that fixes them. Empty until the first CI
 * run shows what fails.
 */
const KNOWN = new Map<string, { widths: readonly number[]; issue: string }>([]);

/**
 * Everything wrong with the view on screen: a wrapped line wider than MAX_CH (naming the element,
 * its measured width in ch and the start of its text), and a page-width content box that is wider
 * than the page cap or off-centre.
 */
async function findings(page: Page): Promise<string[]> {
  return page.evaluate((maxCh) => {
    const out: string[] = [];
    const main = document.getElementById('main');
    const box = main?.querySelector<HTMLElement>('[data-layout]');
    if (main === null || main === undefined || box === null || box === undefined) {
      return ['no #main [data-layout] content box'];
    }

    const describe = (el: Element) =>
      `<${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className !== '' ? ` class="${el.className.slice(0, 60)}"` : ''}>`;

    // The page cap, for a page-width view.
    if (box.dataset.layout === 'page') {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--container-page)';
      document.body.append(probe);
      const cap = probe.getBoundingClientRect().width;
      probe.remove();
      const mainRect = main.getBoundingClientRect();
      const cs = getComputedStyle(main);
      const inner = {
        left: mainRect.left + parseFloat(cs.paddingLeft),
        right: mainRect.right - parseFloat(cs.paddingRight),
      };
      const r = box.getBoundingClientRect();
      const left = r.left - inner.left;
      const right = inner.right - r.right;
      if (!(cap > 0)) out.push('could not read the page cap from --container-page');
      else if (r.width > cap + 0.5) {
        out.push(`content box is ${r.width.toFixed(1)}px, wider than the page cap (${cap}px)`);
      }
      if (Math.abs(left - right) > 1) {
        out.push(
          `content box is off-centre: ${left.toFixed(1)}px on the left, ${right.toFixed(1)}px on the right`,
        );
      }
    }

    // Line length. Text is grouped by the box it flows in (the nearest ancestor that is not
    // inline), so a line that mixes plain and formatted text is measured as one line.
    const blockOf = (el: Element): Element => {
      for (let e: Element | null = el; e !== null && e !== main; e = e.parentElement) {
        const d = getComputedStyle(e).display;
        if (!d.startsWith('inline') && d !== 'contents') return e;
      }
      return main;
    };
    const rectsByBlock = new Map<Element, DOMRect[]>();
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent === null || (node.textContent ?? '').trim() === '') continue;
      if (parent.closest('textarea, input, select, script, style, svg, .sr-only') !== null)
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (rects.length === 0) continue;
      const block = blockOf(parent);
      rectsByBlock.set(block, [...(rectsByBlock.get(block) ?? []), ...rects]);
    }
    for (const [block, rects] of rectsByBlock) {
      // Rects that overlap vertically by more than half of the shorter one share a line.
      const lines: { top: number; bottom: number; left: number; right: number }[] = [];
      for (const r of [...rects].sort((a, b) => a.top - b.top)) {
        const line = lines.find(
          (l) =>
            Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) >
            Math.min(l.bottom - l.top, r.height) / 2,
        );
        if (line === undefined) {
          lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        } else {
          line.left = Math.min(line.left, r.left);
          line.right = Math.max(line.right, r.right);
          line.top = Math.min(line.top, r.top);
          line.bottom = Math.max(line.bottom, r.bottom);
        }
      }
      if (lines.length < 2) continue;
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;display:inline-block;width:1ch';
      block.append(probe);
      const ch = probe.getBoundingClientRect().width;
      probe.remove();
      if (!(ch > 0)) continue;
      const widest = Math.max(...lines.map((l) => l.right - l.left)) / ch;
      if (widest > maxCh) {
        const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        out.push(
          `${describe(block)} has a ${widest.toFixed(1)}ch line (${lines.length} lines): "${text}"`,
        );
      }
    }
    return out;
  }, MAX_CH);
}

/** Opens `path` at this test's width and expects it to meet the standard. */
async function expectStandard(page: Page, path: string, width: number, title: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#main [data-layout]')).toBeVisible();
  const found = await findings(page);
  expect(found, `${title} at ${width}px:\n  ${found.join('\n  ')}`).toEqual([]);
}

/** Marks this test as an expected failure when KNOWN lists it at this width. */
function known(title: string, width: number): void {
  const entry = KNOWN.get(title);
  test.fail(entry?.widths.includes(width) === true, entry?.issue);
}

// ---------------------------------------------------------------------------
// Accounts, signed in once per run and reused by every test: an empty user for the route walk
// (so every width sees the same views), a second user for the seeded views, and the admin.
// Playwright starts a new worker after a failing test, which runs beforeAll again; the sessions
// are cached in this run's output directory (cleared at the start of every run) so a red run
// does not register and sign in again per failure and run into the auth rate limits.

type State = Awaited<ReturnType<BrowserContext['storageState']>>;
let accounts: { user: State; seed: State; admin: State };

test.beforeAll(async ({ playwright }, info) => {
  const cache = join(info.project.outputDir, 'desktop-accounts.json');
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this run's own output directory
    accounts = JSON.parse(await readFile(cache, 'utf8')) as typeof accounts;
    return;
  } catch {
    // The first worker of this run signs in.
  }
  const baseURL = info.project.use.baseURL as string;
  const session = async (path: string, data: Record<string, string>): Promise<State> => {
    const api = await playwright.request.newContext({ baseURL });
    try {
      const res = await api.post(path, { data });
      expect(res.ok(), `${path} ${data.email}: ${res.status()} ${await res.text()}`).toBe(true);
      const state = await api.storageState();
      const csrf = state.cookies.find((c) => c.name === 'opportun_csrf')?.value ?? '';
      // Declines the first-run tour, as Not now does, so it never covers a view being measured.
      const tour = await api.put('/api/v1/onboarding/tour', {
        data: { status: 'skipped', stepId: 'welcome' },
        headers: { 'x-csrf-token': csrf },
      });
      expect(tour.ok(), `tour: ${tour.status()}`).toBe(true);
      return state;
    } finally {
      await api.dispose();
    }
  };
  const register = (who: string) =>
    session('/api/v1/auth/register', {
      email: `e2e-desktop-${who}-${Date.now()}@example.com`,
      password: PASSWORD,
      displayName: 'Jane Example',
    });
  accounts = {
    user: await register('user'),
    seed: await register('seed'),
    admin: await session('/api/v1/auth/login', { email: ADMIN.email, password: ADMIN.password }),
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this run's own output directory
  await mkdir(dirname(cache), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this run's own output directory
  await writeFile(cache, JSON.stringify(accounts));
});

async function pageAt(browser: Browser, width: number, state: State) {
  const context = await browser.newContext({
    viewport: { width, height: HEIGHT },
    storageState: state,
    colorScheme: 'light',
  });
  return { page: await context.newPage(), close: () => context.close() };
}

/** A JSON call as the page's signed-in user. */
async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'opportun_csrf')?.value;
  const res = await page.request.fetch(path, {
    method,
    ...(data === undefined ? {} : { data }),
    headers: { 'x-csrf-token': csrf ?? '' },
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Long text, as real postings, notes, resumes and chats carry it.

const PARAGRAPH =
  'You will own the platform that every product team ships on, from the deployment pipeline ' +
  'to the observability stack, and you will work with product, design and security to decide ' +
  'what we build next, why it matters to customers, and how we measure whether it worked.';
const LONG_JD = [
  '## About the role',
  '',
  `${PARAGRAPH} ${PARAGRAPH}`,
  '',
  '## What you will do',
  '',
  `- ${PARAGRAPH}`,
  `- ${PARAGRAPH}`,
  '',
  '## What we are looking for',
  '',
  `${PARAGRAPH} ${PARAGRAPH} ${PARAGRAPH}`,
].join('\n');
const LONG_NOTE = `Call with the hiring manager. ${PARAGRAPH} ${PARAGRAPH}`;
const RESUME_TEXT = [
  'Jane Example',
  'Staff Platform Engineer',
  '',
  `Summary: ${PARAGRAPH} ${PARAGRAPH}`,
  '',
  'Experience',
  `Northwind Labs, Staff Platform Engineer, 2021 to now. ${PARAGRAPH} ${PARAGRAPH}`,
].join('\n');

/** An opportunity with a long job description and a long note on its timeline. */
async function seededOpportunity(page: Page): Promise<string> {
  const opp = await api<{ id: string }>(page, 'POST', '/api/v1/opportunities', {
    companyName: 'Northwind Labs',
    title: 'Staff Platform Engineer',
    descriptionMd: LONG_JD,
    sourceKind: 'manual',
  });
  await api(page, 'POST', `/api/v1/opportunities/${opp.id}/activities`, {
    kind: 'note',
    title: 'Call with the hiring manager',
    bodyMd: LONG_NOTE,
  });
  return opp.id;
}

/**
 * A tailored resume (through the Google Docs fake) whose workspace shows text, a conversation
 * and a match report. The document's own text is only shown for a resume with no external link,
 * and the conversation and report would need the model, so those four responses are stubbed
 * through page.route, as mobile.spec.ts stubs the inbox.
 */
async function seededWorkspace(page: Page): Promise<string> {
  const oppId = await seededOpportunity(page);
  const base = await api<{ id: string }>(page, 'POST', '/api/v1/resumes', {
    docRef: 'e2eBaseResumeDoc01',
  });
  const tailored = await api<{ id: string }>(page, 'POST', '/api/v1/resumes', {
    baseResumeId: base.id,
    opportunityId: oppId,
  });
  const at = Date.UTC(2026, 9, 29, 21, 15);
  const path = (suffix: string) => (url: URL) =>
    url.pathname === `/api/v1/resumes/${tailored.id}${suffix}`;
  await page.route(path(''), async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ json: { ...(await res.json()), store: 'local_file', url: null } });
  });
  await page.route(path('/text'), (route) => route.fulfill({ json: { text: RESUME_TEXT } }));
  await page.route(path('/tailoring'), (route) =>
    route.fulfill({
      json: {
        id: 'stub-session',
        resumeId: tailored.id,
        acceptedAt: null,
        createdAt: at,
        messages: [
          {
            role: 'user',
            content: `Emphasize the platform work for this role. ${PARAGRAPH}`,
            at,
            edits: [],
            incomplete: false,
          },
          {
            role: 'assistant',
            content: `Your platform work maps well to this role. ${PARAGRAPH} ${PARAGRAPH}`,
            at: at + 1000,
            edits: [
              {
                find: 'Staff Platform Engineer, 2021 to now.',
                replace: 'Staff Platform Engineer, 2021 to now, leading the deployment platform.',
                rationale: PARAGRAPH,
              },
            ],
            incomplete: false,
          },
        ],
      },
    }),
  );
  await page.route(path('/match'), (route) =>
    route.fulfill({
      json: {
        report: {
          score: 74,
          missingKeywords: ['Terraform', 'Kubernetes operators', 'service mesh'],
          weakAreas: [
            { area: 'Infrastructure as code', suggestion: PARAGRAPH },
            { area: 'Incident leadership', suggestion: PARAGRAPH },
          ],
          summary: `${PARAGRAPH} ${PARAGRAPH}`,
        },
        scoredAt: at,
        stale: false,
      },
    }),
  );
  return tailored.id;
}

// ---------------------------------------------------------------------------

for (const width of WIDTHS) {
  test.describe(`${width}px wide`, () => {
    for (const path of USER_ROUTES) {
      test(path, async ({ browser }) => {
        known(path, width);
        const { page, close } = await pageAt(browser, width, accounts.user);
        try {
          await expectStandard(page, path, width, path);
        } finally {
          await close();
        }
      });
    }

    for (const path of ADMIN_ROUTES) {
      test(path, async ({ browser }) => {
        known(path, width);
        const { page, close } = await pageAt(browser, width, accounts.admin);
        try {
          await expectStandard(page, path, width, path);
        } finally {
          await close();
        }
      });
    }

    test('/opportunities/:id timeline with a long note', async ({ browser }) => {
      const title = '/opportunities/:id timeline with a long note';
      known(title, width);
      const { page, close } = await pageAt(browser, width, accounts.seed);
      try {
        const id = await seededOpportunity(page);
        await expectStandard(page, `/opportunities/${id}`, width, title);
      } finally {
        await close();
      }
    });

    test('/opportunities/:id details with a long job description', async ({ browser }) => {
      const title = '/opportunities/:id details with a long job description';
      known(title, width);
      const { page, close } = await pageAt(browser, width, accounts.seed);
      try {
        const id = await seededOpportunity(page);
        await page.goto(`/opportunities/${id}`);
        await page.getByRole('tab', { name: 'Details' }).click();
        await expect(page.getByText('What we are looking for')).toBeVisible();
        const found = await findings(page);
        expect(found, `${title} at ${width}px:\n  ${found.join('\n  ')}`).toEqual([]);
      } finally {
        await close();
      }
    });

    test('/resumes/:id with text, a conversation and a match report', async ({ browser }) => {
      const title = '/resumes/:id with text, a conversation and a match report';
      known(title, width);
      const { page, close } = await pageAt(browser, width, accounts.seed);
      try {
        const id = await seededWorkspace(page);
        await page.goto(`/resumes/${id}`);
        await expect(page.getByRole('list', { name: 'Conversation' })).toContainText(
          'Your platform work maps well to this role.',
        );
        // Both panels open collapsed; the text being measured is behind them.
        await page.getByRole('button', { name: 'Show document' }).click();
        await page.getByRole('button', { name: 'Show details' }).click();
        await expect(page.getByText('Infrastructure as code')).toBeVisible();
        await expect(page.getByText(/Summary: You will own/)).toBeVisible();
        const found = await findings(page);
        expect(found, `${title} at ${width}px:\n  ${found.join('\n  ')}`).toEqual([]);
      } finally {
        await close();
      }
    });
  });
}
