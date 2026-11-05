// Phone-width layout (issue #19). The page itself must never scroll sideways: anything wider
// than the screen (a tab strip, a table) scrolls inside its own container instead. A screen
// that is wider than the viewport clips its right edge on a phone with no way to reach it.
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './global-setup';
import { createCaptureToken, createOpportunity, registerUser } from './helpers';
import { ADMIN_ROUTES, USER_ROUTES } from './routes';

const WIDTHS = [390, 320] as const;

/**
 * How far the document is wider than the viewport, and the outermost elements that stick out
 * past the right edge (those not clipped by a scrolling ancestor), for a failure message that
 * names the cause rather than only the symptom.
 */
async function overflow(page: Page): Promise<{ extra: number; culprits: string[] }> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const clipped = (el: Element): boolean => {
      for (let p = el.parentElement; p !== null; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      }
      return false;
    };
    const culprits: string[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (culprits.length >= 6) break;
      if (el.getBoundingClientRect().right <= vw + 1 || clipped(el)) continue;
      const cls = typeof el.className === 'string' ? el.className.slice(0, 70) : '';
      const parent = el.parentElement;
      const via =
        parent === null
          ? ''
          : ` in ${getComputedStyle(parent).display} "${String(parent.className).slice(0, 50)}"`;
      culprits.push(
        `<${el.tagName.toLowerCase()} class="${cls}"> right=${Math.round(el.getBoundingClientRect().right)}${via}`,
      );
    }
    // Text can spill out of a box whose own edge is inside the screen (a long unbroken word),
    // which the loop above cannot see: look for boxes whose content is wider than they are.
    if (culprits.length === 0) {
      // Ancestors of the real cause qualify too, so keep the last (deepest) few in document order.
      for (const el of document.body.querySelectorAll('*')) {
        if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth === 0 || clipped(el)) continue;
        if (getComputedStyle(el).overflowX !== 'visible') continue;
        culprits.push(
          `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 60)}"> content ${el.scrollWidth} > box ${el.clientWidth}: "${(el.textContent ?? '').trim().slice(0, 60)}"`,
        );
      }
      culprits.splice(0, Math.max(0, culprits.length - 4));
    }
    return { extra: document.documentElement.scrollWidth - vw, culprits };
  });
}

async function expectFits(page: Page, where: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  const { extra, culprits } = await overflow(page);
  expect(
    extra,
    `${where} is ${extra}px wider than the screen:\n${culprits.join('\n')}`,
  ).toBeLessThanOrEqual(0);
}

/** A captured LinkedIn job page's address with its tracking query, as the browser sends it. */
const LONG_CAPTURE_URL =
  'https://www.linkedin.com/jobs/view/3901234599/?alternateChannel=search&refId=Zm9vYmFyYmF6cXV4&trackingId=c3RhZmYtcGxhdGZvcm0tZW5naW5lZXI%3D&trk=d_flagship3_search_srp_jobs';

const LONG_SENDER = `Recruiting Coordinator With A Very Long Display Name <hit-reply-9f8e7d6c5b4a39281706f5e4d3c2b1a0@recruiting-notifications.example-staffing-agency.com>`;
const LONG_SUBJECT =
  'Message replied: Job opportunity as Principal AI/ML Product Manager, Platform Intelligence (Remote, United States)';
const LONG_SNIPPET =
  'WHO WE ARE LOOKING FORWe are looking for a Lead Principal Product Manager to own the roadmap for our B2BplatformIntelligenceSuite https://example.com/careers/very/long/unbroken/tracking/link?utm_source=recruiter&utm_campaign=outreach';

/** Replaces each inbox list response with hostile-width rows, whatever the tab. */
async function stubInbox(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/communications\?view=/, async (route) => {
    const view = new URL(route.request().url()).searchParams.get('view') ?? 'needs_review';
    const base = {
      threadKey: null,
      to: ['me@example.com'],
      sentAt: Date.UTC(2026, 9, 29, 21, 15),
      createdAt: Date.UTC(2026, 9, 29, 21, 15),
      classification: 'solicitation',
      outreachKind: 'targeted',
      mismatchReason:
        'The role is on-site in a city outside your role targets and the level is below your floor.',
      confidence: 0.4,
      bodySource: 'snippet',
      opportunityId: null,
      opportunityTitle: null,
      companyName: null,
      opportunityStage: null,
      needsReview: true,
      proposedTransition: 'in_process',
      externalId: 'x',
      triageDecision: null,
      triageRule: null,
      channel: 'gmail',
      from: LONG_SENDER,
      subject: LONG_SUBJECT,
      snippet: LONG_SNIPPET,
    };
    const items = [0, 1].map((i) => ({ ...base, id: `stub-${view}-${i}` }));
    await route.fulfill({ json: { items, total: items.length } });
  });
}

