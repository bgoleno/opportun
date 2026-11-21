// Assisted apply on the demo (https://github.com/bgoleno/opportun/issues/547, slice 4 of #542), in
// a real browser against a seeded demo server (playwright.config.ts, the `demo` project), up to
// the handoff and the extension's read of it. The two kinds of account a demo server has (the
// owner's decision 133):
//
// - a shared account, one of the seed's pinned logins: the draft starts empty, it carries no
//   resume, a value that came with the demo is refused by field, and only the visitor (the
//   session) who started an application is given it;
// - a dedicated account, made for one person with the CLI: assisted apply as on any instance.
//
// Nothing leaves the machine: every other host is a stub page (stubOtherHosts), so the handoff's
// tab never reaches a real ATS, and only fixtures are filled (the owner's decision 1: never a real
// employer's form in a test).
import { execFileSync } from 'node:child_process';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { DEMO_DATA_DIR, DEMO_DB_ENV, DEMO_PASSWORDS, DEMO_URL } from '../playwright.config';
import {
  captureGreenhouseOpportunity,
  choose,
  registerBaseResume,
  stubOtherHosts,
} from './helpers';

/** demo-user1, a shared account (seedDemoFixture's DEMO_USERS). */
const SHARED = { email: 'demo-user1@opportun-demo.example', password: DEMO_PASSWORDS.user1 };
const SHARED_WARNING =
  'This is a shared demo account. Anything you enter here is visible to others using it, and is cleared at the nightly reset.';
const NO_RESUME =
  'On the demo an application carries no resume: attach your own on the employer’s form.';
const POSTING = 'https://boards.greenhouse.io/vandelay/jobs/1002';

test.beforeEach(async ({ context }) => {
  await stubOtherHosts(context, DEMO_URL);
});

/**
 * Signs in, and declines the tour, which a demo account is offered at every sign-in. A dedicated
 * account is offered it once, as anywhere.
 */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  const welcome = page.getByRole('dialog', { name: "Let's get your search running" });
  await welcome.getByRole('button', { name: 'Not now' }).click();
  await expect(welcome).toBeHidden();
}

/** Mints an Assisted apply token through Settings, as a visitor pairing the extension does. */
async function applyToken(page: Page, password: string): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Chrome extension');
  await dialog.getByRole('checkbox', { name: /^Assisted apply/ }).setChecked(true);
  await dialog.getByLabel('Current password').fill(password);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  await shown.getByRole('button', { name: 'I saved it' }).click();
  return token;
}

