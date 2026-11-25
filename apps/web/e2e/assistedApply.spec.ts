// Assisted apply (https://github.com/bgoleno/opportun/issues/117), in a real browser against the
// real server with OPPORTUN_SUBMISSIONS=1 (playwright.config.ts).
//
// Nothing leaves the machine: every request to a host other than the test server is answered
// by a stub page (stubOtherHosts), so the handoff's new tab never reaches a real ATS (Opportun
// never submits; the e2e never even visits).
import { expect, test, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import {
  captureGreenhouseOpportunity,
  card,
  choose,
  createCaptureToken,
  createOpportunity,
  PASSWORD,
  registerBaseResume,
  registerUser,
  stubOtherHosts,
} from './helpers';
import { expectLinedUp } from './fieldRows';

test.beforeEach(async ({ context }) => {
  await stubOtherHosts(context);
});

/**
 * An opportunity whose posting the server confirmed on a recognised Greenhouse board
 * (captureGreenhouseOpportunity), and a final resume.
 */
async function readyOpportunity(page: Page, playwright: PlaywrightWorkerArgs['playwright']) {
  await registerUser(page);

  await registerBaseResume(page, 'e2eApplyResumeDoc1');
  await page.getByRole('link', { name: 'Jane Example Base Resume' }).click();
  // Choosing a status saves it: wait for the server to have it.
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /\/api\/v1\/resumes\//.test(r.url()) && r.ok(),
  );
  await choose(page, 'Status', 'Final');
  await saved;

  const opportunityId = await captureGreenhouseOpportunity(page, playwright);

  await page.goto(`/opportunities/${opportunityId}`);
  const panel = page.getByRole('region', { name: 'Assisted apply' });
  await expect(async () => {
    await page.reload();
    await expect(panel.getByRole('link', { name: 'Apply on Greenhouse' })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });
  return { id: opportunityId, panel };
}

test('feature off: the opportunity page shows nothing of assisted apply, and the apply page says so', async ({
  page,
}) => {
  // What the server answers with the flag off, or on the demo (design 7.8; the server's own
  // tests cover the flag). Here the browser checks the page's response to it.
  await page.route('**/api/v1/opportunities/*/submissions*', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'feature_unavailable' } }),
    }),
  );
  await registerUser(page);
  const opp = { company: 'Initech', title: 'Platform Engineer' };
  await createOpportunity(page, opp);
  await card(page, opp.company, opp.title).getByRole('link', { name: opp.title }).click();
  await expect(page.getByRole('heading', { name: opp.title, level: 1 })).toBeVisible();
  // The rail has loaded (the panel sits above Next steps), so an absence is meaningful.
  await expect(page.getByText(/next steps/i).first()).toBeVisible();
  await expect(page.getByText(/assisted apply/i)).toHaveCount(0);
  await expect(page.getByText(/apply on/i)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /apply/i })).toHaveCount(0);

  const id = new URL(page.url()).pathname.split('/').pop() as string;
  await page.goto(`/opportunities/${id}/apply?step=review`);
  await expect(page.getByText('Assisted apply is not available here.')).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});

