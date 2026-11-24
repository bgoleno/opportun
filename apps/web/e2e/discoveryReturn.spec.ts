// The review queue and a capture of one of its cards, end to end
// (https://github.com/bgoleno/opportun/issues/968): a LinkedIn alert email's cards, the posting
// captured as the extension posts it, and the open Discovery page the user comes back to. The
// digest and the captured page are made up, and nothing is fetched from LinkedIn.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PASSWORD, registerUser, stubOtherHosts, toasts } from './helpers';

const CARDS = 14;
const jobId = (n: number) => String(3_900_000_000 + n);
const role = (n: number) => `Platform Role ${'ABCDEFGHIJKLMNOP'.charAt(n)}`;
const label = (n: number) => `${role(n)} at Initech`;
const row = (page: Page, n: number) => page.getByRole('listitem', { name: label(n), exact: true });

/** A device token that may push mail and captures, made through Settings. */
async function createToken(page: Page): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Laptop');
  await dialog.getByRole('checkbox', { name: /^Apple Mail connector/ }).setChecked(true);
  await dialog.getByRole('checkbox', { name: /^Browser capture/ }).setChecked(true);
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  await shown.getByRole('button', { name: 'I saved it' }).click();
  return token;
}

/** A LinkedIn job alert, as it arrives: a title, a company, a location and a link for each job. */
function alertEmail() {
  const jobs = Array.from({ length: CARDS }, (_, n) =>
    [
      role(n),
      'Initech',
      'Austin, TX',
      `View job: https://www.linkedin.com/comm/jobs/view/${jobId(n)}/?trackingId=x`,
      '---------------------------------------------------------',
    ].join('\n'),
  );
  return {
    externalId: `alert-${Date.now()}`,
    threadKey: `alert-${Date.now()}`,
    from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    to: ['me@example.com'],
    subject: 'Your job alert for platform',
    snippet: 'New jobs match your preferences.',
    bodyText: `Your job alert for platform in Austin\n\n${jobs.join('\n\n')}\n`,
    sentAt: Date.now() - 60_000,
  };
}

/** What the extension posts for the card's own LinkedIn page. */
async function capture(request: APIRequestContext, token: string, n: number): Promise<string> {
  const res = await request.post('/api/v1/connector/capture', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      url: `https://www.linkedin.com/jobs/view/${jobId(n)}/`,
      title: `${role(n)} | Initech | LinkedIn`,
      text: `0 notifications total\nSkip to main content\nHome\nMy Network\nJobs\nMessaging\n\nInitech\n${role(n)}\nAustin, TX · 2 days ago\nFull-time\nEasy Apply\nSave\n\nAbout the job\nInitech needs a ${role(n)} to run the payments platform.\n\nResponsibilities\n- Own it end to end\n\nAbout the company\nInitech\n`,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { opportunityId: string }).opportunityId;
}

