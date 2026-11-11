// The metric dashboards end to end (FR-T6, https://github.com/bgoleno/opportun/issues/346): from
// Settings to the page, the list filtered, a metric picked and its range changed, all against
// the real server and its own store. Nothing is stubbed: with collection off the store is empty,
// so the chart and its table show zero calls, which is what an instance that never turned
// collection on has.
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './global-setup';

const HOUR = 3_600_000;

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

/** The span of the next series request, and its response's status. */
async function nextSeriesSpan(page: Page, act: () => Promise<unknown>): Promise<number> {
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/v1/obs/metrics/series')),
    act(),
  ]);
  const response = await request.response();
  expect(response?.status()).toBe(200);
  const q = new URL(request.url()).searchParams;
  return Number(q.get('to')) - Number(q.get('from'));
}

test('open the dashboards from Settings, filter, pick a metric and change its range', async ({
  page,
}) => {
  await signInAsAdmin(page);
  await page.goto('/settings');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Metrics' })
    .click();
  await expect(page).toHaveURL(/\/settings\/metrics/);

  const list = page.getByRole('list', { name: 'Metrics' });
  await expect(list.getByRole('listitem').first()).toBeVisible();
  const all = await list.getByRole('listitem').count();
  expect(all).toBeGreaterThan(1);
  // Collection is off on a fresh instance: the page says so.
  await expect(page.getByRole('status')).toContainText('Collection is off');

  // Filter the list, by text and by an attribute.
  await page.getByLabel('Search metrics').fill('job');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByLabel('Search metrics').fill('');
  await page.getByLabel('Carries attribute').selectOption('opportun.job.kind');
  await expect(list.getByRole('listitem')).toHaveCount(1);

  // Pick it: the last 24 hours, read from the server.
  const day = await nextSeriesSpan(page, () =>
    list.getByRole('button', { name: /opportun\.job\.duration/ }).click(),
  );
  expect(day).toBe(24 * HOUR);
  await expect(page.getByRole('heading', { name: 'opportun.job.duration' })).toBeVisible();
  await expect(page.getByRole('group', { name: /Chart of Calls/ })).toBeVisible();
  await expect(page.getByRole('region', { name: "The chart's numbers" })).toBeVisible();

  // Change the range: a preset, then a zoom.
  const week = await nextSeriesSpan(page, () => page.getByLabel('Time range').selectOption('7d'));
  expect(week).toBe(7 * 24 * HOUR);
  const zoomed = await nextSeriesSpan(page, () =>
    page.getByRole('button', { name: 'Zoom in' }).click(),
  );
  expect(zoomed).toBe(3.5 * 24 * HOUR);
  await expect(page.getByLabel('Time range')).toHaveValue('custom');
});
