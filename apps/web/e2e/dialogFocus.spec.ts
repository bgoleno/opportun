// Dialogs their parent takes out of the page as they close: the focus goes back to the button that
// opened them, as it does for a dialog that stays (https://github.com/bgoleno/opportun/issues/975).
// Whichever way it is left: the browser closes none of them itself.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { registerBaseResume, registerUser } from './helpers';

const WAYS = ['Escape', 'Close', 'Cancel'] as const;
type Way = (typeof WAYS)[number];
type Closed = { closedDialogs: HTMLDialogElement[] };

async function leave(page: Page, dialog: Locator, way: Way) {
  if (way === 'Escape') await page.keyboard.press('Escape');
  else await dialog.getByRole('button', { name: way, exact: true }).click();
}

/** Opened and left by `way`: the focus is on the opener, and a press made at once opens it again. */
async function leftAndPressed(page: Page, opener: Locator, dialog: Locator, way: Way) {
  await page.evaluate(() => {
    const w = window as unknown as Closed;
    w.closedDialogs = [];
    const proto = HTMLDialogElement.prototype;
    const close = proto.close;
    proto.close = function (this: HTMLDialogElement, ...args) {
      w.closedDialogs.push(this);
      close.apply(this, args);
    };
  });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await leave(page, dialog, way);
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  // Left and pressed with nothing waited for in between.
  await leave(page, dialog, way);
  await page.keyboard.press('Enter');
  // The close event of the one that went, as late as it can be, closes nothing.
  await page.evaluate(() => {
    for (const el of (window as unknown as Closed).closedDialogs) {
      if (!el.isConnected) el.dispatchEvent(new Event('close'));
    }
  });
  await page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))),
  );
  expect(await dialog.isVisible()).toBe(true);
}

for (const way of WAYS) {
  test(`Capture posting left by ${way} gives the focus back, and a press at once stays open`, async ({
    page,
  }) => {
    await registerUser(page);
    await page.goto('/discovery');
    const opener = page.getByRole('button', { name: 'Capture posting' });
    const dialog = page.getByRole('dialog', { name: 'Capture posting' });
    await leftAndPressed(page, opener, dialog, way);
  });

  test(`a resume's Delete left by ${way} gives the focus back, and a press at once stays open`, async ({
    page,
  }) => {
    await registerUser(page);
    await registerBaseResume(page, 'e2eBaseResumeDoc01');
    const opener = page.getByRole('button', { name: /^Delete / });
    const dialog = page.getByRole('dialog', { name: 'Delete this resume?' });
    await leftAndPressed(page, opener, dialog, way);
  });
}