/** Back on the page from another window. Playwright's pages never lose the focus, so it is told. */
async function comeBack(page: Page): Promise<void> {
  // The list, not the question asked before it.
  const read = page.waitForResponse((r) =>
    r.url().includes('/discovery/results?disposition=pending'),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await read;
}

for (const width of [375, 768, 1280]) {
  test(`discovery at ${width}: a captured card leaves the open queue, and the page keeps its place`, async ({
    page,
    playwright,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await stubOtherHosts(page.context());
    await registerUser(page);
    const token = await createToken(page);
    const device = await playwright.request.newContext({ baseURL });
    try {
      const pushed = await device.post('/api/v1/connector/mail/batch', {
        headers: { authorization: `Bearer ${token}` },
        data: { messages: [alertEmail()] },
      });
      expect(pushed.status(), await pushed.text()).toBe(200);

      await page.goto('/discovery');
      await expect(async () => {
        await page.reload();
        await expect(page.getByText(`${CARDS} results to review.`)).toBeVisible({ timeout: 1000 });
        // Every card ranked: a score that arrives later moves its card, whatever else happens.
        await expect(page.getByLabel(/^AI score/)).toHaveCount(CARDS, { timeout: 1000 });
      }).toPass({ timeout: 30_000 });
      const names = await page
        .getByRole('list', { name: 'Results to review' })
        .getByRole('listitem')
        .evaluateAll((all) => all.map((n) => n.getAttribute('aria-label')));
      const order = names.map((name) =>
        Array.from({ length: CARDS }, (_, n) => n).findIndex((n) => label(n) === name),
      );
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: CARDS }, (_, n) => n));
      const at = (place: number) => order.at(place) as number;

      let left = CARDS;
      const count = () => expect(page.getByText(`${left} results to review.`)).toBeVisible();
      const gone = async (n: number, opts: { timeout?: number } = {}) => {
        await expect(row(page, n)).toHaveCount(0, opts);
        left -= 1;
        await count();
      };

      // The page has not been told: Accept on a captured card says where it is, and asks nothing.
      const opportunityId = await capture(device, token, at(0));
      await row(page, at(0))
        .getByRole('button', { name: `Accept ${label(at(0))}` })
        .click();
      await expect(toasts(page).getByText('Already in your pipeline')).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await gone(at(0));
      const all = await page.request.get('/api/v1/opportunities?limit=50');
      expect(((await all.json()) as { total: number }).total).toBe(1);

      // Nor Dismiss on another.
      await capture(device, token, at(5));
      await row(page, at(5))
        .getByRole('button', { name: `Dismiss ${label(at(5))}` })
        .click();
      const dismiss = page.getByRole('dialog', { name: 'Dismiss result' });
      await dismiss.getByLabel('Reason').selectOption({ label: 'Stale' });
      await dismiss.getByRole('button', { name: 'Dismiss' }).click();
      await expect(toasts(page).getByText('Not dismissed: already in your pipeline')).toBeVisible();
      await gone(at(5));

      // Its link: the opportunity, at Interested with the captured description.
      await toasts(page).getByRole('button', { name: 'View opportunity' }).first().click();
      await expect(page).toHaveURL(`/opportunities/${opportunityId}`);
      await expect(page.getByText('to run the payments platform').first()).toBeVisible();
      await page.goBack();
      await count();

      // A posting opened beside the page, which is never left: its card leaves by itself.
      const popup = page.waitForEvent('popup');
      await row(page, at(1))
        .getByRole('link', { name: `Open posting for ${label(at(1))}` })
        .click();
      await (await popup).close();
      await capture(device, token, at(1));
      await gone(at(1), { timeout: 6000 });

      // Down the list: one card selected, two checked, and the page scrolled to them.
      await row(page, at(9)).getByRole('checkbox').click();
      await row(page, at(10)).getByRole('checkbox').click();
      await row(page, at(8)).focus();
      await row(page, at(9)).evaluate((n) => n.scrollIntoView({ block: 'center' }));
      const before = await row(page, at(9)).boundingBox();

      // Captured from far above the window: the card is gone and what is on screen has not moved.
      await capture(device, token, at(2));
      await comeBack(page);
      await gone(at(2));
      const after = await row(page, at(9)).boundingBox();
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
      await expect(row(page, at(8))).toHaveAttribute('aria-current', 'true');
      await expect(page.getByText('2 selected')).toBeVisible();

      // Back before the capture is made: the selected card leaves by itself, the next one takes its
      // place and the keyboard, and the checked ones stay checked.
      await capture(device, token, at(8));
      await gone(at(8), { timeout: 6000 });
      await expect(row(page, at(9))).toHaveAttribute('aria-current', 'true');
      await expect(row(page, at(9))).toBeFocused();
      await expect(page.getByText('2 selected')).toBeVisible();

      // A checked card captured: it alone is unchecked.
      await capture(device, token, at(10));
      await gone(at(10), { timeout: 6000 });
      await expect(page.getByText('1 selected')).toBeVisible();
      await expect(row(page, at(9)).getByRole('checkbox')).toBeChecked();
    } finally {
      await device.dispose();
    }
  });
}