test('apply: choose a resume, add details, review everything, open the form, and nothing is submitted', async ({
  page,
  playwright,
}) => {
  const { id, panel } = await readyOpportunity(page, playwright);
  await panel.getByRole('link', { name: 'Apply on Greenhouse' }).click();

  // S2: the resume.
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await page.getByRole('button', { name: 'Next: Details' }).click();

  // S3: details and one question.
  await expect(page.getByLabel('Full name')).toBeVisible();
  // Some fields have a hint, and one whose value is not the profile's has a tick under it (#951).
  await page.getByLabel('Full name').fill('Jane Example');
  await page.getByLabel('Email').fill('jane@example.com');
  await expectLinedUp(page, []);
  await page.getByRole('button', { name: 'Add a question' }).click();
  await page.getByLabel('Question', { exact: true }).fill('Why Vandelay?');
  await page.getByLabel('Your answer').fill('Latex, mostly.');
  // The fields prefill fills by name (#181). A LinkedIn address without its scheme is refused
  // by the server in words naming the field, and the step stays put until it is fixed.
  await page.getByLabel('First name').fill('Jane');
  await page.getByLabel('Last name').fill('Example');
  await page.getByLabel('LinkedIn profile').fill('linkedin.com/in/jane-example');
  await page.getByLabel('Website').fill('https://jane.example.com');
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(page.getByText(/LinkedIn profile: enter the whole web address/)).toBeVisible();
  await page.getByLabel('LinkedIn profile').fill('https://www.linkedin.com/in/jane-example');
  await page.getByRole('button', { name: 'Next: Review' }).click();

  // S4: everything on one screen, the box unticked, no countdown.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Check everything before you open the form' }),
  ).toBeVisible();
  await expect(page.getByText('https://boards.greenhouse.io/vandelay/jobs/1002')).toBeVisible();
  for (const text of [
    'Jane Example',
    'jane@example.com',
    'Why Vandelay?',
    'Latex, mostly.',
    'Jane',
    'Example',
    'https://www.linkedin.com/in/jane-example',
    'https://jane.example.com',
  ]) {
    await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  }
  const box = page.getByRole('checkbox', { name: /I will press Submit myself/ });
  await expect(box).not.toBeChecked();
  // The saved copy (#115): the snapshot job exports the Google Doc (OPPORTUN_DOCS_MOCK), and the
  // review shows it, with its download, once it is ready (the page polls while it is pending).
  const copy = page.getByRole('link', { name: /download the saved copy/i });
  await expect(copy).toBeVisible({ timeout: 30_000 });
  const pdf = await page.request.get(String(await copy.getAttribute('href')));
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');

  // Criterion 2: an edit after this point goes back through the review.
  await page.getByRole('link', { name: 'Back' }).click();
  await page.getByLabel('Your answer').fill('Latex, and the people.');
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(page.getByText('Latex, and the people.')).toBeVisible();

  await box.check();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Confirm review and open boards.greenhouse.io' }).click();
  const tab = await popup;
  await tab.waitForURL('https://boards.greenhouse.io/vandelay/jobs/1002');
  await expect(tab.getByRole('heading', { name: 'Stub application form' })).toBeVisible();
  // The opened tab cannot reach back into Opportun.
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();

  // S5.
  await expect(page.getByText(/Opportun has not submitted anything/)).toBeVisible();
  await page.goto(`/opportunities/${id}`);
  await expect(panel.getByText('Opened on ATS')).toBeVisible();

  // M2a (#118): the user says they submitted it, and Opportun records it once.
  await page.goto(`/opportunities/${id}/apply?step=open`);
  await page.getByRole('button', { name: 'I submitted it' }).click();
  const attest = page.getByRole('dialog', { name: 'Record that you submitted this application?' });
  await expect(attest.getByLabel('When did you submit?')).toBeVisible();
  await attest.getByRole('button', { name: 'Yes, I submitted it' }).click();
  await page.waitForURL(`**/opportunities/${id}`);
  // The chip reads "Submission status: Submitted" (its label is part of the text).
  await expect(panel.getByText(/Submission status: Submitted/)).toBeVisible();
  await expect(page.getByText(/Applied via Greenhouse:/).first()).toBeVisible();

  // S7 (#149): the application's own page, and an outcome recorded from it.
  await panel.getByRole('link', { name: 'View application' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Application to Vandelay Industries' }),
  ).toBeVisible();
  await expect(page.getByText(/^Waiting for a confirmation\./)).toBeVisible();
  const historySteps = page.getByRole('list', { name: 'History' }).getByRole('listitem');
  await expect(historySteps).toHaveCount(4);
  await page.getByRole('button', { name: 'I saw a confirmation' }).click();
  await page
    .getByRole('dialog', { name: 'Mark as confirmed?' })
    .getByRole('button', { name: 'Mark confirmed' })
    .click();
  await expect(page.getByText(/Submission status: Confirmed/)).toBeVisible();
  await expect(page.getByText(/You marked this confirmed on/)).toBeVisible();
});

