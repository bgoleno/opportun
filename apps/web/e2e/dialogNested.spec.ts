// A dialog drawn inside another one (https://github.com/bgoleno/opportun/issues/1007): closing the
// inner one leaves the outer one open, and closing the outer one closes what is inside it. React
// passes an inner dialog's `close` up to the outer one, which the DOM does not, and only a browser
// closes a dialog by itself: no screen nests two, so this page is built here, from
// src/test/nestedDialogs.tsx and the app's own dialog.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
let script = '';

test.beforeAll(async () => {
  const built = await build({
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    resolve: { alias: { '@': at('../src') } },
    build: { write: false, rolldownOptions: { input: at('../src/test/nestedDialogs.tsx') } },
  });
  if (!('output' in built)) throw new Error('not one build');
  script = built.output[0].code;
});

const opener = (page: Page) => page.getByRole('button', { name: 'Open the outer' });
const innerOpener = (page: Page) => page.getByRole('button', { name: 'Open the inner' });
const outer = (page: Page) => page.getByRole('dialog', { name: 'Outer' });
const inner = (page: Page) => page.getByRole('dialog', { name: 'Inner' });

/** The close event comes with the next frame, and what it asks for is drawn in the one after. */
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))),
  );

/** The outer dialog open with something typed in it, and the inner one open in it, by the keyboard. */
async function openBoth(page: Page, query: string) {
  await page.route('**/nested-dialogs.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: script }),
  );
  await page.route('**/nested-dialogs?*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Nested</title><div id="root"></div><script type="module" src="/nested-dialogs.js"></script>',
    }),
  );
  await page.goto(`/nested-dialogs?${query}`);
  await opener(page).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Pasted').fill('a long paste');
  await innerOpener(page).focus();
  await page.keyboard.press('Enter');
  await expect(inner(page)).toBeVisible();
}

const WAYS = ['Escape', 'Close', 'the backdrop'] as const;

async function leaveInner(page: Page, way: (typeof WAYS)[number]) {
  if (way === 'Escape') return await page.keyboard.press('Escape');
  if (way === 'Close')
    return await inner(page).getByRole('button', { name: 'Close', exact: true }).click();
  await page.mouse.click(5, 5);
}

for (const [what, query] of [
  ['neither guarded', ''],
  ['the outer guarded', 'outer'],
  ['both guarded', 'outer&inner'],
] as const) {
  for (const way of WAYS) {
    test(`the inner dialog left by ${way}: the outer stays with its input, ${what}`, async ({
      page,
    }) => {
      await openBoth(page, query);
      await leaveInner(page, way);
      await expect(inner(page)).toBeHidden();
      await frames(page);
      await expect(outer(page)).toBeVisible();
      await expect(page.getByLabel('Pasted')).toHaveValue('a long paste');
      await expect(innerOpener(page)).toBeFocused();
      // And the next Escape is the outer one's.
      await page.keyboard.press('Escape');
      await expect(outer(page)).toBeHidden();
      await expect(opener(page)).toBeFocused();
    });
  }

  test(`the inner dialog closed and opened again before its close event: both stay, ${what}`, async ({
    page,
  }) => {
    await openBoth(page, query);
    // In one task, so the close event comes after both: React's answer to a click is a microtask.
    await page.evaluate(async () => {
      const click = async (name: string, scope: ParentNode) => {
        [...scope.querySelectorAll('button')]
          .find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name)!
          .click();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };
      const [outside, inside] = [...document.querySelectorAll('dialog')] as [
        HTMLDialogElement,
        HTMLDialogElement,
      ];
      const late = { closes: 0 };
      Object.assign(window, { late });
      inside.addEventListener('close', () => (late.closes += 1));
      await click('Close', inside);
      if (inside.open) throw new Error('the inner dialog did not close at once');
      await click('Open the inner', outside);
      if (!inside.open || late.closes > 0) throw new Error('not before its close event');
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { late: { closes: number } }).late.closes),
      )
      .toBe(1);
    await frames(page);
    await expect(inner(page)).toBeVisible();
    await expect(outer(page)).toBeVisible();
    await expect(page.getByLabel('Pasted')).toHaveValue('a long paste');
  });

  for (const how of ['Close the outer', 'Take the outer out'] as const) {
    test(`${how}, with the inner one open: both go, the focus goes back and the page can be used, ${what}`, async ({
      page,
    }) => {
      await openBoth(page, query);
      const seen = () =>
        page.evaluate(
          () => (window as unknown as { seen: { asked: string[]; shown: number } }).seen,
        );
      expect(await seen()).toEqual({ asked: [], shown: 2 });
      await page.getByRole('button', { name: how }).focus();
      await page.keyboard.press('Enter');
      await expect(outer(page)).toBeHidden();
      await expect(inner(page)).toBeHidden();
      await frames(page);
      expect(await page.locator('dialog[open]').count()).toBe(0);
      // Not shown again, and no owner asked: at most the outer one's, once, that it has closed.
      const { asked, shown } = await seen();
      expect(shown).toBe(2);
      expect(['', 'outer']).toContain(asked.join(', '));
      await expect(opener(page)).toBeFocused();
      await opener(page).click();
      await expect(outer(page)).toBeVisible();
      await expect(inner(page)).toBeHidden();
    });
  }
}
