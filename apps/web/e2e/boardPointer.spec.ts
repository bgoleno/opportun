// The pipeline board's pointer drag (https://github.com/bgoleno/opportun/issues/960): a drop lands in
// the column drawn under the pointer, however soon after the drag and whatever the board is doing. A
// chain column scrolled behind a pinned end column was under the pointer too, and could win.
// The oracle is the page's own: what is drawn under the pointer as it is released.
import { expect, test, type Page } from '@playwright/test';
import { card, createOpportunity, registerUser } from './helpers';

const TITLE = 'Engineer';
const name = (company: string) => `${company}: ${TITLE}`;
const liveRegion = (page: Page) => page.locator('[id^="DndLiveRegion-"]');

/** The opportunities as stored: stage and order, by company. */
async function stored(page: Page): Promise<Map<string, string>> {
  const items = await page.evaluate(async () => {
    const r = await fetch('/api/v1/opportunities?limit=200');
    return (
      (await r.json()) as { items: { companyName: string; stage: string; sortOrder: number }[] }
    ).items;
  });
  return new Map(
    [...items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((o) => [o.companyName, o.stage] as const),
  );
}

/** Which column each card is drawn in, in the order drawn. */
const onScreen = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label$=" column"]')].flatMap((s) =>
      [...s.querySelectorAll('article')].map(
        (a) =>
          [
            a.getAttribute('aria-label')!.split(':')[0]!,
            s.getAttribute('aria-label')!.replace(' column', ''),
          ] as const,
      ),
    ),
  );

const STAGE = new Map([
  ['New', 'discovered'],
  ['Interested', 'interested'],
  ['Preparing', 'preparing'],
  ['Applied', 'applied'],
  ['In process', 'in_process'],
  ['Offer', 'offer'],
  ['Dismissed', 'dismissed'],
  ['Closed', 'closed'],
]);

interface Release {
  /** The column drawn under the pointer, or null. */
  drawn: string | null;
  /** The column announced as the one the card is over, or null. */
  shown: string | null;
}

/** From here on, the page notes both each time the pointer is released. */
async function watchReleases(page: Page) {
  await page.evaluate(() => {
    addEventListener(
      'pointerup',
      (e) => {
        const under = document
          .elementsFromPoint(e.clientX, e.clientY)
          .map((el) => el.closest('section[aria-label$=" column"]'))
          .find((s) => s !== null);
        const said = document.querySelector('[id^="DndLiveRegion-"]')?.textContent ?? '';
        (window as unknown as { release: unknown }).release = {
          drawn: under?.getAttribute('aria-label')?.replace(' column', '') ?? null,
          shown: /is over the (.+) column\.$/.exec(said)?.[1] ?? null,
        };
      },
      { capture: true },
    );
  });
}

const lastRelease = (page: Page) =>
  page.evaluate(() => (window as unknown as { release: Release }).release);

const column = (page: Page, label: string) =>
  page.getByRole('region', { name: `${label} column`, exact: true });

/** The part of a column that is on screen. */
async function visible(page: Page, label: string) {
  return await column(page, label).evaluate((el) => {
    const b = el.getBoundingClientRect();
    const a = el.closest('[data-board-scroller]')?.getBoundingClientRect();
    return {
      left: Math.max(b.left, a?.left ?? b.left),
      right: Math.min(b.right, a?.right ?? b.right, document.documentElement.clientWidth),
      top: b.top,
      bottom: b.bottom,
    };
  });
}

/** Picks a card up by its words, in the part of it on screen, and checks that it was. */
async function pickUp(page: Page, company: string) {
  const box = (await card(page, company, TITLE).boundingBox())!;
  const x = Math.max(box.x, (await visible(page, 'New')).left) + 14;
  await page.mouse.move(x, box.y + 14);
  await page.mouse.down();
  await page.mouse.move(x + 10, box.y + 22, { steps: 4 });
  await expect(liveRegion(page), 'picked up').toContainText(`${name(company)} is over the New`);
  return { x: x + 10, y: box.y + 22 };
}

/** A dozen moves, a frame apart, as a hand makes; or three, or one, as fast as the browser takes. */
type How = 'hand' | 'quick' | 'one move';

