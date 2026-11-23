// What the Inbox says about its rows is true when a page fails to load, a filter is too long, or
// bulk Reject is left open (https://github.com/bgoleno/opportun/issues/894), driven in a real
// browser at a narrow, a laptop and a wide width. The list's answers are this test's own (215
// messages), so a page can be made to fail; everything else is the real server.
import { expect, test, type Page } from '@playwright/test';
import { registerUser, toasts } from './helpers';

const TOTAL = 215;
const LIMIT = 200;

const message = (i: number) => ({
  id: `m${i}`,
  channel: 'gmail',
  threadKey: null,
  from: `Recruiter ${i} <r${i}@contoso.example>`,
  to: ['me@example.com'],
  subject: `Message ${i}`,
  snippet: `Snippet ${i}`,
  sentAt: 1_795_000_000_000 - i * 60_000,
  classification: 'scheduling',
  outreachKind: null,
  mismatchReason: null,
  confidence: 0.9,
  bodySource: 'full',
  opportunityId: null,
  opportunityTitle: null,
  companyName: null,
  opportunityStage: null,
  needsReview: true,
  proposedTransition: null,
  createdAt: 1_795_000_000_000 - i * 60_000,
  externalId: `e2e-${i}`,
  triageDecision: null,
  triageRule: null,
});

/** Answers Needs review with TOTAL messages; `state.failPage2` makes its second page a 500. */
async function serveList(page: Page, state: { failPage2: boolean }) {
  await page.route('**/api/v1/communications?view=needs_review*', async (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? 0);
    if (offset > 0 && state.failPage2) {
      await route.fulfill({ status: 500, json: { error: { code: 'internal' } } });
      return;
    }
    const items = Array.from({ length: Math.min(LIMIT, TOTAL - offset) }, (_, k) =>
      message(offset + k + 1),
    );
    await route.fulfill({ status: 200, json: { items, total: TOTAL } });
  });
}

const pager = (page: Page) => page.getByRole('navigation', { name: 'Message pages' });
const rows = (page: Page) => page.getByRole('list', { name: 'Messages' }).getByRole('listitem');
/** Nothing on the page is wider than the window. */
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [375, 1280, 1920]) {
  test.describe(`the Inbox at ${width} px (#894)`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('a page that fails: the range is the rows shown, and Try again loads it', async ({
      page,
    }) => {
      await registerUser(page);
      const state = { failPage2: true };
      await serveList(page, state);
      await page.goto('/inbox');
      await expect(pager(page)).toContainText(`Showing 1–200 of ${TOTAL}`);
      await page.getByRole('button', { name: 'Next page' }).click();
      const alert = page.getByRole('alert').filter({ hasText: "Page 2 couldn't load." });
      await expect(alert).toContainText('Page 1 is still shown.');
      await expect(pager(page)).toContainText(`Showing 1–200 of ${TOTAL}`);
      await expect(rows(page)).toHaveCount(200);
      await expect(rows(page).first()).toContainText('Message 1');
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      state.failPage2 = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(pager(page)).toContainText(`Showing 201–215 of ${TOTAL}`);
      await expect(rows(page)).toHaveCount(15);
      await expect(alert).toBeHidden();
    });

    test('a filter over 200 characters is refused in plain words, with no rows', async ({
      page,
    }) => {
      await registerUser(page);
      await serveList(page, { failPage2: false });
      await page.goto('/inbox');
      await expect(rows(page)).toHaveCount(200);
      await page.getByRole('searchbox', { name: 'Keyword' }).fill('x'.repeat(201));
      await expect(page.getByRole('alert')).toContainText(
        'The keyword filter is too long: 200 characters at most.',
      );
      await expect(rows(page)).toHaveCount(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.getByRole('searchbox', { name: 'Keyword' }).fill('x'.repeat(200));
      await expect(rows(page)).toHaveCount(200);
    });

    test('Back with bulk Reject open claims nothing about the messages', async ({ page }) => {
      await registerUser(page);
      await serveList(page, { failPage2: false });
      const rejects: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/communications/bulk')) rejects.push(r.url());
      });
      await page.goto('/pipeline');
      await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
      // In the app, so Back is a move within it, as a user's is.
      await page.evaluate(() => {
        window.history.pushState({}, '', '/inbox');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await expect(rows(page)).toHaveCount(200);
      for (const n of [0, 1, 2]) {
        await rows(page).nth(n).getByRole('checkbox').check();
      }
      await page.getByRole('button', { name: 'Reject 3', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Reject 3 messages?' })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      // Long enough for a toast to have shown, and counted once: a retried check would wait for it
      // to be gone.
      await page.waitForTimeout(500);
      expect(await toasts(page).getByText('Nothing was rejected').count()).toBe(0);
      expect(rejects).toEqual([]);
    });
  });
}
