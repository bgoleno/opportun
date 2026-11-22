// Inbox paging past 200 messages end to end (https://github.com/bgoleno/opportun/issues/747, gap
// 1 of qa's survey; shipped by #700). The web tests mock /communications pages and the server
// tests check offsets with no page; this walks the real limit and offset with the real counts.
// 450 Needs review messages come in through the Apple Mail connector's batch route (100 a batch,
// the route's cap), as inbox.spec.ts seeds its own: the AI fake classifies "Interview
// availability" mail as job scheduling for a Contoso role, which, with no Contoso opportunity,
// stays unlinked in Needs review. Runs in both CI legs.
import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, registerUser } from './helpers';

const TOTAL = 450;

/** Creates a mail:push device token through Settings > Integrations and returns it. */
async function mailToken(page: Page): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Inbox paging e2e');
  await dialog.getByRole('checkbox', { name: /^Apple Mail connector/ }).setChecked(true);
  await dialog.getByRole('checkbox', { name: /^Browser capture/ }).setChecked(false);
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  await shown.getByRole('button', { name: 'I saved it' }).click();
  await expect(shown).toBeHidden();
  return token;
}

const subjectOf = (tag: string, i: number) =>
  `Interview availability ${tag} ${String(i).padStart(3, '0')}`;

/** Pushes TOTAL messages, newest first by index, and waits until Needs review counts them all. */
async function seed(page: Page, tag: string): Promise<void> {
  const token = await mailToken(page);
  const now = Date.now();
  for (let start = 1; start <= TOTAL; start += 100) {
    const batch = Array.from({ length: Math.min(100, TOTAL - start + 1) }, (_, k) => start + k);
    const res = await page.request.post('/api/v1/connector/mail/batch', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        messages: batch.map((i) => ({
          externalId: `paging-e2e-${tag}-${i}`,
          threadKey: `paging-${tag}-${i}`,
          from: `Recruiter ${tag}-${i} <r${i}.${tag}@contoso.example>`,
          to: ['me@example.com'],
          subject: subjectOf(tag, i),
          snippet: `Snippet ${i}`,
          bodyText: `Could we find a time to talk? (${tag} ${i})`,
          // Index 1 is the newest, so the list's order is the index order.
          sentAt: now - 60_000 * i,
        })),
      },
    });
    expect(res.status(), await res.text()).toBe(200);
  }
  // Classification runs in the job queue: wait for the whole view's count, not for time.
  await expect
    .poll(
      async () => {
        const res = await page.request.get('/api/v1/communications?view=needs_review&limit=1');
        return ((await res.json()) as { total: number }).total;
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe(TOTAL);
}

const pager = (page: Page) => page.getByRole('navigation', { name: 'Message pages' });
const rows = (page: Page) => page.getByRole('list', { name: 'Messages' }).getByRole('listitem');
const needsReviewTab = (page: Page) => page.getByRole('tab', { name: /^Needs review/ });

/** The subjects listed on the page now, once the pager reads `range`. */
async function pageSubjects(page: Page, range: string, count: number): Promise<string[]> {
  await expect(pager(page)).toContainText(`Showing ${range}`);
  await expect(rows(page)).toHaveCount(count);
  return await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

test('Needs review over 200 messages: pages walk every message once, and an emptied last page steps back', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await registerUser(page);
  const tag = `${Date.now()}`;
  await seed(page, tag);

  await page.goto('/inbox');
  await expect(needsReviewTab(page)).toHaveAccessibleName(`Needs review (${TOTAL})`);
  const first = await pageSubjects(page, `1–200 of ${TOTAL}`, 200);
  await expect(pager(page).getByRole('button', { name: 'Previous page' })).toBeDisabled();

  await pager(page).getByRole('button', { name: 'Next page' }).click();
  const second = await pageSubjects(page, `201–400 of ${TOTAL}`, 200);
  await pager(page).getByRole('button', { name: 'Next page' }).click();
  const third = await pageSubjects(page, `401–450 of ${TOTAL}`, 50);
  await expect(pager(page).getByRole('button', { name: 'Next page' })).toBeDisabled();

  // Every message once, in order: index 1 (newest) first, index 450 last.
  const all = [...first, ...second, ...third];
  expect(new Set(all).size).toBe(TOTAL);
  expect(all).toEqual(Array.from({ length: TOTAL }, (_, k) => subjectOf(tag, k + 1)));

  // Reject all of page 3: the list steps back to the last page left, never past the total.
  for (const subject of third) {
    await page
      .getByRole('listitem', { name: subject, exact: true })
      .getByRole('checkbox', { name: /^Select message from / })
      .check();
  }
  await page.getByRole('button', { name: 'Reject 50', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Reject 50 messages?' })
    .getByRole('button', { name: 'Reject 50' })
    .click();
  const back = await pageSubjects(page, '201–400 of 400', 200);
  expect(back).toEqual(second);
  await expect(pager(page).getByRole('button', { name: 'Next page' })).toBeDisabled();
  await expect(needsReviewTab(page)).toHaveAccessibleName('Needs review (400)');

  // The rejected 50 are gone from the server too, and the 400 left are untouched.
  const res = await page.request.get('/api/v1/communications?view=needs_review&limit=1');
  expect(((await res.json()) as { total: number }).total).toBe(400);
});