const STUB_RESUME = 'stub-resume';
const STUB_TIME = Date.UTC(2026, 9, 30, 12, 0);

/**
 * A tailored resume with a scored match report that has weak areas, served entirely by stubs
 * (issue https://github.com/bgoleno/opportun/issues/36): scoring needs no AI, and the resume
 * needs no stored document. Everything else on the page comes from the real server.
 */
async function stubScoredResume(page: Page): Promise<void> {
  const resume = {
    id: STUB_RESUME,
    kind: 'tailored',
    opportunityId: 'stub-opportunity',
    title: 'Jane Doe - International Consolidated Platform Intelligence - Principal PM',
    store: 'google_doc',
    docRef: 'stub-doc',
    url: 'https://docs.google.com/document/d/stub-doc/edit',
    parentResumeId: null,
    status: 'draft',
    submittedAt: null,
    submittedTo: null,
    archivedAt: null,
    createdAt: STUB_TIME,
    updatedAt: STUB_TIME,
  };
  const weakAreas = [
    'Kubernetes operations at scale',
    'Infrastructure as code',
    'Observability and on-call',
    'Cloud cost ownership',
    'Cross-team leadership',
    'Hiring and mentoring',
  ].map((area) => ({
    area,
    suggestion: `Give one concrete, measured example of ${area.toLowerCase()} from a role you held, with the outcome in numbers.`,
  }));
  const match = {
    report: {
      score: 72,
      missingKeywords: ['Terraform', 'Helm', 'Argo CD', 'SLOs', 'FinOps'],
      weakAreas,
      summary:
        'A strong match on platform engineering, with gaps in infrastructure as code, operations at scale and cost ownership.',
    },
    scoredAt: STUB_TIME,
    stale: false,
  };
  const session = {
    id: 'stub-session',
    resumeId: STUB_RESUME,
    acceptedAt: null,
    createdAt: STUB_TIME,
    messages: [],
  };
  await page.route(/\/api\/v1\/(resumes\/stub-resume|tailoring\/stub-session)/, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api\/v1/, '');
    if (path === `/resumes/${STUB_RESUME}`) return await route.fulfill({ json: resume });
    if (path === `/resumes/${STUB_RESUME}/match`) return await route.fulfill({ json: match });
    return await route.fulfill({ json: session });
  });
}

