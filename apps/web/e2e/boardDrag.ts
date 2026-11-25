// What the board's drag specs share (boardKeyboard, boardPointer).
import type { Page } from '@playwright/test';

/** dnd-kit's live region, which says what a drag is over. */
const LIVE_REGION = '[id^="DndLiveRegion-"]';

/**
 * Waits until the live region says `text` (or, with `not`, anything else), looking at every frame, and
 * says whether it came. A test says what it wants with an `expect` of its own after it, which then has
 * nothing to wait for: an `expect` looks every 100 ms and more, and a board drag is a few hundred looks
 * (https://github.com/bgoleno/opportun/issues/966).
 */
export async function announced(
  page: Page,
  text: string,
  { not = false, timeout = 15_000 }: { not?: boolean; timeout?: number } = {},
): Promise<boolean> {
  return await page
    .waitForFunction(
      ([selector, wanted, other]) =>
        (document.querySelector(selector)?.textContent === wanted) !== other,
      [LIVE_REGION, text, not] as const,
      { polling: 'raf', timeout },
    )
    .then(
      () => true,
      () => false,
    );
}

/** Waits, frame by frame, until a dialog is open, or none is. */
export async function dialogIs(page: Page, open: boolean): Promise<void> {
  await page
    .waitForFunction(
      (wanted) => (document.querySelector('dialog[open]') !== null) === wanted,
      open,
      {
        polling: 'raf',
      },
    )
    .catch(() => undefined);
}

/** Two frames: what was just done is drawn, and React has answered to it. */
export const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))),
  );

/**
 * Takes the way to a new place out of the dragged card: dnd-kit moves the card that follows a keyboard
 * drag over 250 ms, and a walk is hundreds of steps. Where it comes to rest is the same.
 */
export async function withoutGlide(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(':has(> .cursor-grabbing.shadow-lg) { transition: none !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}
