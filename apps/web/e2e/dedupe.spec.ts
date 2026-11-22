// The AI duplicate check end to end (https://github.com/bgoleno/opportun/issues/747, gap 3 of
// qa's survey; shipped by #644 and #701). Two opportunities at one company whose titles score
// from 0.6 to under 0.85 ("Platform Lead" against "Platform Lead (Remote)": 0.667) are only a
// pending candidate, with no banner. The daily sweep (opportunity.dedupe_ai_pass, 07:15) asks the
// model; here it is run now through the AI mock's test-only hook (apps/server/src/testSupport/
// mockJobs.ts), and the AI mock answers "duplicate" for a pair whose company carries its marker
// (MOCK_DEDUPE_CONFIRM_MARKER) and "not a duplicate" otherwise. Runs in both CI legs.
import { expect, test, type Page } from '@playwright/test';
import { registerUser } from './helpers';

/** apps/server/src/testSupport/mockAi.ts MOCK_DEDUPE_CONFIRM_MARKER. */
const CONFIRM = 'QA Dupe Confirm';

async function api<T>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'opportun_csrf')?.value;
  const res = await page.request.fetch(path, {
    method,
    ...(data === undefined ? {} : { data }),
    headers: { 'x-csrf-token': csrf ?? '' },
  });
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (res.status() === 204 ? null : await res.json()) as T;
}

interface Pair {
  company: string;
  /** Created first: the one the candidate may duplicate. */
  tracked: string;
  /** Created second: the banner shows on its page. */
  candidate: string;
}

/** Two opportunities at `company` whose titles only the AI pass can decide between. */
async function pendingPair(page: Page, company: string): Promise<Pair> {
  const make = (title: string) =>
    api<{ id: string }>(page, 'POST', '/api/v1/opportunities', {
      companyName: company,
      title,
      sourceKind: 'manual',
    });
  const tracked = await make('Platform Lead');
  const candidate = await make('Platform Lead (Remote)');
  return { company, tracked: tracked.id, candidate: candidate.id };
}

const possibleDuplicates = async (page: Page, id: string) =>
  (await api<{ possibleDuplicates: string[] }>(page, 'GET', `/api/v1/opportunities/${id}`))
    .possibleDuplicates;

/** Runs one AI duplicate pass now and waits for it to finish. */
async function runPass(page: Page): Promise<void> {
  const res = await page.request.post('/__mock/jobs/opportunity.dedupe_ai_pass/run');
  expect(res.status(), await res.text()).toBe(200);
  const { jobId } = (await res.json()) as { jobId: string };
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/__mock/jobs/${jobId}`)).json()) as { status: string })
          .status,
      { timeout: 30_000 },
    )
    .toBe('done');
}

/**
 * Passes until every pair in `decided` is decided by the model. The sweep reads at most 25
 * pending rows, oldest first, across every user, so pairs other specs left pending can come
 * first; each pass decides its rows, so a few passes reach ours.
 */
async function passUntil(page: Page, done: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await runPass(page);
    if (await done()) return;
  }
  throw new Error('ten AI duplicate passes did not decide the pairs');
}

const banner = (page: Page) => page.getByRole('status').filter({ hasText: 'Possible duplicate' });

test('the AI duplicate check flags a pair, Merge leaves one, and Not a duplicate stays dismissed', async ({
  page,
}) => {
  await registerUser(page);
  const tag = `${Date.now()}`;
  const merged = await pendingPair(page, `${CONFIRM} Merge ${tag}`);
  const kept = await pendingPair(page, `${CONFIRM} Keep ${tag}`);
  const other = await pendingPair(page, `QA Not A Dupe ${tag}`);

  // Before the pass, a pending candidate has no banner.
  await page.goto(`/opportunities/${merged.candidate}`);
  await expect(
    page.getByRole('heading', { name: 'Platform Lead (Remote)', level: 1 }),
  ).toBeVisible();
  await expect(banner(page)).toBeHidden();
  expect(await possibleDuplicates(page, merged.candidate)).toEqual([]);

  await passUntil(
    page,
    async () =>
      (await possibleDuplicates(page, merged.candidate)).length > 0 &&
      (await possibleDuplicates(page, kept.candidate)).length > 0,
  );

  // The pass confirmed both marked pairs; the unmarked pair has no banner.
  expect(await possibleDuplicates(page, merged.candidate)).toEqual([merged.tracked]);
  expect(await possibleDuplicates(page, kept.candidate)).toEqual([kept.tracked]);
  expect(await possibleDuplicates(page, other.candidate)).toEqual([]);
  await page.goto(`/opportunities/${other.candidate}`);
  await expect(
    page.getByRole('heading', { name: 'Platform Lead (Remote)', level: 1 }),
  ).toBeVisible();
  await expect(banner(page)).toBeHidden();

  // Merge: the banner names the tracked one; after confirming, only that one is left.
  await page.goto(`/opportunities/${merged.candidate}`);
  await expect(banner(page)).toContainText(
    `Possible duplicate: you already track Platform Lead at ${merged.company}.`,
  );
  await banner(page).getByRole('button', { name: 'Merge', exact: true }).click();
  await banner(page).getByRole('button', { name: 'Merge this opportunity in' }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/opportunities/${merged.tracked}`);
  await expect(page.getByRole('heading', { name: 'Platform Lead', level: 1 })).toBeVisible();
  const gone = await page.request.get(`/api/v1/opportunities/${merged.candidate}`);
  expect(gone.status()).toBe(404);
  const list = await api<{ items: { id: string; companyName: string }[] }>(
    page,
    'GET',
    `/api/v1/opportunities?q=${encodeURIComponent(merged.company)}&limit=50`,
  );
  expect(list.items.filter((o) => o.companyName === merged.company).map((o) => o.id)).toEqual([
    merged.tracked,
  ]);

  // Not a duplicate: the banner leaves, both stay, and the next pass does not bring it back.
  await page.goto(`/opportunities/${kept.candidate}`);
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole('button', { name: 'Not a duplicate' }).click();
  await expect(banner(page)).toBeHidden();
  await runPass(page);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Platform Lead (Remote)', level: 1 }),
  ).toBeVisible();
  await expect(banner(page)).toBeHidden();
  expect(await possibleDuplicates(page, kept.candidate)).toEqual([]);
  for (const id of [kept.tracked, kept.candidate]) {
    expect((await page.request.get(`/api/v1/opportunities/${id}`)).status()).toBe(200);
  }
});
