// The pipeline board's keyboard drag (#413): a move the stage rules refuse says so, on screen and
// to a screen reader, as a pointer drag does, and never announces that the card "was dropped on"
// the column. Driven through the real keyboard path (focus the card, Space to pick up, arrows,
// Space to drop) in a real browser, because the component tests mock the drag library.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { card, choose, createOpportunity, registerUser, toasts } from './helpers';

/** dnd-kit's live region: what a screen reader hears during a drag (assertive). */
const liveRegion = (page: Page) => page.locator('[id^="DndLiveRegion-"]');
/** The board's own polite region (#432): how the reason dialog ended for a dragged card. */
const boardRegion = (page: Page) => page.getByTestId('board-announcement');
const column = (page: Page, name: string) => page.getByRole('region', { name: `${name} column` });

async function moveWithMenu(page: Page, opp: { company: string; title: string }, stage: string) {
  await page.getByRole('button', { name: `Move ${opp.company}: ${opp.title}` }).click();
  await page.getByRole('menuitem', { name: stage, exact: true }).click();
}

/** A dismissed opportunity, with the Dismissed column expanded so its card can be dragged. */
async function dismissed(page: Page, opp: { company: string; title: string }) {
  await createOpportunity(page, opp);
  await moveWithMenu(page, opp, 'Dismissed');
  const dialog = page.getByRole('dialog', { name: 'Dismiss opportunity' });
  await choose(dialog, 'Reason', 'Other');
  await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: /^Expand Dismissed/ }).click();
  await expect(card(page, opp.company, opp.title)).toBeVisible();
}

/**
 * Picks `moved` up with Space, then presses the arrow key one at a time (ArrowLeft unless told),
 * each time letting the live region announce the new place, until it is over `target`'s column;
 * then drops.
 */
async function keyboardDrop(
  page: Page,
  moved: Locator,
  target: string,
  arrow: 'ArrowLeft' | 'ArrowRight' = 'ArrowLeft',
) {
  await moved.focus();
  await page.keyboard.press('Space');
  await expect(liveRegion(page)).toContainText('is over');
  const wanted = `is over the ${target} column`;
  for (let i = 0; i < 12; i++) {
    const before = (await liveRegion(page).textContent()) ?? '';
    if (before.includes(wanted)) break;
    await page.keyboard.press(arrow);
    // The first step may only go from the card to its own column, which is announced the same
    // way, so the text need not change: wait for a change, briefly, and go on either way.
    await expect(liveRegion(page))
      .not.toHaveText(before, { timeout: 1_000 })
      .catch(() => undefined);
  }
  await expect(liveRegion(page)).toContainText(wanted);
  await page.keyboard.press('Space');
}

test.describe('the board refuses a keyboard move as it refuses a pointer move (#413)', () => {
  // Every column on screen, as qa had it on #410: the keyboard sensor picks the nearest target
  // by position, so columns scrolled out of a narrow window make its steps uneven.
  test.use({ viewport: { width: 2200, height: 1100 } });

  test('onto an empty column: the message, the reason announced, focus kept', async ({ page }) => {
    await registerUser(page);
    const opp = { company: 'Initrode', title: 'Staff Keyboard Engineer' };
    await dismissed(page, opp);
    const moved = card(page, opp.company, opp.title);

    await keyboardDrop(page, moved, 'Offer');

    const reason = 'Use Reopen to move a dismissed opportunity back to Offer.';
    await expect(toasts(page).getByText(reason)).toBeVisible();
    await expect(liveRegion(page)).toHaveText(
      `${opp.company}: ${opp.title} was not moved. ${reason}`,
    );
    await expect(moved).toBeFocused();
    await expect(column(page, 'Dismissed').getByRole('article')).toHaveCount(1);
  });

  test('onto a card in a column that holds cards (qa on #410)', async ({ page }) => {
    await registerUser(page);
    for (const title of ['First Offer Engineer', 'Second Offer Engineer']) {
      await createOpportunity(page, { company: 'Globex', title });
      await moveWithMenu(page, { company: 'Globex', title }, 'Offer');
      await expect(
        column(page, 'Offer').getByRole('article', { name: `Globex: ${title}` }),
      ).toBeVisible();
    }
    const opp = { company: 'Initrode', title: 'Staff Keyboard Engineer' };
    await dismissed(page, opp);
    const moved = card(page, opp.company, opp.title);

    await keyboardDrop(page, moved, 'Offer');

    const reason = 'Use Reopen to move a dismissed opportunity back to Offer.';
    await expect(toasts(page).getByText(reason)).toBeVisible();
    await expect(liveRegion(page)).toHaveText(
      `${opp.company}: ${opp.title} was not moved. ${reason}`,
    );
    await expect(liveRegion(page)).not.toContainText('was dropped on');
    await expect(moved).toBeFocused();
  });

  test('an allowed keyboard move is unchanged: it moves and says where', async ({ page }) => {
    await registerUser(page);
    const opp = { company: 'Initrode', title: 'Staff Keyboard Engineer' };
    await createOpportunity(page, opp);
    await moveWithMenu(page, opp, 'Interested');
    const moved = card(page, opp.company, opp.title);
    await expect(column(page, 'Interested').getByRole('article')).toHaveCount(1);

    await keyboardDrop(page, moved, 'New');

    await expect(liveRegion(page)).toHaveText(
      `${opp.company}: ${opp.title} was dropped on the New column.`,
    );
    await expect(
      column(page, 'New').getByRole('article', { name: `${opp.company}: ${opp.title}` }),
    ).toBeVisible();
    await expect(toasts(page).getByText('Stage not changed')).toHaveCount(0);
  });
});