async function moveTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  how: How,
) {
  if (how !== 'hand') return await page.mouse.move(to.x, to.y, { steps: how === 'quick' ? 3 : 1 });
  for (let k = 1; k <= 12; k++) {
    await page.mouse.move(from.x + ((to.x - from.x) * k) / 12, from.y + ((to.y - from.y) * k) / 12);
    await page.waitForTimeout(16);
  }
}

async function board(page: Page, expanded: readonly string[], width: number, cards: number) {
  await page.setViewportSize({ width: 1920, height: 900 });
  await registerUser(page);
  for (let i = 0; i < cards; i++)
    await createOpportunity(page, { company: `Contoso ${i}`, title: TITLE });
  for (const e of expanded) await page.getByRole('button', { name: `Expand ${e} (` }).click();
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(200);
  await watchReleases(page);
}

/** The chain at its start again, at rest. */
async function rest(page: Page) {
  await page.evaluate(() => {
    for (const a of document.querySelectorAll('[data-board-scroller]')) a.scrollLeft = 0;
  });
  await page.waitForTimeout(150);
}

// At 768 px with both expanded no chain column is on screen to drag from (#902).
const LAYOUTS: { expanded: string[]; widths: number[] }[] = [
  { expanded: [], widths: [768, 900, 1024, 1280, 1920] },
  { expanded: ['Dismissed'], widths: [768, 900, 1024, 1280, 1920] },
  { expanded: ['Closed'], widths: [768, 1280] },
  { expanded: ['Dismissed', 'Closed'], widths: [1024, 1280, 1920] },
];

/** At once across the column, as a hand moves it and faster; and after the board has come to rest. */
const DROPS: { how: How; wait: number; at: number }[] = [
  { how: 'hand', wait: 0, at: 0.1 },
  { how: 'hand', wait: 0, at: 0.5 },
  { how: 'hand', wait: 0, at: 0.9 },
  { how: 'quick', wait: 0, at: 0.1 },
  { how: 'one move', wait: 0, at: 0.5 },
  { how: 'hand', wait: 1_200, at: 0.1 },
];

for (const { expanded, widths } of LAYOUTS) {
  const layout =
    expanded.length === 0 ? 'end columns collapsed' : `${expanded.join(' and ')} expanded`;
  for (const width of widths) {
    test(`dropped on an end column at ${width} px, ${layout}: that one asks, and cancelling changes nothing`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await board(page, expanded, width, 1);
      for (const end of ['Dismissed', 'Closed']) {
        for (const { how, wait, at } of DROPS) {
          const where = `${end}, ${how}, after ${wait} ms, at ${at}`;
          await rest(page);
          const v = await visible(page, end);
          const from = await pickUp(page, 'Contoso 0');
          await moveTo(page, from, { x: v.left + (v.right - v.left) * at, y: v.top + 60 }, how);
          if (wait > 0) await page.waitForTimeout(wait);
          await page.mouse.up();
          const r = await lastRelease(page);
          expect(r.drawn, where).toBe(end);
          expect.soft(r.shown, where).toBe(end);
          await expect(liveRegion(page), where).toHaveText(
            `${name('Contoso 0')} is waiting for a reason to move to the ${end} column. Choose one in the dialog, or cancel to leave it where it is.`,
          );
          await expect(page.getByRole('dialog'), where).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toBeHidden();
          expect((await stored(page)).get('Contoso 0'), where).toBe('discovered');
          expect(await onScreen(page), where).toEqual([['Contoso 0', 'New']]);
        }
      }
    });
  }
}