for (const width of WIDTHS) {
  test.describe(`${width}px wide`, () => {
    test.use({ viewport: { width, height: 844 } });

    test('every view fits the screen', async ({ page }) => {
      await registerUser(page);
      const failures: string[] = [];
      for (const path of USER_ROUTES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const { extra, culprits } = await overflow(page);
        if (extra > 0) failures.push(`${path}: ${extra}px wider\n  ${culprits.join('\n  ')}`);
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });

    test('administrator views fit the screen', async ({ page }) => {
      await page.goto('/login');
      await page.getByLabel('Email').fill(ADMIN.email);
      await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
      const failures: string[] = [];
      for (const path of ADMIN_ROUTES) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const { extra, culprits } = await overflow(page);
        if (extra > 0) failures.push(`${path}: ${extra}px wider\n  ${culprits.join('\n  ')}`);
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });

    // A data-bearing route (#146): the opportunity page of a captured job, whose timeline links
    // the captured page's address. USER_ROUTES need no data, so they never showed it.
    test('an opportunity with a captured posting and a long link fits', async ({
      page,
      playwright,
      baseURL,
    }) => {
      await registerUser(page);
      const token = await createCaptureToken(page);
      const extension = await playwright.request.newContext({ baseURL });
      let opportunityId: string;
      try {
        const res = await extension.post('/api/v1/connector/capture', {
          headers: { authorization: `Bearer ${token}` },
          data: {
            url: LONG_CAPTURE_URL,
            title: 'Principal Platform Intelligence Engineer | Initrode Global | LinkedIn',
            text: [
              'Initrode Global',
              'Principal Platform Intelligence Engineer',
              'Remote · 2 days ago',
              'About the job',
              'Own the platform intelligence roadmap end to end.',
              'About the company',
              'Initrode Global',
            ].join('\n'),
          },
        });
        expect(res.status(), await res.text()).toBe(201);
        opportunityId = ((await res.json()) as { opportunityId: string }).opportunityId;
      } finally {
        await extension.dispose();
      }
      await page.goto(`/opportunities/${opportunityId}`);
      const link = page
        .getByRole('link', { name: /^https:\/\/www\.linkedin\.com\/jobs\/view\// })
        .first();
      await expect(link).toBeVisible();
      await expectFits(page, 'the opportunity page');
      // The link still opens the captured address, safely, and its name is the whole URL.
      const href = await link.getAttribute('href');
      expect(href).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/view\//);
      await expect(link).toHaveAccessibleName(href ?? '');
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
      await expect(link).toHaveAttribute('rel', /noreferrer/);
    });

    test('inbox rows with long senders, subjects and links fit on every tab', async ({ page }) => {
      await registerUser(page);
      await stubInbox(page);
      await page.goto('/inbox');
      for (const tab of [/^Needs review/, /^Linked/, /^Spam/, /^Filtered/, /^Blocked/]) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(page.getByRole('list', { name: 'Messages' })).toBeVisible();
        await expectFits(page, `inbox ${String(tab)}`);
      }
    });

    test('a resume with its match report and weak areas showing fits', async ({ page }) => {
      await registerUser(page);
      await stubScoredResume(page);
      await page.goto(`/resumes/${STUB_RESUME}`);
      // The report opens expanded; its weak-area grid is what once overflowed at 320 (#36).
      await expect(page.getByRole('list', { name: 'Weak areas' })).toBeVisible();
      await expectFits(page, 'resume with a match report');
    });

    test('an opportunity with a long company and title fits', async ({ page }) => {
      await registerUser(page);
      const opp = {
        company: 'International Consolidated Platform Intelligence Holdings',
        title: 'Principal Product Manager, Enterprise AI/ML Platform Intelligence and Analytics',
      };
      await createOpportunity(page, opp);
      await page
        .getByRole('article', { name: `${opp.company}: ${opp.title}`, exact: true })
        .getByRole('link')
        .first()
        .click();
      await expect(page).toHaveURL(/\/opportunities\//);
      await expectFits(page, 'opportunity detail');
    });
  });
}

// The Discovery screens with a populated queue (https://github.com/bgoleno/opportun/issues/193).
// "every view fits the screen" above visits /discovery as a brand-new user, whose queue is empty,
// so no result card was ever on screen there. These cards carry the widest content a real queue
// can: long reasons and descriptions with an unbroken link, a long location, and the full badge
// row. They are stubs (made-up data); everything else on the page comes from the real server.
const DISCOVERY_WIDTHS = [440, 390, 320] as const;
const DAY = 24 * 60 * 60 * 1000;
const UNBROKEN =
  'https://careers.example-holdings.com/jobs/principal-platform-intelligence-engineer-remote-united-states?gh_src=discovery_feed_tracking_0123456789abcdef';
const LONG_WHY = `Strong match for your Staff and Principal platform engineering targets: owns the internal developer platform, observability and cost tooling end to end, remote in your region, and the level matches your floor. See ${UNBROKEN}`;
const LONG_DESCRIPTION = `About International Consolidated Platform Intelligence Holdings: a multinational enterprise software group building analytics infrastructure for regulated industries across forty countries. ${UNBROKEN}`;
// A title and a company with no break opportunity at all, and a real compound-word title
// (qa and tl on https://github.com/bgoleno/opportun/pull/195): text with spaces always wrapped.
const UNBROKEN_TITLE =
  'PrincipalPlatformIntelligenceEngineerDeveloperExperienceObservabilityAndReliability';
const UNBROKEN_COMPANY = 'InternationalConsolidatedPlatformIntelligenceHoldingsGmbH';
const UNBROKEN_LOCATION = 'FrankfurtamMainNiederradLyonerStrasseBuerostandortGebaeudeC';
const COMPOUND_TITLE = 'Datenbankadministratorenteamleiterin (m/w/d)';
const COMPOUND_COMPANY = 'Bundesversicherungsanstaltsverwaltungsgesellschaft mbH';
const LONG_LOCATION =
  'Remote, United States (Eastern or Central time zones preferred); occasional travel to San Francisco, California';

function stubResult(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  const posting = {
    company: 'International Consolidated Platform Intelligence Holdings',
    title: `Principal Platform Intelligence Engineer, Developer Experience and Observability ${i}`,
    descriptionMd: LONG_DESCRIPTION,
    postingUrl: UNBROKEN,
    location: LONG_LOCATION,
    remote: true,
    compNote:
      'USD 245,000 to 310,000 base, plus equity and an annual performance bonus target of 20%',
    externalId: `stub-${i}`,
    postedAt: null,
  };
  return {
    id: `stub-result-${i}`,
    runId: 'stub-run',
    sourceId: 'stub-source',
    sourceKind: 'ats_greenhouse',
    roleTargetId: null,
    dedupeKey: `international consolidated|principal platform ${i}|remote ${i}`,
    aiScore: 91,
    aiRationale: LONG_WHY,
    rankSkipReason: null,
    // needs capture and stale (discovered ten days ago): the badge row at its fullest.
    resolution: 'needs_capture',
    resolvedSourceRef: null,
    disposition: 'pending',
    opportunityId: null,
    sourceMailChannel: null,
    sourceMailExternalId: null,
    dismissReason: null,
    dismissNote: null,
    createdAt: now - 10 * DAY,
    updatedAt: now - 10 * DAY,
    ...over,
    posting: { ...posting, ...((over.posting as object | undefined) ?? {}) },
  };
}

/** Serves every discovery results list (the queue and both Decided tabs) with stub cards. */
async function stubDiscoveryResults(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/discovery\/results\?/, async (route) => {
    if (route.request().method() !== 'GET') return await route.fallback();
    const disposition = new URL(route.request().url()).searchParams.get('disposition');
    const items = [
      stubResult(1),
      stubResult(2, { aiScore: 64, sourceKind: 'alert_email' }),
      // Two locations of one role: the queue shows them as one group card (#191).
      stubResult(3, { dedupeKey: 'international consolidated|principal platform 3|a' }),
      stubResult(4, {
        dedupeKey: 'international consolidated|principal platform 3|b',
        posting: { location: `${LONG_LOCATION} or London, United Kingdom`, title: stubTitle(3) },
      }),
      stubResult(5, { posting: { title: UNBROKEN_TITLE, company: UNBROKEN_COMPANY } }),
      stubResult(6, { posting: { title: COMPOUND_TITLE, company: COMPOUND_COMPANY } }),
      // A location group whose title and company have no break either.
      stubResult(7, {
        dedupeKey: 'unbroken|unbroken title|a',
        posting: { title: UNBROKEN_TITLE, company: UNBROKEN_COMPANY },
      }),
      stubResult(8, {
        dedupeKey: 'unbroken|unbroken title|b',
        // A location with no break in it, in the group's list of locations (tl, optional).
        posting: { title: UNBROKEN_TITLE, company: UNBROKEN_COMPANY, location: UNBROKEN_LOCATION },
      }),
    ].map((r) =>
      disposition === 'pending'
        ? r
        : // A denied company's dismissal names the company (#199), which can be unbroken too (tl).
          r.id === 'stub-result-5'
          ? { ...r, disposition, dismissReason: 'denied_company', dismissNote: UNBROKEN_COMPANY }
          : { ...r, disposition, dismissReason: 'not_a_fit' },
    );
    // More than are loaded, so "Select all N matching" shows too.
    await route.fulfill({ json: { items, total: disposition === 'pending' ? 250 : items.length } });
  });
}
/**
 * Serves the Companies tab's three lists with stub companies (qa's sweep on #195): an unbroken
 * name and domain, a suggestion whose "Why" holds a board URL, a followed company whose detected
 * board slug is long, and a denied company with an unbroken name.
 */
const stubCompanyBase = (now: number) => ({
  userId: 'stub-user',
  domain: 'internationalconsolidatedplatformintelligenceholdings.example',
  careersUrl: UNBROKEN,
  suggestionRationale: null,
  atsKind: null,
  atsRef: null,
  atsVerifiedAt: null,
  notes: null,
  atsDetectPending: false,
  needsCareersUrl: false,
  createdAt: now,
  updatedAt: now,
});

async function stubCompanies(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/companies(\/suggestions)?\?/, async (route) => {
    if (route.request().method() !== 'GET') return await route.fallback();
    const url = new URL(route.request().url());
    const now = Date.now();
    const base = stubCompanyBase(now);
    const status = url.pathname.endsWith('/suggestions')
      ? 'suggested'
      : (url.searchParams.get('status') ?? 'followed');
    const items =
      status === 'suggested'
        ? [
            {
              ...base,
              id: 'stub-co-s',
              name: UNBROKEN_COMPANY,
              status: 'suggested',
              suggestionRationale: `You applied to two of its roles; its board is ${UNBROKEN}`,
            },
          ]
        : status === 'denied'
          ? [{ ...base, id: 'stub-co-d', name: UNBROKEN_COMPANY, status: 'denied' }]
          : [
              {
                ...base,
                id: 'stub-co-f',
                name: UNBROKEN_COMPANY,
                status: 'followed',
                atsKind: 'ats_greenhouse',
                atsRef: 'internationalconsolidatedplatformintel41',
                atsVerifiedAt: now,
              },
            ];
    await route.fulfill({ json: { items, total: items.length } });
  });
  // The "In your network" rows (https://github.com/bgoleno/opportun/issues/211 item 3): every
  // text field unbroken, the people's names too. A denied row only with ?showDenied=true.
  await page.route(/\/api\/v1\/discovery\/network-companies/, async (route) => {
    if (route.request().method() !== 'GET') return await route.fallback();
    const base = stubCompanyBase(Date.now());
    const row = (id: string, company: Record<string, unknown>, board: string) => ({
      company: { ...base, id, name: UNBROKEN_COMPANY, ...company },
      board,
      contactCount: 2,
      strongestStrength: 3,
      contacts: [
        { id: `${id}-p1`, name: UNBROKEN, strength: 3 },
        { id: `${id}-p2`, name: UNBROKEN, strength: null },
      ],
    });
    const items = [
      row('stub-net-n', { status: 'none' }, 'not_checked'),
      row(
        'stub-net-f',
        {
          status: 'followed',
          atsKind: 'ats_lever',
          atsRef: 'internationalconsolidatedplatformintel42',
          atsVerifiedAt: Date.now(),
        },
        'found',
      ),
    ];
    if (new URL(route.request().url()).searchParams.get('showDenied') === 'true') {
      items.push(row('stub-net-d', { status: 'denied', atsKind: 'none' }, 'not_found'));
    }
    await route.fulfill({ json: { items } });
  });
}

const stubTitle = (i: number) =>
  `Principal Platform Intelligence Engineer, Developer Experience and Observability ${i}`;

/**
 * Content inside each result card that runs past the card's own right edge, or a box whose text
 * is wider than it is. A deliberate ellipsis (the location's `truncate`) is overflow: hidden, so
 * its clipped text is not "wider"; but the box itself must still end inside the card (tl on
 * https://github.com/bgoleno/opportun/pull/195), so nothing is exempt from `past`.
 */
async function spillsOutOfCards(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const cards = document.querySelectorAll(
      '[data-result-id], [aria-label$="companies"] > li, [aria-label="Companies in your network"] > li',
    );
    for (const card of cards) {
      const edge = card.getBoundingClientRect().right;
      for (const el of card.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        const past = el.getBoundingClientRect().right > edge + 1;
        const wider = el.scrollWidth > el.clientWidth + 1 && style.overflowX === 'visible';
        if (past || (wider && el.clientWidth > 0)) {
          out.push(
            `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 60)}">: "${(el.textContent ?? '').trim().slice(0, 50)}"`,
          );
        }
        if (out.length >= 6) return out;
      }
    }
    return out;
  });
}

