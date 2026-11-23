// Dialogs that show something once: two-factor recovery codes and a new device token
// (https://github.com/bgoleno/opportun/issues/898). A real browser closes a modal <dialog> on
// Escape by itself, which jsdom does not, so this is where that is checked. Escape is pressed twice
// each time: a browser lets the page refuse the first only (with no click or typing in between, the
// second closes the dialog without asking), and the app then has to show it again.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { totpCode } from '../../server/src/lib/totp';
import { PASSWORD, registerUser } from './helpers';

async function pressEscapeTwice(page: Page, dialog: Locator): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape');
    // Time for the browser's own close to land, then shown: not merely not closed yet.
    await page.waitForTimeout(300);
    await expect(dialog).toBeVisible();
  }
}

test('recovery codes: Escape loses them neither while activating nor once shown', async ({
  page,
}) => {
  await registerUser(page);
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Enable two-factor' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm your password' });
  await confirm.getByLabel('Current password').fill(PASSWORD);
  await confirm.getByRole('button', { name: 'Continue' }).click();

  const setup = page.getByRole('dialog', { name: 'Set up two-factor sign-in' });
  const secret = await setup.getByLabel('Setup key', { exact: true }).inputValue();
  // Activation is held on its way to the server, so Escape is pressed while it is in flight.
  let letGo!: () => void;
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  await page.route('**/api/v1/auth/2fa/activate', async (route) => {
    await held;
    await route.continue();
  });
  await setup.getByLabel('Code from the app').fill(totpCode(secret, Date.now()));
  await setup.getByRole('button', { name: 'Turn on' }).click();
  await expect(setup.getByRole('button', { name: 'Turning on...' })).toBeVisible();
  await pressEscapeTwice(page, setup);
  letGo();

  const shown = page.getByRole('dialog', { name: 'Save your recovery codes' });
  await expect(shown.getByRole('listitem')).toHaveCount(10);
  // The card behind the dialog already says so.
  await expect(page.getByText('10 recovery codes left.', { exact: false })).toBeVisible();
  await pressEscapeTwice(page, shown);
  await expect(shown.getByRole('listitem')).toHaveCount(10);

  await shown.getByRole('button', { name: 'I saved them' }).click();
  await expect(shown).toBeHidden();
  await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
});

test('device tokens: Escape does not lose one, and the next one shows as well', async ({
  page,
}) => {
  await registerUser(page);
  await page.goto('/settings/integrations');
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  for (const name of ['Work MacBook', 'Home MacBook']) {
    await page.getByRole('button', { name: 'Create token' }).click();
    const create = page.getByRole('dialog', { name: 'Create a device token' });
    await create.getByLabel('Name').fill(name);
    await create.getByLabel('Current password').fill(PASSWORD);
    await create.getByRole('button', { name: 'Create' }).click();
    await expect(shown.getByLabel('Device token')).toHaveValue(/^odt_/);
    await pressEscapeTwice(page, shown);
    await expect(shown.getByLabel('Device token')).toHaveValue(/^odt_/);
    await shown.getByRole('button', { name: 'I saved it' }).click();
    await expect(shown).toBeHidden();
  }
  await expect(page.getByRole('list', { name: 'Device tokens' })).toContainText('Home MacBook');
});

test('another dialog still closes on Escape', async ({ page }) => {
  await registerUser(page);
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const create = page.getByRole('dialog', { name: 'Create a device token' });
  await expect(create).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(create).toBeHidden();
  // Closed for the page as well as in the browser: it opens again.
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(create).toBeVisible();
});
