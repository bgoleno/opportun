// The Referrals tab's ranking end to end (https://github.com/bgoleno/opportun/issues/692): the
// ranking is kept and reused when the tab opens again (#640), Re-rank makes one fresh call, a
// contact added on Network shows when the user goes back with no reload (#651), and a spent daily
// AI budget says so (#651). AI calls are counted from the user's own usage
// (GET /api/v1/ai/usage, the referral.rationale task), answered by the server's AI fake.
import { expect, test, type Page } from '@playwright/test';
import { card, createOpportunity, registerUser, toasts } from './helpers';
import { storedZip } from './zip';
// The AI fake's marker for a call that spends a task's daily budget (see the budget step).
import { MOCK_HEAVY_USAGE_MARKER } from '../../server/src/testSupport/mockAi';

const CONNECTIONS = [
  '﻿First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Jane,Doe,https://www.linkedin.com/in/jane-doe-synthetic-692a,jane.doe@initech.example,Initech,"Director, Platform Engineering",12 Mar 2024',
  'Bob,Porter,https://www.linkedin.com/in/bob-porter-synthetic-692b,,Initech,Engineering Manager,03 Jan 2023',
  'Ana,Ruiz,https://www.linkedin.com/in/ana-ruiz-synthetic-692c,ana.ruiz@globex.example,Globex,Product Lead,09 Sep 2021',
  '',
].join('\r\n');

/**
 * How many referral rankings reached the AI, from the user's own usage. A call the budget
 * refused is recorded too, as an error run, so errors are not counted: they never reached it.
 */
async function rankingCalls(page: Page): Promise<number> {
  const res = await page.request.get('/api/v1/ai/usage');
  expect(res.status()).toBe(200);
  const usage = (await res.json()) as {
    totals: { taskKey: string; runs: number; errors: number }[];
  };
  const task = usage.totals.find((t) => t.taskKey === 'referral.rationale');
  return task === undefined ? 0 : task.runs - task.errors;
}

const candidates = (page: Page) =>
  page.getByRole('list', { name: 'Referral candidates' }).getByRole('listitem');

test('Referrals: the ranking is kept on reopen, Re-rank and a new contact each rank once, and a spent budget says so', async ({
  page,
}) => {
  await registerUser(page);
  await page.goto('/settings/data');
  await page.getByLabel('LinkedIn export zip').setInputFiles({
    name: 'Basic_LinkedInDataExport_11-21-2026.zip',
    mimeType: 'application/zip',
    buffer: storedZip({ 'Connections.csv': CONNECTIONS }),
  });
  await page.getByRole('button', { name: 'Import LinkedIn export' }).click();
  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 30_000 });

  const opp = { company: 'Initech', title: 'Staff Platform Engineer' };
  await createOpportunity(page, opp);
  await card(page, opp.company, opp.title).getByRole('link', { name: opp.title }).click();
  await page.waitForURL(/\/opportunities\/[^/]+$/);
  const oppUrl = page.url();

  // First open: one ranking of the two Initech contacts.
  await page.getByRole('tab', { name: 'Referrals' }).click();
  await expect(candidates(page)).toHaveCount(2);
  await expect(page.getByText(/^Ranked by AI/)).toBeVisible();
  const rankedLine = await page.getByText(/^Ranked by AI/).innerText();
  expect(await rankingCalls(page)).toBe(1);

  // Opened again, after a full reload: the kept ranking, no new call (#640).
  await page.goto(oppUrl);
  await page.getByRole('tab', { name: 'Referrals' }).click();
  await expect(candidates(page)).toHaveCount(2);
  await expect(page.getByText(/^Ranked by AI/)).toHaveText(rankedLine);
  expect(await rankingCalls(page)).toBe(1);

  // Re-rank: exactly one fresh call.
  await page.getByRole('button', { name: 'Re-rank' }).click();
  await expect(page.getByRole('button', { name: 'Re-rank' })).toBeEnabled();
  await expect.poll(() => rankingCalls(page)).toBe(2);

  // A contact added at the company on Network shows when the user goes back, with no reload
  // (#651), and the changed input ranks once more.
  await page.evaluate(() => ((window as unknown as { qaMarker: number }).qaMarker = 692));
  await page.getByRole('link', { name: 'Network', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Network', level: 1 })).toBeVisible();
  await page.getByLabel('Name').fill('Kim Lee');
  await page.getByLabel('Company').fill('Initech');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(toasts(page).getByText('Contact added')).toBeVisible();
  await page.goBack();
  await page.getByRole('tab', { name: 'Referrals' }).click();
  await expect(page.getByRole('button', { name: 'Ask Kim Lee for a referral' })).toBeVisible();
  await expect(candidates(page)).toHaveCount(3);
  expect(
    await page.evaluate(() => (window as unknown as { qaMarker?: number }).qaMarker),
    'the page was not reloaded',
  ).toBe(692);
  await expect.poll(() => rankingCalls(page)).toBe(3);

  // A spent daily budget. Settings has no budget field, and the AI fake ignores a policy's prices,
  // so the fake is told, through the opportunity's description, to report a call big enough to
  // spend the task's daily budget (MOCK_HEAVY_USAGE_MARKER, testSupport/mockAi.ts). The changed
  // description is a changed input: one ranking, which spends the budget.
  const id = new URL(oppUrl).pathname.split('/').at(-1)!;
  const csrf =
    (await page.context().cookies()).find((c) => c.name === 'opportun_csrf')?.value ?? '';
  const patched = await page.request.patch(`/api/v1/opportunities/${id}`, {
    headers: { 'x-csrf-token': csrf },
    data: { descriptionMd: `Platform role. ${MOCK_HEAVY_USAGE_MARKER}` },
  });
  expect(patched.status(), await patched.text()).toBe(200);
  await page.goto(oppUrl);
  await page.getByRole('tab', { name: 'Referrals' }).click();
  await expect(candidates(page)).toHaveCount(3);
  await expect.poll(() => rankingCalls(page)).toBe(4);

  // Opened again with the budget spent: the budget's own words, not "AI is unavailable", the
  // contacts still listed by closeness, and no call reached the AI.
  await page.goto(oppUrl);
  await page.getByRole('tab', { name: 'Referrals' }).click();
  await expect(page.getByText(/not ranked by AI \(today's AI budget is used up\)/)).toBeVisible();
  await expect(page.getByText(/AI is unavailable right now/)).toBeHidden();
  await expect(candidates(page)).toHaveCount(3);
  expect(await rankingCalls(page)).toBe(4);
});
