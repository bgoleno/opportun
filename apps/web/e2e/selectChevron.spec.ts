// Every Select draws its chevron inside its own box (https://github.com/bgoleno/opportun/issues/909),
// at a narrow, a laptop and a wide width. The chevron is placed against the Select's wrapper, so a
// Select narrower than its wrapper drew it outside itself. Measured on the Selects with a width of
// their own (the Inbox's), and on every Select of the views that need no data.
import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, registerUser } from './helpers';
import { USER_ROUTES } from './routes';

interface Measured {
  name: string;
  width: number;
  box: string;
  chevron: string;
  inside: boolean;
}

/** Every Select on the page that is drawn, with its chevron's place. */
async function selects(page: Page): Promise<Measured[]> {
  return await page.evaluate(() => {
    const edges = (r: DOMRect) => `x ${r.left} to ${r.right}, y ${r.top} to ${r.bottom}`;
    return [...document.querySelectorAll<HTMLSelectElement>('[data-slot="select"]')]
      .filter((s) => s.getClientRects().length > 0)
      .map((s) => {
        const box = s.getBoundingClientRect();
        const icon = s.parentElement!.querySelector('svg')!.getBoundingClientRect();
        return {
          name: s.getAttribute('aria-label') ?? s.labels[0]?.textContent ?? s.id,
          width: box.width,
          box: edges(box),
          chevron: edges(icon),
          // Drawn, and all of it in the Select's box, on both axes.
          inside:
            icon.width > 0 &&
            icon.left >= box.left &&
            icon.right <= box.right &&
            icon.top >= box.top &&
            icon.bottom <= box.bottom,
        };
      });
  });
}

const outside = (where: string, all: Measured[]) =>
  all
    .filter((s) => !s.inside)
    .map((s) => `${where}, ${s.name}: box ${s.box}; chevron ${s.chevron}`);

/** One message in Needs review, or the Inbox's bulk bar and Reject dialog have nothing to act on. */
async function seedMessage(page: Page, tag: string): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Select chevron e2e');
  await dialog.getByRole('checkbox', { name: /^Apple Mail connector/ }).setChecked(true);
  await dialog.getByRole('checkbox', { name: /^Browser capture/ }).setChecked(false);
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  await shown.getByRole('button', { name: 'I saved it' }).click();
  const subject = `Interview availability ${tag}`;
  const res = await page.request.post('/api/v1/connector/mail/batch', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      messages: [
        {
          externalId: `chevron-${tag}`,
          threadKey: `chevron-${tag}`,
          from: `Recruiter ${tag} <recruiter.${tag}@contoso.example>`,
          to: ['me@example.com'],
          subject,
          snippet: 'Snippet',
          bodyText: 'Could we find a time to talk?',
          sentAt: Date.now() - 60_000,
        },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return subject;
}

for (const width of [375, 1280, 1920]) {
  test(`a Select with its own width holds its chevron, at ${width} px (#909)`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await registerUser(page);
    const subject = await seedMessage(page, `c${width}`);
    await page.setViewportSize({ width, height: 900 });
    const row = page.getByRole('listitem', { name: subject, exact: true });
    await expect(async () => {
      await page.goto('/inbox');
      await expect(row).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await row.getByRole('checkbox').check();
    await expect(page.getByLabel('Rejection reason')).toBeVisible();
    const bar = await selects(page);

    await row.getByRole('button', { name: 'Reject', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reject this message' });
    await dialog.getByLabel('Never fetch mail from this sender again').check();
    await expect(dialog.getByLabel('Block', { exact: true })).toBeVisible();
    const inDialog = (await selects(page)).filter((s) => s.name === 'Block');

    const found = [...bar, ...inDialog];
    expect(outside('Inbox', found), JSON.stringify(found, null, 1)).toEqual([]);
    // The Selects are the width they were given, or the check would say nothing of a set width.
    const widthOf = (name: string) => Math.round(found.find((s) => s.name === name)!.width);
    if (width >= 640) expect(widthOf('Source')).toBe(160);
    expect(widthOf('Rejection reason')).toBe(192);
    if (width >= 640) expect(widthOf('Block')).toBe(256);
  });

  test(`every Select of the views that need no data holds its chevron, at ${width} px (#909)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await registerUser(page);
    const problems: string[] = [];
    let measured = 0;
    for (const path of USER_ROUTES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const all = await selects(page);
      measured += all.length;
      problems.push(...outside(path, all));
    }
    expect(problems, problems.join('\n')).toEqual([]);
    expect(measured).toBeGreaterThan(5);
  });
}