/** Every "In your network" row with its people open, then with the denied row too (#211 item 3). */
async function expectNetworkRowsFit(page: Page): Promise<void> {
  const rows = page.getByRole('list', { name: 'Companies in your network' }).locator('> li');
  await expect(rows).toHaveCount(2);
  const openPeople = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      if ((await row.locator('details').getAttribute('open')) === null) {
        await row.locator('summary').click();
      }
      await expect(row.getByText(UNBROKEN).first()).toBeVisible();
    }
  };
  await openPeople(2);
  await expectFits(page, 'the network rows with their people open');
  expect(await spillsOutOfCards(page), 'text spilling out of a network row').toEqual([]);
  await page.getByLabel('Show denied').check();
  await expect(rows).toHaveCount(3);
  await openPeople(3);
  await expectFits(page, 'the network rows with a denied row');
  expect(await spillsOutOfCards(page), 'text spilling out of a denied network row').toEqual([]);
  // Opening the rows scrolled down, and the next tab must be on screen from the top of the page.
  await page.evaluate(() => window.scrollTo(0, 0));
}

const DISCOVERY_TABS = [
  ['Decided', '/discovery/decided'],
  ['Companies', '/discovery/companies'],
  ['Sources', '/discovery/sources'],
  ['Prompts', '/discovery/prompts'],
  ['Review queue', '/discovery'],
] as const;