// qa's steps on https://github.com/bgoleno/opportun/issues/1057, criterion 1, to a filled form: what the
// extension is given is asked of the server as it asks.
test('opened, and then its opportunity merged: told what happened, reviewed again, and given to fill', async ({
  page,
  context,
  playwright,
}) => {
  const { id, panel } = await readyOpportunity(page, playwright);
  const token = await createCaptureToken(page, PASSWORD, /^Assisted apply/);
  const extension = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  const current = async () =>
    (await (
      await extension.get(
        `/api/v1/connector/apply/current?url=${encodeURIComponent('https://boards.greenhouse.io/vandelay/jobs/1002')}`,
      )
    ).json()) as { attempt: Record<string, unknown> | null; reason: string | null; cause?: string };
  /** From the review to the employer's form (a stub), and back. */
  const reviewAndOpen = async (p: Page) => {
    await p.getByRole('checkbox', { name: /I will press Submit myself/ }).check();
    const popup = p.waitForEvent('popup');
    await p.getByRole('button', { name: /^Confirm review and open/ }).click();
    const tab = await popup;
    await tab.waitForURL('https://boards.greenhouse.io/vandelay/jobs/1002');
    await tab.close();
    await expect(p.getByText(/Opportun has not submitted anything/)).toBeVisible();
  };
  try {
    await page.goto(`/opportunities/${id}`);
    await panel.getByRole('link', { name: 'Apply on Greenhouse' }).click();
    await page.getByRole('button', { name: 'Next: Details' }).click();
    await page.getByLabel('Full name').fill('Jane Example');
    await page.getByLabel('Email').fill('jane@example.com');
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await expect(page.getByRole('link', { name: /download the saved copy/i })).toBeVisible({
      timeout: 30_000,
    });
    await reviewAndOpen(page);
    expect((await current()).attempt).not.toBeNull();

    // In another tab, merged into one made by hand. This one is left on the last step.
    const other = await context.newPage();
    await other.goto('/pipeline');
    const kept = { company: 'Vandelay Industries', title: 'Platform Engineer (referral)' };
    await createOpportunity(other, kept);
    await other.goto(`/opportunities/${id}`);
    await other.getByRole('button', { name: 'More actions' }).click();
    await other.getByRole('menuitem', { name: 'Merge into...' }).click();
    await other
      .getByRole('button', { name: new RegExp('Platform Engineer \\(referral\\)') })
      .click();
    const dialog = other.getByRole('dialog', { name: 'Merge these opportunities?' });
    await expect(dialog).toContainText(
      'Its application is open on boards.greenhouse.io. It moves too, but the extension will no longer fill it',
    );
    await dialog.getByRole('button', { name: 'Merge', exact: true }).click();
    await expect(other.getByRole('heading', { level: 1, name: kept.title })).toBeVisible();
    const keptId = new URL(other.url()).pathname.split('/').pop() as string;
    expect(await current()).toEqual({ attempt: null, reason: 'review_stale', cause: 'merged' });

    // The kept one's panel, and the tab left on the merged one.
    const keptPanel = other.getByRole('region', { name: 'Assisted apply' });
    await expect(keptPanel).toContainText(
      'Its opportunity was merged into this one after you opened it. The extension no longer fills it',
    );
    await expect(keptPanel).not.toContainText('The posting changed after you started');
    // Coming back to it reads it again: what the browser sends for that, as nothing hides a tab here.
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await page.waitForURL(`**/opportunities/${keptId}/apply?step=open`);
    await expect(
      page.getByText('merged into this one after you opened it', { exact: false }),
    ).toBeVisible();

    await keptPanel.getByRole('link', { name: 'Instructions' }).click();
    await expect(
      other.getByText(/It still goes to boards\.greenhouse\.io, REQ 1002/),
    ).toBeVisible();
    await expect(other.getByText(/It fills in what you reviewed/)).toHaveCount(0);
    await other.getByRole('button', { name: 'Review it again' }).click();
    await other
      .getByRole('dialog', { name: 'Review this application again?' })
      .getByRole('button', { name: 'Review it again' })
      .click();
    await other.waitForURL(`**/opportunities/${keptId}/apply?step=review`);
    await expect(
      other.getByText('Check everything, then review it again.', { exact: false }),
    ).toBeVisible();
    await expect(other.getByText(/^You opened this application on/)).toBeVisible();
    await expect(other.getByText('Jane Example', { exact: true }).first()).toBeVisible();
    await reviewAndOpen(other);
    const given = await current();
    expect(given).toMatchObject({ reason: null });
    expect(given.attempt).toMatchObject({ opportunityId: keptId, firstRead: true });
    await other.close();
  } finally {
    await extension.dispose();
  }
});

// Phone widths (#135 criterion 8 asks 390; 320 is the narrowest mobile.spec.ts measures). Each
// step is measured once it is on screen, never the opportunity page it replaced.
for (const width of [390, 320] as const) {
  test(`at ${width} px no apply step scrolls sideways (#135)`, async ({ page, playwright }) => {
    const { panel } = await readyOpportunity(page, playwright);
    const sideways = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    await panel.getByRole('link', { name: 'Apply on Greenhouse' }).click();
    await page.setViewportSize({ width, height: 740 });

    await expect(page.getByRole('button', { name: 'Next: Details' })).toBeVisible();
    expect(await sideways(), 'resume step').toBe(0);

    await page.getByRole('button', { name: 'Next: Details' }).click();
    await expect(page.getByLabel('Full name')).toBeVisible();
    expect(await sideways(), 'details step').toBe(0);

    await page.getByRole('button', { name: 'Next: Review' }).click();
    await expect(page.getByRole('link', { name: /download the saved copy/i })).toBeVisible({
      timeout: 30_000,
    });
    expect(await sideways(), 'review step').toBe(0);
  });
}
