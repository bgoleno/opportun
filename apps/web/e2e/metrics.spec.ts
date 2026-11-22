// The metric dashboards end to end (FR-T6, https://github.com/bgoleno/opportun/issues/346): from
// Settings to the page, the list filtered, a metric picked and its range changed, all against
// the real server and its own store. Nothing is stubbed: with collection off the store is empty,
// so the chart and its table show zero calls, which is what an instance that never turned
// collection on has.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN } from './global-setup';

const HOUR = 3_600_000;

/**
 * Signs the admin in once for this file and reuses that session's cookies in its other tests:
 * every sign-in counts against the login limit (10 per address and email in 15 minutes), and
 * the suite signs the admin in from several files (#749).
 */
let adminCookies: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;
async function signInAsAdmin(page: Page): Promise<void> {
  if (adminCookies !== undefined) {
    await page.context().addCookies(adminCookies);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    return;
  }
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  adminCookies = await page.context().cookies();
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

// #628 (qa's e2e survey, gap 10, issue #749): "Last 30 days", then Custom, applies its own range
// whatever the second it was chosen, a typed start inside the 30 days is applied as typed, and one
// further back is still refused. The page's clock is Playwright's, pinned to 100 ms before a
// minute ends: the moment the page's own From read as a start too old for its Apply (#614).
test('Last 30 days then Custom applies its own range, a typed start as typed, and refuses one past 30 days', async ({
  page,
}) => {
  const DAY = 24 * HOUR;
  const now = Date.now();
  const lateInMinute = now - (now % 60_000) + 60_000 - 100;
  await page.clock.install({ time: lateInMinute - 60_000 });
  await signInAsAdmin(page);
  await page.goto('/settings/metrics');
  const list = page.getByRole('list', { name: 'Metrics' });
  await nextSeriesSpan(page, () =>
    list.getByRole('button', { name: /opportun\.job\.duration/ }).click(),
  );

  // "Last 30 days" at hh:mm:59.900, then Custom, and Apply five seconds later, fields untouched.
  await page.clock.pauseAt(lateInMinute);
  const month = await nextSeriesSpan(page, () => page.getByLabel('Time range').selectOption('30d'));
  expect(month).toBe(30 * DAY);
  await page.getByLabel('Time range').selectOption('custom');
  await page.clock.fastForward(5_000);
  const [applied] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/v1/obs/metrics/series'), {
      timeout: 10_000,
    }),
    page.getByRole('button', { name: 'Apply' }).click(),
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const q = new URL(applied.url()).searchParams;
  const appliedAt = lateInMinute + 5_000;
  expect(Number(q.get('to'))).toBeLessThanOrEqual(appliedAt);
  expect(Number(q.get('to')) - Number(q.get('from'))).toBeLessThanOrEqual(30 * DAY);
  expect(Number(q.get('from'))).toBeGreaterThanOrEqual(appliedAt - 30 * DAY);

  // A start typed inside the 30 days is the range's start, to the minute it names.
  const typed = new Date(appliedAt - 10 * DAY);
  typed.setSeconds(0, 0);
  const local = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  await page.getByLabel('From').fill(local(typed));
  const [typedRequest] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/v1/obs/metrics/series'), {
      timeout: 10_000,
    }),
    page.getByRole('button', { name: 'Apply' }).click(),
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(Number(new URL(typedRequest.url()).searchParams.get('from'))).toBe(typed.getTime());
  await expect(page.getByLabel('From')).toHaveValue(local(typed));

  // A start typed 31 days back is refused, and nothing is asked of the server.
  const tooOld = new Date(appliedAt - 31 * DAY);
  let asked = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/obs/metrics/series')) asked += 1;
  });
  await page.getByLabel('From').fill(local(tooOld));
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Points are kept 30 days: choose a range inside the last 30 days.',
  );
  expect(asked).toBe(0);
});