for (const width of DISCOVERY_WIDTHS) {
  test.describe(`Discovery at ${width}px wide`, () => {
    test.use({ viewport: { width, height: 844 } });

    test('a full review queue, and every Discovery tab, fit the screen (#193)', async ({
      page,
    }) => {
      await registerUser(page);
      await stubDiscoveryResults(page);
      await stubCompanies(page);
      await page.goto('/discovery');
      const queue = page.getByRole('list', { name: 'Results to review' });
      await expect(queue.getByText(LONG_WHY).first()).toBeVisible();
      await expect(queue.getByText(COMPOUND_TITLE)).toBeVisible();
      await expectFits(page, 'the review queue');
      expect(await spillsOutOfCards(page), 'text spilling out of a card').toEqual([]);

      // The toolbar is on screen and usable without zooming (#193 criterion 4).
      for (const control of [
        page.getByRole('button', { name: 'Capture posting' }),
        page.getByLabel('Sort by'),
        page.getByRole('button', { name: /^Select all \d+ loaded$/ }),
        page.getByRole('button', { name: 'Select all 250 matching' }),
      ]) {
        await expect(control).toBeInViewport({ ratio: 1 });
      }
      await page.getByLabel('Sort by').selectOption({ index: 1 });
      await page.getByRole('button', { name: /^Select all \d+ loaded$/ }).click();
      await expect(page.getByText(/^\d+ selected$/)).toBeVisible();
      await expectFits(page, 'the review queue with a selection');

      // Every tab is on screen without scrolling the bar (criterion 3: it wraps), and each fits.
      const sections = page.getByRole('navigation', { name: 'Discovery sections' });
      for (const [name, path] of DISCOVERY_TABS) {
        const tab = sections.getByRole('link', { name, exact: true });
        await expect(tab).toBeInViewport({ ratio: 1 });
        await tab.click();
        await expect(page).toHaveURL((url) => url.pathname === path);
        // The stub companies are on screen before measuring, so the check sees them.
        if (name === 'Companies') {
          await expect(page.getByText(/^Greenhouse: internationalconsolidated/)).toBeVisible();
        }
        await expectFits(page, `Discovery ${name}`);
        if (name === 'Companies') {
          expect(await spillsOutOfCards(page), 'text spilling out of a company card').toEqual([]);
          await expectNetworkRowsFit(page);
        }
        if (name === 'Decided') {
          for (const [decided, tabName] of [
            ['Dismissed', /^Dismissed/],
            ['Accepted', /^Accepted/],
          ] as const) {
            await page.getByRole('tab', { name: tabName }).click();
            await expect(page.getByText(LONG_LOCATION).first()).toBeVisible();
            await expectFits(page, `Discovery Decided ${decided}`);
            expect(await spillsOutOfCards(page), `text spilling out of a ${decided} card`).toEqual(
              [],
            );
          }
        }
      }
    });
  });
}
