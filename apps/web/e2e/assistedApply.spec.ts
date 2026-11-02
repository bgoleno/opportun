// Assisted apply (https://github.com/bgoleno/opportun/issues/117), in a real browser against the
// real server with OPPORTUN_SUBMISSIONS=1 (playwright.config.ts).
//
// Nothing leaves the machine: every request to a host other than the test server is answered
// here by a stub page, so the handoff's new tab never reaches a real ATS (Opportun never
// submits; the e2e never even visits).
import { expect, test, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { BASE_URL } from '../playwright.config';
import { card, choose, createOpportunity, PASSWORD, registerUser } from './helpers';

const STUB = '<!doctype html><title>Stub ATS</title><h1>Stub application form</h1>';

test.beforeEach(async ({ context }) => {
  await context.route(
    (url) => !url.href.startsWith(BASE_URL),
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: STUB }),
  );
});

/** Creates a device token through Settings, as devices.spec.ts does, for the capture call. */
async function captureToken(page: Page): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Chrome extension');
  await dialog.getByRole('checkbox', { name: /^Browser capture/ }).setChecked(true);
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  await shown.getByRole('button', { name: 'I saved it' }).click();
  return token;
}

/**
 * An opportunity whose posting the server confirmed on a recognised Greenhouse board, and a
 * final resume. The path a user takes: the extension captures the LinkedIn job page, and the
 * posting job (posting.reconcile, every second here) finds the same job on the company's board
 * (the OPPORTUN_SOURCE_MOCK fixture: boards.greenhouse.io/vandelay/jobs/1002), which names the
 * ATS and the requisition. The LinkedIn page itself is never fetched: the capture carries it.
 */
async function readyOpportunity(page: Page, playwright: PlaywrightWorkerArgs['playwright']) {
  await registerUser(page);

  await page.goto('/resumes');
  await page
    .getByLabel('Google Doc link')
    .fill('https://docs.google.com/document/d/e2eApplyResumeDoc1/edit');
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByRole('link', { name: 'Jane Example Base Resume' }).click();
  // Choosing a status saves it: wait for the server to have it.
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /\/api\/v1\/resumes\//.test(r.url()) && r.ok(),
  );
  await choose(page, 'Status', 'Final');
  await saved;

  const token = await captureToken(page);
  const extension = await playwright.request.newContext({ baseURL: BASE_URL });
  let opportunityId: string;
  try {
    const res = await extension.post('/api/v1/connector/capture', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        url: 'https://www.linkedin.com/jobs/view/3901234599/',
        title: 'Staff Platform Engineer | Vandelay Industries | LinkedIn',
        text: [
          'Vandelay Industries',
          'Staff Platform Engineer',
          'Remote (US) · 2 days ago',
          'Full-time',
          'About the job',
          'Lead our Go platform on Kubernetes. Terraform and on-call leadership a plus.',
          'About the company',
          'Vandelay Industries',
        ].join('\n'),
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { kind: string; opportunityId: string };
    expect(body.kind).toBe('job');
    opportunityId = body.opportunityId;
  } finally {
    await extension.dispose();
  }

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
  await page.getByRole('button', { name: 'Next: Review' }).click();

  // S4: everything on one screen, the box unticked, no countdown.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Check everything before you open the form' }),
  ).toBeVisible();
  await expect(page.getByText('https://boards.greenhouse.io/vandelay/jobs/1002')).toBeVisible();
  for (const text of ['Jane Example', 'jane@example.com', 'Why Vandelay?', 'Latex, mostly.']) {
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
});
