// Phone-width layout (issue #19). The page itself must never scroll sideways: anything wider
// than the screen (a tab strip, a table) scrolls inside its own container instead. A screen
// that is wider than the viewport clips its right edge on a phone with no way to reach it.
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './global-setup';
import { createOpportunity, registerUser } from './helpers';

const WIDTHS = [390, 320] as const;

/** Every routed view a signed-in user can reach without existing data. */
const USER_ROUTES = [
  '/',
  '/pipeline',
  '/discovery',
  '/discovery/companies',
  '/discovery/decided',
  '/discovery/prompts',
  '/discovery/sources',
  '/resumes',
  '/inbox',
  '/contacts',
  '/settings',
  '/settings/account',
  '/settings/security',
  '/settings/profile',
  '/settings/role-targets',
  '/settings/resume-rules',
  '/settings/ai',
  '/settings/integrations',
  '/settings/mail-filters',
  '/settings/data',
];

const ADMIN_ROUTES = ['/settings/users', '/settings/jobs'];

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
