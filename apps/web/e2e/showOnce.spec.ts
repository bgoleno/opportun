// Dialogs that show something once: two-factor recovery codes and a new device token
// (https://github.com/bgoleno/opportun/issues/898). A real browser closes a modal <dialog> on
// Escape by itself, which jsdom does not, so this is where that is checked. Escape is pressed twice
// each time: a browser lets the page refuse the first only (with no click or typing in between, the
// second closes the dialog without asking), and the app then has to show it again.
import { expect, test } from '@playwright/test';
import { totpCode } from '../../server/src/lib/totp';
import { PASSWORD, pressEscapeTwice, registerUser } from './helpers';

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

test('extension setup: Escape asks first, on top of the setup, and staying keeps the token', async ({
  page,
}) => {
  // Whether the extension has been built here does not matter: the setup only needs a download.
  await page.route('**/api/v1/artifacts/extension', (route) =>
    route.fulfill({
      json: {
        baseUrl: 'http://127.0.0.1',
        buildCommand: 'pnpm build',
        targets: [
          {
            id: 'chrome',
            label: 'Chrome, Edge, Brave',
            filename: 'opportun-chrome.zip',
            available: true,
            buildStamp: null,
          },
        ],
      },
    }),
  );
  await registerUser(page);
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Set up the browser extension' });
  await setup.getByLabel('Password').fill(PASSWORD);
  await setup.getByRole('button', { name: 'Continue' }).click();
  const token = setup.getByText(/^odt_/);
  await expect(token).toBeVisible();

  const question = page.getByRole('dialog', { name: 'Close before the extension has checked in?' });
  await page.keyboard.press('Escape');
  await expect(question).toBeVisible();
  // Escape on the question leaves it, as on any other dialog.
  await page.keyboard.press('Escape');
  // Out of the page, not only hidden: the browser hides it before the app hears that it closed, and
  // an Escape in between would ask a question the app still counts as asked.
  await expect(page.getByText('Close before the extension has checked in?')).toHaveCount(0);
  await expect(token).toBeVisible();
  // Asked again, on top of the setup: the question's button can be clicked.
  await page.keyboard.press('Escape');
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toBeHidden();
  await expect(token).toBeVisible();
  // And leaving for real still works.
  await setup.getByRole('button', { name: 'Close setup' }).click();
  await question.getByRole('button', { name: 'Close anyway' }).click();
  await expect(setup).toBeHidden();
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
