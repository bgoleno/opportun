// Discovery flows (FR-D1, D4, D8, D9, FR-U6) against the real server, with job boards served by
// the source mock (OPPORTUN_SOURCE_MOCK: fixture Greenhouse postings and fixture board probes)
// and ranking and company suggestions by the AI mock.
import { expect, test, type Page } from '@playwright/test';
import { card, choose, registerUser, toasts } from './helpers';

const COMPANY = 'Vandelay Industries';
const label = (title: string) => `${title} at ${COMPANY}`;

/** Reloads until `check` passes: discovery work happens in background jobs. */
async function eventually(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout: 30_000 });
}

test('discovery: add a source, run it, and triage the ranked queue by keyboard', async ({
  page,
}) => {
  await registerUser(page);

  await page.goto('/discovery/sources');
  await page.getByRole('button', { name: 'New source' }).click();
  const dialog = page.getByRole('dialog', { name: 'New source' });
  await choose(dialog, 'Kind', 'Greenhouse');
  await dialog.getByLabel('Board slug').fill('vandelay');
  await dialog.getByRole('button', { name: 'Add source' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Run Greenhouse vandelay now' }).click();
  await expect(toasts(page).getByText('Run queued')).toBeVisible();

  // The run stores three postings and ranking scores each one; best first.
  await page.goto('/discovery');
  const rows = page.getByRole('list', { name: 'Results to review' }).getByRole('listitem');
  await eventually(page, async () => {
    await expect(rows).toHaveCount(3, { timeout: 1000 });
    await expect(rows.getByLabel(/^AI score/)).toHaveCount(3, { timeout: 1000 });
  });
  await expect(rows.nth(0)).toHaveAccessibleName(label('Staff Platform Engineer'));
  await expect(rows.nth(0).getByLabel('AI score 92 of 100')).toBeVisible();
  await expect(rows.nth(1)).toHaveAccessibleName(label('Senior Backend Engineer'));
  await expect(rows.nth(2)).toHaveAccessibleName(label('Office Coordinator'));
  await expect(rows.nth(2).getByLabel('AI score 18 of 100')).toBeVisible();

  // Keyboard triage: j selects the top result, i accepts it.
  await page.keyboard.press('j');
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('i');
  await expect(toasts(page).getByText('Added to pipeline')).toBeVisible();
  await expect(rows).toHaveCount(2);

  // The selection moved to the next result; j moves to the last one, x dismisses it.
  await page.keyboard.press('j');
  await expect(page.getByRole('listitem', { name: label('Office Coordinator') })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await page.keyboard.press('x');
  const dismiss = page.getByRole('dialog', { name: 'Dismiss result' });
  await choose(dismiss, 'Reason', 'Industry');
  await dismiss.getByLabel('Note (optional)').fill('Not an engineering role');
  await dismiss.getByRole('button', { name: 'Dismiss' }).click();
  await expect(dismiss).toBeHidden();
  await expect(toasts(page).getByText('Dismissed', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toHaveAccessibleName(label('Senior Backend Engineer'));

  // The accepted posting is an opportunity at the discovered stage; the dismissed one is not.
  await page.goto('/pipeline');
  await expect(card(page, COMPANY, 'Staff Platform Engineer')).toBeVisible();
  await expect(
    page.getByRole('button', { name: `Move ${COMPANY}: Staff Platform Engineer` }),
  ).toHaveText('New');
  await expect(card(page, COMPANY, 'Office Coordinator')).toHaveCount(0);
});

test('discovery: a dismissed result gets an Unsuppress action in the Decided view (#96, #97)', async ({
  page,
}) => {
  await registerUser(page);

  await page.goto('/discovery/sources');
  await page.getByRole('button', { name: 'New source' }).click();
  const dialog = page.getByRole('dialog', { name: 'New source' });
  await choose(dialog, 'Kind', 'Greenhouse');
  await dialog.getByLabel('Board slug').fill('vandelay');
  await dialog.getByRole('button', { name: 'Add source' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Run Greenhouse vandelay now' }).click();
  await expect(toasts(page).getByText('Run queued')).toBeVisible();

  await page.goto('/discovery');
  const rows = page.getByRole('list', { name: 'Results to review' }).getByRole('listitem');
  await eventually(page, async () => {
    await expect(rows).toHaveCount(3, { timeout: 1000 });
  });

  const target = label('Office Coordinator');
  await page
    .getByRole('listitem', { name: target })
    .getByRole('button', { name: `Dismiss ${target}` })
    .click();
  const dismiss = page.getByRole('dialog', { name: 'Dismiss result' });
  await choose(dismiss, 'Reason', 'Industry');
  await dismiss.getByRole('button', { name: 'Dismiss' }).click();
  await expect(dismiss).toBeHidden();

  // The Decided view (#97) is where the unsuppress action (#96) lives, not the review queue:
  // it is already gone from there once decided (the assertion above already covers that).
  await page.goto('/discovery/decided');
  const decidedRow = page.getByRole('listitem', { name: target });
  await expect(decidedRow).toBeVisible();
  await expect(decidedRow.getByText('Unsuppressed')).toHaveCount(0);
  await decidedRow.getByRole('button', { name: `Unsuppress ${target}` }).click();
  await expect(toasts(page).getByText('Unsuppressed', { exact: true })).toBeVisible();

  // A reversed decision now reads differently than one never made: the button is gone and a
  // standing badge takes its place, driven by what the server reports, not client memory.
  await expect(decidedRow.getByText('Unsuppressed')).toBeVisible();
  await expect(decidedRow.getByRole('button', { name: /unsuppress/i })).toHaveCount(0);
  await page.reload();
  await expect(decidedRow.getByText('Unsuppressed')).toBeVisible();
});

test('discovery: follow a suggested company and see its job board detected', async ({ page }) => {
  const email = await registerUser(page);

  // The weekly company.suggest job, run now for this user (the AI mock proposes Pied Piper).
  const res = await page.request.post('/__mock/discovery/suggest-companies', { data: { email } });
  expect(res.ok(), await res.text()).toBe(true);

  await page.goto('/discovery/companies');
  const suggestion = page
    .getByRole('list', { name: 'Suggested companies' })
    .getByRole('listitem', { name: 'Pied Piper' });
  await expect(suggestion).toContainText('Builds developer platforms');
  await suggestion.getByRole('button', { name: 'Follow Pied Piper' }).click();
  await expect(suggestion).toBeHidden();

  // Following queues board detection; the fixture Greenhouse board answers the probe.
  const followed = page
    .getByRole('list', { name: 'Followed companies' })
    .getByRole('listitem', { name: 'Pied Piper' });
  await eventually(page, async () => {
    await expect(followed).toContainText('Greenhouse: piedpiper', { timeout: 1000 });
  });

  // The detected board is now a discovery source.
  await page.goto('/discovery/sources');
  await expect(page.getByRole('table', { name: 'Discovery sources' })).toContainText('piedpiper');
});

test('discovery: manual capture refuses a LinkedIn link with the paste-the-text path', async ({
  page,
}) => {
  await registerUser(page);
  await page.goto('/discovery');
  await page.getByRole('button', { name: 'Capture posting' }).click();
  const dialog = page.getByRole('dialog', { name: 'Capture posting' });
  await dialog.getByLabel('Posting link').fill('https://www.linkedin.com/jobs/view/3912345678/');
  await dialog.getByRole('button', { name: 'Capture' }).click();
  // The server refuses the host without fetching it and names the compliant path.
  await expect(dialog.getByRole('alert')).toContainText('paste the description text instead');
  await dialog.getByRole('button', { name: 'Paste the text instead' }).click();
  await expect(dialog.getByLabel('Posting description')).toBeVisible();
  // The AI mock extracts nothing from pasted text, so the server asks for manual entry.
  await dialog.getByLabel('Posting description').fill('Staff Engineer at Vandelay Industries');
  await dialog.getByRole('button', { name: 'Capture' }).click();
  await expect(dialog.getByRole('alert')).toContainText('New Opportunity');
});