// #432: Closed and Dismissed ask for a reason first, so the drop says the card is waiting for one,
// and the board says afterwards whether it moved.
test.describe('a keyboard drop that waits for a reason says so, then says what happened (#432)', () => {
  test.use({ viewport: { width: 2200, height: 1100 } });

  /** An opportunity in Offer, the column next to Dismissed and Closed. */
  async function inOffer(page: Page, opp: { company: string; title: string }) {
    await createOpportunity(page, opp);
    await moveWithMenu(page, opp, 'Offer');
    await expect(
      column(page, 'Offer').getByRole('article', { name: `${opp.company}: ${opp.title}` }),
    ).toBeVisible();
  }

  test('onto Closed, confirmed: waiting, then moved, and the card is in Closed', async ({
    page,
  }) => {
    await registerUser(page);
    const opp = { company: 'Initrode', title: 'Staff Keyboard Engineer' };
    await inOffer(page, opp);
    const name = `${opp.company}: ${opp.title}`;

    await keyboardDrop(page, card(page, opp.company, opp.title), 'Closed', 'ArrowRight');

    await expect(liveRegion(page)).toHaveText(
      `${name} is waiting for a reason to move to the Closed column. Choose one in the dialog, or cancel to leave it where it is.`,
    );
    await expect(liveRegion(page)).not.toContainText('was dropped on');
    const dialog = page.getByRole('dialog', { name: 'Close opportunity' });
    await choose(dialog, 'Reason', 'Rejected');
    await dialog.getByRole('button', { name: 'Close opportunity' }).click();
    await expect(dialog).toBeHidden();

    await expect(boardRegion(page)).toHaveText(`${name} moved to the Closed column.`);
    await page.getByRole('button', { name: /^Expand Closed/ }).click();
    await expect(column(page, 'Closed').getByRole('article', { name })).toBeVisible();
  });

  test('onto Dismissed, cancelled with Escape: waiting, then not moved, and the card stays', async ({
    page,
  }) => {
    await registerUser(page);
    const opp = { company: 'Initrode', title: 'Staff Keyboard Engineer' };
    await inOffer(page, opp);
    const name = `${opp.company}: ${opp.title}`;
    // Expanded, as #413's tests have it: from Offer, ArrowRight went past the narrow collapsed
    // Dismissed rail straight to Closed in CI (the sensor picks the nearest target by position).
    await page.getByRole('button', { name: /^Expand Dismissed/ }).click();
    await expect(page.getByRole('button', { name: 'Collapse Dismissed' })).toBeVisible();

    await keyboardDrop(page, card(page, opp.company, opp.title), 'Dismissed', 'ArrowRight');

    await expect(liveRegion(page)).toHaveText(
      `${name} is waiting for a reason to move to the Dismissed column. Choose one in the dialog, or cancel to leave it where it is.`,
    );
    const dialog = page.getByRole('dialog', { name: 'Dismiss opportunity' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await expect(boardRegion(page)).toHaveText(`${name} was not moved.`);
    await expect(column(page, 'Offer').getByRole('article', { name })).toBeVisible();
  });
});

// #475: with Dismissed and Closed collapsed to rails (the default), a keyboard drag steps through
// the columns in on-screen order and reaches both rails; expanding a column keeps focus on it.
test.describe('a keyboard drag reaches the collapsed rails, in column order (#475)', () => {
  test.use({ viewport: { width: 2200, height: 1100 } });

  test('ArrowRight from Offer: Dismissed, then Closed; ArrowLeft back to Dismissed; Space drops there', async ({
    page,
  }) => {
    await registerUser(page);
    const opp = { company: 'Initrode', title: 'Staff Keyboard Engineer' };
    await createOpportunity(page, opp);
    await moveWithMenu(page, opp, 'Offer');
    const name = `${opp.company}: ${opp.title}`;
    await expect(column(page, 'Offer').getByRole('article', { name })).toBeVisible();
    // Both terminal columns are rails.
    await expect(page.getByRole('button', { name: /^Expand Dismissed/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Expand Closed/ })).toBeVisible();

    await card(page, opp.company, opp.title).focus();
    await page.keyboard.press('Space');
    // Picked up, then at once over its own column (dnd-kit's onDragOver replaces "Picked up").
    await expect(liveRegion(page)).toHaveText(`${name} is over the Offer column.`);
    await page.keyboard.press('ArrowRight');
    await expect(liveRegion(page)).toHaveText(`${name} is over the Dismissed column.`);
    await page.keyboard.press('ArrowRight');
    await expect(liveRegion(page)).toHaveText(`${name} is over the Closed column.`);
    await page.keyboard.press('ArrowLeft');
    await expect(liveRegion(page)).toHaveText(`${name} is over the Dismissed column.`);
    await page.keyboard.press('Space');

    await expect(liveRegion(page)).toHaveText(
      `${name} is waiting for a reason to move to the Dismissed column. Choose one in the dialog, or cancel to leave it where it is.`,
    );
    const dialog = page.getByRole('dialog', { name: 'Dismiss opportunity' });
    await expect(dialog).toBeVisible();
    await choose(dialog, 'Reason', 'Other');
    await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: /^Expand Dismissed/ }).click();
    await expect(column(page, 'Dismissed').getByRole('article', { name })).toBeVisible();
  });

  test('Enter on Expand keeps focus on the column: on Collapse, and back on Expand', async ({
    page,
  }) => {
    await registerUser(page);
    await page.goto('/pipeline');
    const expand = page.getByRole('button', { name: /^Expand Dismissed/ });
    await expand.focus();
    await page.keyboard.press('Enter');
    const collapse = page.getByRole('button', { name: 'Collapse Dismissed' });
    await expect(collapse).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /^Expand Dismissed/ })).toBeFocused();
  });
});