/** What the extension's popup reads on the form's tab: the handed-off attempt for that page. */
async function currentFor(
  extension: APIRequestContext,
  token: string,
): Promise<{ attempt: { destinationUrl: string; fields: Record<string, string> } | null }> {
  const res = await extension.get(
    `/api/v1/connector/apply/current?url=${encodeURIComponent(POSTING)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as {
    attempt: { destinationUrl: string; fields: Record<string, string> } | null;
  };
}

/** The opportunity page, once its posting is confirmed on Greenhouse and Apply is offered. */
async function applyOffered(page: Page, id: string) {
  await page.goto(`/opportunities/${id}`);
  const panel = page.getByRole('region', { name: 'Assisted apply' });
  await expect(async () => {
    await page.reload();
    await expect(panel.getByRole('link', { name: 'Apply on Greenhouse' })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });
  return panel;
}

async function captured(
  page: Page,
  playwright: PlaywrightWorkerArgs['playwright'],
  password: string,
): Promise<string> {
  return await captureGreenhouseOpportunity(page, playwright, { baseURL: DEMO_URL, password });
}

test('a shared account: own details only, no resume, a demo value refused by field, handed off to its own visitor', async ({
  page,
  playwright,
  browser,
}) => {
  await signIn(page, SHARED.email, SHARED.password);
  // Before any draft: the account has resumes (the seed's), and Apply needs none of them.
  const id = await captured(page, playwright, SHARED.password);
  const panel = await applyOffered(page, id);
  await panel.getByRole('link', { name: 'Apply on Greenhouse' }).click();

  // The resume step offers none of the demo's resumes, and says why.
  await expect(page.getByText(SHARED_WARNING)).toBeVisible();
  await expect(page.getByText(NO_RESUME)).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next: Details' }).click();

  // The details start empty: nothing of the demo's profile or account, and no Save to my profile.
  await expect(page.getByText(SHARED_WARNING)).toBeVisible();
  await expect(page.getByLabel('Full name')).toHaveValue('');
  await expect(page.getByLabel('Email')).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: /Save to my profile/ })).toHaveCount(0);

  // A value that came with the demo (the account's own display name) is refused at the review,
  // by field, and nothing is opened.
  await page.getByLabel('Full name').fill('Demo User 1');
  await page.getByLabel('Email').fill('jane.visitor@example.com');
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Check everything before you open the form' }),
  ).toBeVisible();
  await expect(page.getByText(`No resume. ${NO_RESUME}`)).toBeVisible();
  const box = page.getByRole('checkbox', { name: /I will press Submit myself/ });
  await box.check();
  // The page opens a blank tab on the click, so the browser allows it, and points it at the form
  // only once the review and the handoff have both gone through (ApplyPage's confirm): refused,
  // that blank tab is closed without ever leaving about:blank.
  const blank = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Confirm review and open boards.greenhouse.io' }).click();
  const refused = page.getByRole('alert').filter({ hasText: 'Full name: this value came with' });
  await expect(refused).toContainText('Nothing was opened.');
  const refusedTab = await blank;
  await expect.poll(() => refusedTab.isClosed(), { message: 'the blank tab is closed' }).toBe(true);
  expect(refusedTab.url(), 'it never reached the form').toBe('about:blank');

  // The visitor's own name instead: reviewed, and the form opens.
  await refused.getByRole('link', { name: 'Change your details' }).click();
  await page.getByLabel('Full name').fill('Jane Visitor');
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(page.getByText('Jane Visitor', { exact: true })).toBeVisible();
  await box.check();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Confirm review and open boards.greenhouse.io' }).click();
  const tab = await popup;
  await tab.waitForURL(POSTING);
  await expect(tab.getByRole('heading', { name: 'Stub application form' })).toBeVisible();
  await tab.close();
  await expect(page.getByText(/Opportun has not submitted anything/)).toBeVisible();

  // The extension, paired in this session, is given this visitor's application: their own
  // details, and no resume.
  const extension = await playwright.request.newContext({ baseURL: DEMO_URL });
  try {
    const mine = await currentFor(extension, await applyToken(page, SHARED.password));
    expect(mine.attempt?.destinationUrl).toBe(POSTING);
    expect(mine.attempt?.fields).toEqual({
      fullName: 'Jane Visitor',
      email: 'jane.visitor@example.com',
    });

    // Another visitor on the same shared account (a second session) can read the application,
    // but their extension is not given it.
    const other = await browser.newContext({ baseURL: DEMO_URL });
    try {
      await stubOtherHosts(other, DEMO_URL);
      const otherPage = await other.newPage();
      await signIn(otherPage, SHARED.email, SHARED.password);
      await otherPage.goto(`/opportunities/${id}`);
      await expect(
        otherPage.getByRole('region', { name: 'Assisted apply' }).getByText('Opened on ATS'),
      ).toBeVisible();
      const theirs = await currentFor(extension, await applyToken(otherPage, SHARED.password));
      expect(theirs.attempt).toBeNull();
    } finally {
      await other.close();
    }
  } finally {
    await extension.dispose();
  }
});

test('a dedicated account: assisted apply as on any instance, with its own resume and no demo warning', async ({
  page,
  playwright,
}) => {
  // Made as the operator makes one (docs/demo-deployment.md), against the running demo server's
  // database: the command prints the password once, on stdout.
  const email = `e2e-dedicated-${Date.now()}@example.com`;
  const password = execFileSync(
    'node',
    ['--import', 'tsx', 'src/cli/createDemoAccount.ts', email, 'Jane Dedicated'],
    {
      cwd: '../server',
      env: { ...process.env, ...DEMO_DB_ENV, DATA_DIR: DEMO_DATA_DIR, OPPORTUN_DEMO: '1' },
      encoding: 'utf8',
    },
  ).trim();
  await signIn(page, email, password);

  // Its own resume, made Final: a dedicated account needs one to apply, as anywhere.
  await registerBaseResume(page, 'e2eDemoDedicatedDoc1');
  await page.getByRole('link', { name: 'Jane Example Base Resume' }).click();
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /\/api\/v1\/resumes\//.test(r.url()) && r.ok(),
  );
  await choose(page, 'Status', 'Final');
  await saved;

  const id = await captured(page, playwright, password);
  const panel = await applyOffered(page, id);
  await panel.getByRole('link', { name: 'Apply on Greenhouse' }).click();

  // The resume step offers its own resume; no shared-account warning anywhere on the way.
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByText(NO_RESUME)).toHaveCount(0);
  await expect(page.getByText(SHARED_WARNING)).toHaveCount(0);
  await page.getByRole('button', { name: 'Next: Details' }).click();

  // Prefilled from the account, as off the demo.
  await expect(page.getByLabel('Full name')).toHaveValue('Jane Dedicated');
  await expect(page.getByLabel('Email')).toHaveValue(email);
  await expect(page.getByText(SHARED_WARNING)).toHaveCount(0);
  await page.getByRole('button', { name: 'Next: Review' }).click();
  // Its resume's saved copy (the snapshot job), as off the demo, before the form opens.
  await expect(page.getByRole('link', { name: /download the saved copy/i })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('checkbox', { name: /I will press Submit myself/ }).check();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Confirm review and open boards.greenhouse.io' }).click();
  const tab = await popup;
  await tab.waitForURL(POSTING);
  await tab.close();
  await expect(page.getByText(/Opportun has not submitted anything/)).toBeVisible();
});
