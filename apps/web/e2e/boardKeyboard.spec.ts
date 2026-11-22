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

/** Presses `key` and says whether the live region changed, within a second. */
async function stepped(page: Page, key: 'ArrowLeft' | 'ArrowRight'): Promise<boolean> {
  const before = (await liveRegion(page).textContent()) ?? '';
  await page.keyboard.press(key);
  return expect(liveRegion(page))
    .not.toHaveText(before, { timeout: 1_000 })
    .then(
      () => true,
      () => false,
    );
}

/**
 * Picks `moved` up with Space, then steps with the arrow key (ArrowLeft unless told), each time
 * letting the live region announce the new place, until it is over `target`'s column; then drops,
 * and waits for dnd-kit to say how the drop ended.
 *
 * Nothing is dropped until an arrow press has visibly moved the card (#823): dnd-kit's
 * KeyboardSensor starts listening for keys in a timer after the pick-up (6.3.1, attach()), and on
 * a loaded machine a key pressed before that timer runs is ignored. A card that already starts
 * over the target (dnd-kit can place it there at once) once dropped about 10 ms after the pick-up
 * and the drop was lost, leaving the drag open. So a card that starts over the target steps on past
 * it and back first. An arrow that changes nothing is pressed again, as the first step may only go
 * from the card to its own column, announced the same way; the drop key is pressed once.
 */
async function keyboardDrop(
  page: Page,
  moved: Locator,
  target: string,
  arrow: 'ArrowLeft' | 'ArrowRight' = 'ArrowLeft',
) {
  const back = arrow === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
  const wanted = `is over the ${target} column`;
  const over = async () => ((await liveRegion(page).textContent()) ?? '').includes(wanted);
  await moved.focus();
  await page.keyboard.press('Space');
  await expect(liveRegion(page)).toContainText('is over');
  let listening = false;
  if (await over()) {
    // Away, on past the target the way the drag goes (or else back), then back to it.
    let away: 'ArrowLeft' | 'ArrowRight' | undefined;
    for (const key of [arrow, back] as const) {
      // A press before the sensor listens changes nothing: press again, the same way.
      for (let i = 0; i < 4 && away === undefined; i++) if (await stepped(page, key)) away = key;
      if (away !== undefined) break;
    }
    expect(away, `the card never moved off the ${target} column`).toBeDefined();
    listening = true;
    const home = away === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    for (let i = 0; i < 6 && !(await over()); i++) await stepped(page, home);
  } else {
    for (let i = 0; i < 12 && !(await over()); i++) {
      if (await stepped(page, arrow)) listening = true;
    }
  }
  expect(listening, 'no arrow press moved the card, so the drop could be ignored').toBe(true);
  await expect(liveRegion(page)).toContainText(wanted);
  await page.keyboard.press('Space');
  // The drop ends the drag: dnd-kit says how (not moved, dropped, or waiting for a reason), and
  // never "is over" again.
  await expect(liveRegion(page), 'Space did not end the drag').not.toContainText('is over');
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
/**
 * Presses `key` until the live region changes, then expects `wanted` (#558). dnd-kit's
 * KeyboardSensor adds its keydown listener in a setTimeout after the drag starts, so a key pressed
 * right after "Picked up" can be lost: the region then stays as it was, and the key is pressed
 * again (a few times at most). A change to anything but `wanted` fails at once, so a column that
 * truly cannot be reached still fails the test.
 */
async function stepTo(page: Page, key: 'ArrowLeft' | 'ArrowRight', wanted: string) {
  const before = (await liveRegion(page).textContent()) ?? '';
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press(key);
    const moved = await expect(liveRegion(page))
      .not.toHaveText(before, { timeout: 1_000 })
      .then(
        () => true,
        () => false,
      );
    if (moved) break;
  }
  await expect(liveRegion(page)).toHaveText(wanted, { timeout: 1 });
}

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
    await stepTo(page, 'ArrowRight', `${name} is over the Dismissed column.`);
    await stepTo(page, 'ArrowRight', `${name} is over the Closed column.`);
    await stepTo(page, 'ArrowLeft', `${name} is over the Dismissed column.`);
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

// #833 (qa, found while fixing #823): with the Dismissed column expanded, a card picked up in it
// was announced over Offer, and ArrowLeft could not step out of Dismissed. Every column, in
// on-screen order, is reachable in both directions, with Dismissed collapsed and expanded.
const COLUMNS = [
  'New',
  'Interested',
  'Preparing',
  'Applied',
  'In process',
  'Offer',
  'Dismissed',
  'Closed',
];

test.describe('a keyboard drag steps to the adjacent column in both directions (#833)', () => {
  test.use({ viewport: { width: 2200, height: 1100 } });

  test('picked up in an expanded Dismissed column: announced there, and ArrowLeft steps to Offer', async ({
    page,
  }) => {
    await registerUser(page);
    for (const title of ['Offer One', 'Offer Two']) {
      const opp = { company: 'Initrode', title };
      await createOpportunity(page, opp);
      await moveWithMenu(page, opp, 'Offer');
    }
    const opp = { company: 'Initrode', title: 'Dismissed One' };
    await dismissed(page, opp);
    const name = `${opp.company}: ${opp.title}`;

    await card(page, opp.company, opp.title).focus();
    await page.keyboard.press('Space');
    await expect(liveRegion(page)).toHaveText(`${name} is over the Dismissed column.`);
    await stepTo(page, 'ArrowLeft', `${name} is over the Offer column.`);
    await stepTo(page, 'ArrowRight', `${name} is over the Dismissed column.`);
    await stepTo(page, 'ArrowRight', `${name} is over the Closed column.`);
    await stepTo(page, 'ArrowLeft', `${name} is over the Dismissed column.`);
    await stepTo(page, 'ArrowLeft', `${name} is over the Offer column.`);
    await page.keyboard.press('Escape');
  });

  for (const expanded of [false, true]) {
    test(`walks every column right then left, Dismissed ${expanded ? 'expanded' : 'collapsed'}`, async ({
      page,
    }) => {
      await registerUser(page);
      const opp = { company: 'Initrode', title: 'Walking Card' };
      await createOpportunity(page, opp);
      if (expanded) await page.getByRole('button', { name: /^Expand Dismissed/ }).click();
      const name = `${opp.company}: ${opp.title}`;

      await card(page, opp.company, opp.title).focus();
      await page.keyboard.press('Space');
      await expect(liveRegion(page)).toHaveText(`${name} is over the ${COLUMNS[0]} column.`);
      for (const col of COLUMNS.slice(1)) {
        await stepTo(page, 'ArrowRight', `${name} is over the ${col} column.`);
      }
      for (const col of [...COLUMNS].reverse().slice(1)) {
        await stepTo(page, 'ArrowLeft', `${name} is over the ${col} column.`);
      }
      await page.keyboard.press('Escape');
      await expect(column(page, COLUMNS[0]!).getByRole('article', { name })).toBeVisible();
    });
  }
});
