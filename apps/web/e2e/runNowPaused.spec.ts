// Run now on a company board source that is paused because the company is not followed says to
// follow the company, and runs nothing; followed again, Run now runs it
// (https://github.com/bgoleno/opportun/issues/748, gap 8 of qa's survey; shipped by #629).
// Following a company switches its board source on, and a status other than followed switches
// it off (syncFollowedCompany, FR-D5). The app has no Unfollow button, so the company's status is
// set through the same PATCH /companies/:id the server's follow handling answers; the Run now
// that the issue is about is pressed in the Sources table. The AI mock proposes Pied Piper and the
// source mock's fixture board (piedpiper) answers board detection. Runs in both CI legs.
import { expect, test, type Page } from '@playwright/test';
import { registerUser, toasts } from './helpers';

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

interface Source {
  id: string;
  kind: string;
  enabled: boolean;
  companyId: string | null;
  config: Record<string, unknown>;
}

/** The user's Greenhouse board source for Pied Piper, once following has made it. */
async function boardSource(page: Page): Promise<Source | undefined> {
  const { items } = await api<{ items: Source[] }>(page, 'GET', '/api/v1/discovery/sources');
  return items.find((s) => s.companyId !== null && JSON.stringify(s.config).includes('piedpiper'));
}

const runsOf = async (page: Page, sourceId: string) =>
  (
    await api<{ items: unknown[] }>(
      page,
      'GET',
      `/api/v1/discovery/sources/${sourceId}/runs?limit=50`,
    )
  ).items.length;

const RUN_REFUSED =
  "This source reads a company's job board, and runs while you follow that company. Follow it on the Companies tab (if you already follow it, turn on its Enabled box), then run it.";

test('Run now on a paused company board says to follow the company, and runs once it is followed again', async ({
  page,
}) => {
  const email = await registerUser(page);
  const res = await page.request.post('/__mock/discovery/suggest-companies', { data: { email } });
  expect(res.ok(), await res.text()).toBe(true);
  await page.goto('/discovery/companies');
  const suggestion = page
    .getByRole('list', { name: 'Recommended companies' })
    .getByRole('listitem', { name: 'Pied Piper' });
  await suggestion.getByRole('button', { name: 'Follow Pied Piper' }).click();
  await expect(toasts(page).getByText('Following', { exact: true })).toBeVisible();

  // Following detects the board and makes it a source, switched on.
  await expect.poll(async () => (await boardSource(page))?.enabled, { timeout: 30_000 }).toBe(true);
  const source = (await boardSource(page)) as Source;

  // No longer followed: the source is switched off.
  await api(page, 'PATCH', `/api/v1/companies/${source.companyId}`, { status: 'none' });
  expect((await boardSource(page))?.enabled).toBe(false);
  const runsBefore = await runsOf(page, source.id);

  await page.goto('/discovery/sources');
  const table = page.getByRole('table', { name: 'Discovery sources' });
  const row = table.getByRole('row').filter({ hasText: 'piedpiper' });
  await expect(row.getByRole('checkbox', { name: /enabled$/ })).not.toBeChecked();
  await row.getByRole('button', { name: /^Run .* now$/ }).click();
  await expect(toasts(page).getByText('Run not started')).toBeVisible();
  await expect(toasts(page).getByText(RUN_REFUSED)).toBeVisible();
  expect(await runsOf(page, source.id)).toBe(runsBefore);

  // Followed again: the source is on, and Run now queues a run.
  await api(page, 'PATCH', `/api/v1/companies/${source.companyId}`, { status: 'followed' });
  await page.reload();
  await expect(row.getByRole('checkbox', { name: /enabled$/ })).toBeChecked();
  const ran = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && r.url().endsWith(`/discovery/sources/${source.id}/run`),
  );
  await row.getByRole('button', { name: /^Run .* now$/ }).click();
  const answer = await ran;
  expect(answer.status(), await answer.text()).toBeLessThan(300);
  await expect(toasts(page).getByText('Run queued')).toBeVisible();
  await expect.poll(async () => runsOf(page, source.id), { timeout: 30_000 }).toBe(runsBefore + 1);
});
