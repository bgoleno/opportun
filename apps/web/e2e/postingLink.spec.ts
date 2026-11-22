// A posting-link change re-identifies the Greenhouse job, and assisted apply follows it
// (https://github.com/bgoleno/opportun/issues/748, gap 2 of qa's survey; shipped by #633 and
// #714). The opportunity is captured as the assisted apply spec captures it, so its posting is
// confirmed on the fixture board (boards.greenhouse.io/vandelay/jobs/1002) and the Assisted apply
// panel offers Apply on Greenhouse. The Details tab's link edit then changes the link, and the
// save asks the company's known boards about a `gh_jid` job. OPPORTUN_SOURCE_MOCK answers those
// single-job requests for the fixture job ids (1001 to 1003) and records each one it answers
// (GET /__mock/discovery/job-checks). Runs in both CI legs.
import { expect, test, type Page } from '@playwright/test';
import {
  captureGreenhouseOpportunity,
  choose,
  registerBaseResume,
  registerUser,
  stubOtherHosts,
} from './helpers';

test.beforeEach(async ({ context }) => {
  await stubOtherHosts(context);
});

interface Ref {
  kind: string;
  org: string | null;
  externalId: string;
  url: string;
  verifiedVia?: string;
}

const refOf = async (page: Page, id: string): Promise<Ref | null> =>
  (
    (await (await page.request.get(`/api/v1/opportunities/${id}`)).json()) as {
      atsJobRef: Ref | null;
    }
  ).atsJobRef;

const jobChecks = async (page: Page): Promise<string[]> =>
  ((await (await page.request.get('/__mock/discovery/job-checks')).json()) as { checks: string[] })
    .checks;

/** The Details tab's link edit: types `link` and saves, and waits for the save's answer. */
async function editLink(page: Page, link: string): Promise<void> {
  await page.getByRole('tab', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Edit link' }).click();
  await page.getByLabel('Posting link').fill(link);
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /\/api\/v1\/opportunities\/[^/]+$/.test(r.url()),
  );
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByLabel('Posting link')).toBeHidden();
}

test('a posting-link edit re-identifies the Greenhouse job, an unknown one clears it, and an unchanged one asks no board', async ({
  page,
  playwright,
}) => {
  await registerUser(page);
  await registerBaseResume(page, 'e2ePostingLinkResumeDoc1');
  await page.getByRole('link', { name: 'Jane Example Base Resume' }).click();
  const final = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /\/api\/v1\/resumes\//.test(r.url()) && r.ok(),
  );
  await choose(page, 'Status', 'Final');
  await final;

  const id = await captureGreenhouseOpportunity(page, playwright);
  await page.goto(`/opportunities/${id}`);
  const panel = page.getByRole('region', { name: 'Assisted apply' });
  const apply = panel.getByRole('link', { name: 'Apply on Greenhouse' });
  await expect(async () => {
    await page.reload();
    await expect(apply).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  expect(await refOf(page, id)).toMatchObject({ kind: 'ats_greenhouse', externalId: '1002' });

  // The company's own careers page names another of its jobs: the save asks the known boards,
  // and the one that holds job 1003 gives the identity. The panel follows with no reload.
  const before = (await jobChecks(page)).length;
  await editLink(page, 'https://careers.vandelay.example/jobs?gh_jid=1003');
  const asked = (await jobChecks(page)).slice(before);
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((c) => c.endsWith('/1003'))).toBe(true);
  const ref = await refOf(page, id);
  expect(ref).toMatchObject({ kind: 'ats_greenhouse', externalId: '1003', verifiedVia: 'gh_jid' });
  // The handoff goes to the board that holds it, never to the company's link.
  expect(ref?.url).toBe(`https://job-boards.greenhouse.io/${ref?.org}/jobs/1003`);
  expect(asked).toContain(`${ref?.org}/1003`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(apply).toBeVisible();

  // The same link saved again asks no board, and the identity stays.
  const unchanged = (await jobChecks(page)).length;
  await editLink(page, 'https://careers.vandelay.example/jobs?gh_jid=1003');
  expect((await jobChecks(page)).length).toBe(unchanged);
  expect(await refOf(page, id)).toEqual(ref);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(apply).toBeVisible();

  // A job no known board holds: the identity is cleared, and the panel says why, with no reload.
  await editLink(page, 'https://careers.vandelay.example/jobs?gh_jid=9999');
  expect(await refOf(page, id)).toBeNull();
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(panel).toBeVisible();
  await expect(apply).toBeHidden();
  await expect(panel).toContainText(
    "This looks like a Greenhouse job on the company's own careers page. Find the posting on Greenhouse to apply with assisted apply.",
  );

  // That unidentified link saved again asks no board either (#714: an unchanged link is not
  // checked again, so a form that sends every field does not re-ask every board on each save).
  const unidentified = (await jobChecks(page)).length;
  await editLink(page, 'https://careers.vandelay.example/jobs?gh_jid=9999');
  expect((await jobChecks(page)).length).toBe(unidentified);
  expect(await refOf(page, id)).toBeNull();
});