for (const width of [768, 1280]) {
  test(`dropped on another column at ${width} px, at once: it moves there, as stored`, async ({
    page,
  }) => {
    await board(page, ['Dismissed'].slice(0, width === 768 ? 0 : 1), width, 2);
    await rest(page);
    const v = await visible(page, 'Interested');
    const from = await pickUp(page, 'Contoso 0');
    await moveTo(page, from, { x: (v.left + v.right) / 2, y: v.top + 60 }, 'hand');
    await page.mouse.up();
    const r = await lastRelease(page);
    expect(r.shown).toBe(r.drawn);
    expect(r.drawn).toBe('Interested');
    await expect(column(page, 'Interested').getByRole('article')).toHaveCount(1);
    await expect.poll(async () => (await stored(page)).get('Contoso 0')).toBe('interested');
  });

  test(`let go while the board scrolls itself, at ${width} px: where it is shown`, async ({
    page,
  }) => {
    await board(page, [], width, 1);
    for (const past of [60, 250, 500, 800]) {
      await rest(page);
      const chain = await page.evaluate(() => {
        const a = document.querySelector('[data-board-scroller]')!.getBoundingClientRect();
        return { right: a.right, top: a.top };
      });
      const from = await pickUp(page, 'Contoso 0');
      await moveTo(page, from, { x: chain.right - 24, y: chain.top + 60 }, 'hand');
      await page.waitForFunction(
        (px) => document.querySelector('[data-board-scroller]')!.scrollLeft >= px,
        past,
      );
      await page.mouse.up();
      const r = await lastRelease(page);
      const said = (await liveRegion(page).textContent()) ?? '';
      // What is shown can be a frame behind what is drawn while the board scrolls (dnd-kit's
      // rectangles), so it may be the column before: never an end column, which is not near it.
      expect(['Dismissed', 'Closed'], `${past} px in: ${said}`).not.toContain(r.shown);
      const now = (await stored(page)).get('Contoso 0');
      // Moved to the column shown, or refused by the stage rules and left where it was.
      if (said.includes('was dropped on')) {
        const ended = /was dropped on the (.+) column\.$/.exec(said)?.[1] ?? '';
        expect([r.shown, r.drawn], said).toContain(ended);
        if (ended === 'New') continue;
        await expect.poll(async () => (await stored(page)).get('Contoso 0')).toBe(STAGE.get(ended));
        break;
      }
      expect(said, `${past} px in`).toContain('was not moved.');
      expect(now).toBe('discovered');
    }
  });
}

test('dropped outside every column: nothing changes', async ({ page }) => {
  await board(page, ['Dismissed'], 1280, 1);
  for (const how of ['hand', 'quick'] as const) {
    await rest(page);
    const from = await pickUp(page, 'Contoso 0');
    // Well below every column, with the card touching none.
    await moveTo(page, from, { x: from.x + 40, y: 880 }, how);
    await page.mouse.up();
    expect((await lastRelease(page)).drawn).toBeNull();
    await expect(liveRegion(page)).toHaveText(`${name('Contoso 0')} was dropped on no column.`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await stored(page)).get('Contoso 0')).toBe('discovered');
  }
});

test('dropped just under a short column: it lands there, as shown', async ({ page }) => {
  await board(page, [], 1280, 1);
  const v = await visible(page, 'Interested');
  const from = await pickUp(page, 'Contoso 0');
  await moveTo(page, from, { x: (v.left + v.right) / 2 - 60, y: v.bottom + 6 }, 'hand');
  await page.mouse.up();
  const r = await lastRelease(page);
  expect(r).toEqual({ drawn: null, shown: 'Interested' });
  await expect.poll(async () => (await stored(page)).get('Contoso 0')).toBe('interested');
});

test('reordered within a column: the stored order is the one on screen', async ({ page }) => {
  await board(page, ['Dismissed'], 1280, 3);
  const before = (await onScreen(page)).map(([c]) => c);
  const [first, , third] = before;
  const from = await pickUp(page, first!);
  const target = (await card(page, third!, TITLE).boundingBox())!;
  await moveTo(page, from, { x: from.x, y: target.y + target.height / 2 }, 'hand');
  await page.mouse.up();
  await expect.poll(async () => (await onScreen(page)).map(([c]) => c)).not.toEqual(before);
  const after = (await onScreen(page)).map(([c]) => c);
  await expect.poll(async () => [...(await stored(page)).keys()]).toEqual(after);
});

test('reordered with the pointer in the gap beside the column: it keeps its place', async ({
  page,
}) => {
  await board(page, ['Dismissed'], 1280, 3);
  const before = (await onScreen(page)).map(([c]) => c);
  const from = await pickUp(page, before[0]!);
  const target = (await card(page, before[2]!, TITLE).boundingBox())!;
  const v = await visible(page, 'New');
  await moveTo(page, from, { x: v.right + 4, y: target.y + target.height / 2 }, 'hand');
  await page.mouse.up();
  const r = await lastRelease(page);
  expect(r).toEqual({ drawn: null, shown: 'New' });
  // The first card is last now, the others moved up.
  const after = [before[1]!, before[2]!, before[0]!];
  await expect.poll(async () => (await onScreen(page)).map(([c]) => c)).toEqual(after);
  await expect.poll(async () => [...(await stored(page)).keys()]).toEqual(after);
});
