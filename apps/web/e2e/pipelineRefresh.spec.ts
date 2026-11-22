// A stage change on the pipeline board refreshes the other lists, and not the board's own
// (https://github.com/bgoleno/opportun/issues/749, gap 6 of qa's survey; shipped by #621). The
// board holds every opportunity (fetchAllOpportunities, pages of 200); before #621 a drag walked
// all of them again. A keyboard drag (the real dnd-kit path) moves a card from Applied to
// In process; the Dashboard's counts, read just before, show the move when it is opened again
// in-app, inside their 30 s staleness, so it is the change's invalidation that refreshed them.
import { expect, test, type Page, type Request } from '@playwright/test';
import { card, createOpportunity, moveTo, registerUser } from './helpers';

/** dnd-kit's live region: what a screen reader hears during a drag. */
const liveRegion = (page: Page) => page.locator('[id^="DndLiveRegion-"]');

/** Space to pick up, ArrowRight until over `target`'s column, Space to drop. */
async function keyboardDrop(page: Page, moved: ReturnType<typeof card>, target: string) {
  await moved.focus();
  await page.keyboard.press('Space');
  await expect(liveRegion(page)).toContainText('is over');
  const wanted = `is over the ${target} column`;
  for (let i = 0; i < 12; i++) {
    const before = (await liveRegion(page).textContent()) ?? '';
    if (before.includes(wanted)) break;
    await page.keyboard.press('ArrowRight');
    await expect(liveRegion(page))
      .not.toHaveText(before, { timeout: 1_000 })
      .catch(() => undefined);
  }
  await expect(liveRegion(page)).toContainText(wanted);
  await page.keyboard.press('Space');
}

/** The board's whole-list read: GET /opportunities?sort=-updatedAt&limit=200&offset=… */
const isBoardList = (r: Request) => {
  const u = new URL(r.url());
  return (
    r.method() === 'GET' &&
    u.pathname === '/api/v1/opportunities' &&
    u.searchParams.get('sort') === '-updatedAt' &&
    u.searchParams.has('offset')
  );
};

test('a drag from Applied to In process updates the Dashboard counts and does not reload the board', async ({
  page,
}) => {
  await registerUser(page);
  const opp = { company: 'Initech', title: 'Platform Lead' };
  await createOpportunity(page, opp);
  await createOpportunity(page, { company: 'Globex', title: 'Staff Engineer' });
  await moveTo(page, opp, 'Applied');

  // The Dashboard's counts before, then the board, in-app.
  await page.goto('/');
  const counts = page.getByRole('region', { name: 'Pipeline by stage' });
  await expect(counts.getByRole('link', { name: 'Applied 1' })).toBeVisible();
  await expect(counts.getByRole('link', { name: 'In process 0' })).toBeVisible();
  await page.getByRole('link', { name: 'Pipeline', exact: true }).first().click();
  await expect(card(page, opp.company, opp.title)).toBeVisible();

  const requests: Request[] = [];
  page.on('request', (r) => requests.push(r));
  const moved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/opportunities\/[^/]+\/stage$/.test(r.url()),
  );
  await keyboardDrop(page, card(page, opp.company, opp.title), 'In process');
  expect((await moved).ok()).toBe(true);
  await expect(
    page.getByRole('region', { name: 'In process column' }).getByText(opp.title),
  ).toBeVisible();

  // Back to the Dashboard in-app, with no reload: the counts show the move.
  await page.getByRole('link', { name: 'Dashboard', exact: true }).first().click();
  await expect(counts.getByRole('link', { name: 'In process 1' })).toBeVisible();
  await expect(counts.getByRole('link', { name: 'Applied 0' })).toBeVisible();

  // The drag read no page of the board's whole list.
  expect(requests.filter(isBoardList).map((r) => r.url())).toEqual([]);
});
