// Assisted apply (https://github.com/bgoleno/opportun/issues/117), in a real browser against the
// real server with OPPORTUN_SUBMISSIONS=1 (playwright.config.ts).
//
// Nothing leaves the machine: every request to a host other than the test server is answered
// by a stub page (stubOtherHosts), so the handoff's new tab never reaches a real ATS (Opportun
// never submits; the e2e never even visits).
import { expect, test, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import {
  captureGreenhouseOpportunity,
  card,
  choose,
  createOpportunity,
  registerBaseResume,
  registerUser,
  stubOtherHosts,
} from './helpers';

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
  await page.getByLabel('Full name').fill('Jane Example');
  await page.getByLabel('Email').fill('jane@example.com');
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
