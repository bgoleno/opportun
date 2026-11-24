// A job alert for a role that is already in the pipeline, end to end
// (https://github.com/bgoleno/opportun/issues/971): no card, one timeline entry, and the linked
// posting under Decided with the way to its opportunity. The digest is made up.
import { expect, test, type Page } from '@playwright/test';
import { createOpportunity, PASSWORD, registerUser, stubOtherHosts } from './helpers';

const COMPANY = 'Initech';
const ROLE = 'Platform Engineer';
const OTHER = 'Principal Platform Engineer';

/** A device token that may push mail, made through Settings. */
async function createToken(page: Page): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Laptop');
  await dialog.getByRole('checkbox', { name: /^Apple Mail connector/ }).setChecked(true);
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  await shown.getByRole('button', { name: 'I saved it' }).click();
  return token;
}

/** A LinkedIn job alert: the tracked role at another place, and another level of it. */
function alertEmail() {
  const job = (title: string, id: string) =>
    [
      title,
      COMPANY,
      'Boston, MA',
      `View job: https://www.linkedin.com/comm/jobs/view/${id}/?trackingId=x`,
      '---------------------------------------------------------',
    ].join('\n');
  return {
    externalId: `alert-${Date.now()}`,
    threadKey: `alert-${Date.now()}`,
    from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    to: ['me@example.com'],
    subject: 'Your job alert for platform',
    snippet: 'New jobs match your preferences.',
    bodyText: `Your job alert for platform in Boston\n\n${job(ROLE, '3900000001')}\n\n${job(OTHER, '3900000002')}\n`,
    sentAt: Date.now() - 60_000,
  };
}

for (const width of [375, 1280]) {
  test(`discovery at ${width}: an alert for a role in the pipeline is linked to it, not a card`, async ({
    page,
    playwright,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await stubOtherHosts(page.context());
    await registerUser(page);
    const token = await createToken(page);
    await createOpportunity(page, { company: COMPANY, title: ROLE });
    const listed = await page.request.get('/api/v1/opportunities?limit=50');
    const [tracked] = ((await listed.json()) as { items: { id: string }[] }).items;

    const device = await playwright.request.newContext({ baseURL });
    try {
      const pushed = await device.post('/api/v1/connector/mail/batch', {
        headers: { authorization: `Bearer ${token}` },
        data: { messages: [alertEmail()] },
      });
      expect(pushed.status(), await pushed.text()).toBe(200);
    } finally {
      await device.dispose();
    }

    // The other level is a card, so the digest has been read.
    await page.goto('/discovery');
    await expect(async () => {
      await page.reload();
      await expect(page.getByText('1 result to review.')).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole('listitem', { name: `${OTHER} at ${COMPANY}` })).toBeVisible();
    await expect(
      page.getByRole('listitem', { name: `${ROLE} at ${COMPANY}`, exact: true }),
    ).toHaveCount(0);

    await page.goto('/discovery/decided');
    await page.getByRole('tab', { name: /^Accepted/ }).click();
    const row = page.getByRole('listitem', { name: `${ROLE} at ${COMPANY}`, exact: true });
    await expect(row).toContainText('Linked to an opportunity already there');
    await row.getByRole('link', { name: 'View opportunity' }).click();
    await expect(page).toHaveURL(new RegExp(`/opportunities/${tracked!.id}`));
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await expect(page.getByText(/^Also posted via/)).toHaveCount(1);
    await expect(page.getByText('Boston, MA')).toBeVisible();

    const after = await page.request.get('/api/v1/opportunities?limit=50');
    expect(((await after.json()) as { total: number }).total).toBe(1);
  });
}
