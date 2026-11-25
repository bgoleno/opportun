// The pipeline board at a narrow width. With Dismissed and Closed both expanded
// (https://github.com/bgoleno/opportun/issues/902) the other columns keep a whole column, and the end
// columns scroll sideways in an area of their own beside them. With one expanded on a phone
// (https://github.com/bgoleno/opportun/issues/997) it gives way beside the other's rail. Measured as
// drawn, in a real browser, with the mouse and with the keyboard.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { announced, dialogIs, frames, withoutGlide } from './boardDrag';
import { card, registerUser } from './helpers';

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
const OPP = { company: 'Contoso', title: 'Engineer' };
const NAME = `${OPP.company}: ${OPP.title}`;

const liveRegion = (page: Page) => page.locator('[id^="DndLiveRegion-"]');
const column = (page: Page, name: string) => page.getByRole('region', { name: `${name} column` });
const expand = (page: Page, name: string) => page.getByRole('button', { name: `Expand ${name} (` });
const collapse = (page: Page, name: string) =>
  page.getByRole('button', { name: `Collapse ${name}` });

/**
 * Resizes, and waits until the page has been drawn at the new width. A drag waits out the rest of the
 * resize too (`settled`): dnd-kit cancels a drag on one.
 */
async function resize(page: Page, width: number, { settled = false } = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction((w) => window.innerWidth === w, width, { polling: 'raf' });
  await frames(page);
  if (settled) await page.waitForTimeout(100);
}

async function board(page: Page, expanded: readonly string[] = ['Dismissed', 'Closed']) {
  await page.setViewportSize({ width: 1920, height: 900 });
  await registerUser(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'opportun_csrf')?.value;
  const made = await page.request.post('/api/v1/opportunities', {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: { companyName: OPP.company, title: OPP.title, sourceKind: 'manual' },
  });
  expect(made.status(), await made.text()).toBe(201);
  await page.goto('/pipeline');
  await expect(card(page, OPP.company, OPP.title)).toBeVisible();
  for (const name of expanded) await expand(page, name).click();
}

/** `count` dismissed opportunities, made behind the page's back; the board is open on them after. */
async function dismissed(page: Page, count: number, title = 'Senior Product Manager') {
  const statuses = await page.evaluate(
    async ([n, title]) => {
      const csrf = /(?:^|; )opportun_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
      const post = (path: string, body: unknown) =>
        fetch(`/api/v1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
          body: JSON.stringify(body),
        });
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const made = await post('/opportunities', {
          companyName: `Fabrikam Telecommunications ${i}`,
          title,
          sourceKind: 'manual',
        });
        const { id } = (await made.json()) as { id: string };
        const moved = await post(`/opportunities/${id}/stage`, {
          to: 'dismissed',
          reason: 'other',
        });
        out.push(made.status, moved.status);
      }
      return out;
    },
    [count, title] as const,
  );
  expect(statuses.filter((x) => x >= 300)).toEqual([]);
  await page.goto('/pipeline');
}

interface Drawn {
  width: number;
  /** The part of it on screen: inside its scrolling area, and the window. */
  left: number;
  right: number;
}

/** Where `name`'s column is drawn, and how far the page scrolls sideways. */
async function drawn(page: Page, name: string): Promise<Drawn & { sideways: number }> {
  return await column(page, name).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let left = Math.max(box.left, 0);
    let right = Math.min(box.right, vw);
    for (let p = el.parentElement; p !== null && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowX === 'visible') continue;
      const area = p.getBoundingClientRect();
      left = Math.max(left, area.left);
      right = Math.min(right, area.right);
    }
    return {
      width: box.width,
      left,
      right,
      sideways: document.documentElement.scrollWidth - vw,
    };
  });
}

const shown = (d: Drawn) => Math.max(0, d.right - d.left);

/** How far each scrolling area of the board is scrolled. */
const scrolls = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-board-scroller]')].map((a) => Math.round(a.scrollLeft)),
  );

test('both end columns expanded: a whole other column, a sliver of the second end column, no sideways page', async ({
  page,
}) => {
  await board(page);
  for (const width of [375, 768, 900, 1024]) {
    await resize(page, width);
    const first = await drawn(page, 'New');
    const at = `${width} px: ${JSON.stringify(first)}`;
    expect(first.sideways, at).toBe(0);
    // On a phone there is no room for a whole one beside what two rails take.
    expect(shown(first), at).toBeGreaterThanOrEqual(width === 375 ? 200 : 288);
    const end = await drawn(page, 'Dismissed');
    // Whole from 768 px; on a phone its 10rem are wider than the area.
    if (width === 375) expect(end.width, at).toBe(160);
    expect(shown(end), at).toBeCloseTo(width === 375 ? 124 : end.width, 0);
    // The sign that Closed is beside it.
    if (width >= 768) expect(shown(await drawn(page, 'Closed')), at).toBeGreaterThanOrEqual(6);
  }
});

const ENDS = ['Dismissed', 'Closed'] as const;
/** Every width a phone's board is tested at, and what it keeps of the other columns (#997). */
const PHONES = [
  { width: 320, others: 48, end: 160 },
  { width: 360, others: 88, end: 160 },
  { width: 375, others: 103, end: 160 },
  { width: 414, others: 112, end: 190 },
] as const;

/** Leaves the end columns in `expanded` expanded and the rest rails. */
async function only(page: Page, expanded: readonly string[]) {
  for (const name of ENDS) {
    const open = await collapse(page, name).isVisible();
    if (expanded.includes(name) && !open) await expand(page, name).click();
    if (!expanded.includes(name) && open) await collapse(page, name).click();
  }
}

test('the page never scrolls sideways, whichever end columns are expanded (#997)', async ({
  page,
}) => {
  await board(page, []);
  // A word that fits no column, in one of the end columns.
  await dismissed(page, 1, 'W'.repeat(100));
  const out: Record<string, number> = {};
  for (const expanded of [[], ['Dismissed'], ['Closed'], ENDS]) {
    await resize(page, 1920);
    await only(page, expanded);
    for (const width of [320, 360, 375, 414, 480, 640, 768]) {
      await resize(page, width);
      const { sideways } = await drawn(page, 'New');
      if (sideways !== 0) out[`${expanded.join(' and ') || 'neither'} at ${width} px`] = sideways;
    }
  }
  expect(out).toEqual({});
});

test('one end column expanded on a phone: it gives way, and the others and the other rail are on screen (#997)', async ({
  page,
}) => {
  await board(page, []);
  // A card whose badge ("Posting unconfirmed") is wider than a card of a 10rem column.
  await page.route(/\/api\/v1\/opportunities\?/, async (route) => {
    const res = await route.fetch();
    const list = (await res.json()) as { items: Record<string, unknown>[] };
    for (const o of list.items) o.postingState = 'needs_review';
    await route.fulfill({ json: list });
  });
  await dismissed(page, 1);
  await only(page, ['Dismissed']);
  await expect(page.getByText('Posting unconfirmed').last()).toBeVisible();
  for (const name of ENDS) {
    await resize(page, 1920);
    await only(page, [name]);
    for (const { width, others, end } of PHONES) {
      await resize(page, width);
      const got: number[] = [];
      for (const c of ['New', name, name === 'Closed' ? 'Dismissed' : 'Closed'])
        got.push(Math.round(shown(await drawn(page, c))));
      expect(got, `${name} at ${width} px`).toEqual([others, end, 56]);
      expect(Math.round((await drawn(page, name)).width)).toBe(end);
    }
  }
});

/**
 * What is on screen of each column where nothing has changed: before #902 (measured at f5a46246), and,
 * on a phone and with both end columns expanded, before #997 (at 01a835ac).
 */
const AS_BEFORE: readonly [expanded: readonly string[], width: number, shown: readonly number[]][] =
  [
    [[], 320, [152, 0, 0, 0, 0, 0, 56, 56]],
    [[], 360, [192, 0, 0, 0, 0, 0, 56, 56]],
    [[], 375, [207, 0, 0, 0, 0, 0, 56, 56]],
    [[], 414, [246, 0, 0, 0, 0, 0, 56, 56]],
    [[], 768, [288, 44, 0, 0, 0, 0, 56, 56]],
    [[], 900, [288, 176, 0, 0, 0, 0, 56, 56]],
    [[], 1280, [288, 288, 256, 0, 0, 0, 56, 56]],
    [[], 1920, [288, 288, 288, 288, 288, 0, 56, 56]],
    [['Dismissed'], 768, [112, 0, 0, 0, 0, 0, 288, 56]],
    [['Dismissed'], 900, [244, 0, 0, 0, 0, 0, 288, 56]],
    [['Dismissed'], 1280, [288, 288, 24, 0, 0, 0, 288, 56]],
    [['Dismissed'], 1920, [288, 288, 288, 288, 64, 0, 288, 56]],
    [['Closed'], 768, [112, 0, 0, 0, 0, 0, 56, 288]],
    [['Closed'], 900, [244, 0, 0, 0, 0, 0, 56, 288]],
    [['Closed'], 1280, [288, 288, 24, 0, 0, 0, 56, 288]],
    [['Closed'], 1920, [288, 288, 288, 288, 64, 0, 56, 288]],
    [ENDS, 320, [152, 0, 0, 0, 0, 0, 124, 0]],
    [ENDS, 360, [192, 0, 0, 0, 0, 0, 124, 0]],
    [ENDS, 375, [207, 0, 0, 0, 0, 0, 124, 0]],
    [ENDS, 414, [246, 0, 0, 0, 0, 0, 124, 0]],
    [ENDS, 768, [288, 0, 0, 0, 0, 0, 160, 8]],
    [ENDS, 900, [288, 0, 0, 0, 0, 0, 288, 12]],
    [ENDS, 1024, [288, 0, 0, 0, 0, 0, 288, 136]],
    [['Dismissed', 'Closed'], 1280, [288, 92, 0, 0, 0, 0, 288, 288]],
    [['Dismissed', 'Closed'], 1920, [288, 288, 288, 132, 0, 0, 288, 288]],
  ];

test('with room for all, with neither end column expanded, and with both: as before', async ({
  page,
}) => {
  await board(page, []);
  let now: readonly string[] | null = null;
  for (const [expanded, width, want] of AS_BEFORE) {
    // Toggled at a width with room for all.
    if (now === null || now.join() !== expanded.join()) {
      await resize(page, 1920);
      await only(page, expanded);
      now = expanded;
    }
    await resize(page, width);
    const got: number[] = [];
    for (const name of COLUMNS) got.push(Math.round(shown(await drawn(page, name))));
    expect(got, `${expanded.join(' and ') || 'neither'} at ${width} px`).toEqual(want);
    expect((await drawn(page, 'New')).sideways).toBe(0);
  }
});

for (const [expanded, width] of [
  [ENDS, 768],
  [['Dismissed'], 360],
] as const)
  test(`an end column at its narrowest holds its header on one line, and its cards their words, ${expanded.join(' and ')} expanded at ${width} px`, async ({
    page,
  }) => {
    await board(page, []);
    await dismissed(page, 12);
    await only(page, expanded);
    await resize(page, width);
    const m = await column(page, 'Dismissed').evaluate((el) => {
      const inside = (outer: Element) => {
        const o = outer.getBoundingClientRect();
        return [...outer.querySelectorAll('*')]
          .filter((e) => e.getClientRects().length > 0)
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.left < o.left - 0.5 || r.right > o.right + 0.5;
          })
          .map((e) => `<${e.tagName.toLowerCase()}> ${e.textContent.slice(0, 20)}`);
      };
      const heading = el.querySelector('h2')!;
      const range = document.createRange();
      range.selectNodeContents(heading);
      const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.bottom)));
      const area = el.closest('[data-board-scroller]')!.getBoundingClientRect();
      const first = el.querySelector('article')!.getBoundingClientRect();
      return {
        // A card's focus ring has the column's padding for room, inside the area.
        room: Math.min(first.left - area.left, area.right - first.right) >= 4,
        width: el.getBoundingClientRect().width,
        heading: heading.textContent,
        lines: tops.size,
        past: [...el.querySelectorAll('article')].flatMap(inside),
        header: inside(el.querySelector('header')!),
      };
    });
    expect(m).toEqual({
      room: true,
      width: 160,
      heading: 'Dismissed 12',
      lines: 1,
      past: [],
      header: [],
    });
  });

test('an end column just expanded comes into view, with the mouse and the keyboard', async ({
  page,
}) => {
  await board(page, []);
  for (const width of [375, 768, 900]) {
    await resize(page, width);
    for (const how of ['mouse', 'keyboard'] as const) {
      const press = async (button: Locator) => {
        if (how === 'mouse') return await button.click();
        await button.focus();
        await page.keyboard.press('Enter');
      };
      // In either order: the second one opens into an area already full.
      for (const order of [
        ['Dismissed', 'Closed'],
        ['Closed', 'Dismissed'],
      ]) {
        for (const name of order) {
          const what = `${name}, ${how}, ${width} px`;
          await press(expand(page, name));
          await expect(collapse(page, name), what).toBeFocused();
          // On a phone the first one covers what is left of the area, but its control is there.
          if (width >= 768)
            await expect(column(page, name).getByRole('heading'), what).toBeInViewport({
              ratio: 1,
            });
          await expect(collapse(page, name), what).toBeInViewport({ ratio: 1 });
          // Room for its focus ring (and a forced-colours outline) inside the area.
          const room = await collapse(page, name).evaluate((b) => {
            const r = b.getBoundingClientRect();
            const a = b.closest('[data-board-scroller]')!.getBoundingClientRect();
            return Math.min(r.left - a.left, a.right - r.right, r.top - a.top, a.bottom - r.bottom);
          });
          expect(room, what).toBeGreaterThanOrEqual(4);
        }
        for (const name of order) await press(collapse(page, name));
      }
    }
  }
});

/** The left edge of the board's scrolling area an element is in. */
const areaLeft = (el: Element) => el.closest('[data-board-scroller]')?.getBoundingClientRect().left;

/** Picks the card up with the mouse and moves it to a point, in steps; does not let go. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
  const box = (await from.boundingBox())!;
  // The card's own words, in the part of it on screen: not its buttons.
  const x = Math.max(box.x, (await from.evaluate(areaLeft)) ?? box.x) + 20;
  await page.mouse.move(x, box.y + 16);
  await page.mouse.down();
  await page.mouse.move(x + 10, box.y + 24, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
}

/** A point in the part of `name`'s column that is on screen. */
async function pointIn(page: Page, name: string) {
  const d = await drawn(page, name);
  const box = (await column(page, name).boundingBox())!;
  return { x: (d.left + d.right) / 2, y: box.y + 60 };
}

/** The other columns' area, once it has come to rest. */
async function chainAtRest(page: Page): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const was = last;
        last = (await scrolls(page))[0]!;
        return was === last;
      },
      { intervals: [300] },
    )
    .toBe(true);
  return last;
}

for (const width of [768, 900]) {
  test(`dragged with the mouse from New to Dismissed and to Closed, and out of Closed, at ${width} px`, async ({
    page,
  }) => {
    await board(page);
    await resize(page, width, { settled: true });
    const cancel = async (end: string) => {
      await expect(liveRegion(page)).toContainText(`waiting for a reason to move to the ${end}`);
      await page.keyboard.press('Escape');
      await dialogIs(page, false);
      await expect(page.getByRole('dialog')).toBeHidden();
      await page.evaluate(() => {
        for (const a of document.querySelectorAll('[data-board-scroller]')) a.scrollLeft = 0;
      });
      await frames(page);
    };
    const dragged = card(page, OPP.company, OPP.title);
    await test.step('to Dismissed', async () => {
      await drag(page, dragged, await pointIn(page, 'Dismissed'));
      await page.mouse.up();
      await cancel('Dismissed');
    });
    await test.step('to Closed, held at the end area’s edge', async () => {
      const over = await pointIn(page, 'Dismissed');
      await drag(page, dragged, over);
      await expect(liveRegion(page)).toHaveText(`${NAME} is over the Dismissed column.`);
      // Crossing the chain's edge scrolls the chain, as at every width (dnd-kit's own auto-scroll).
      // Once it rests, what the end area does leaves it alone.
      const chain = await chainAtRest(page);
      const right = await column(page, 'Closed').evaluate(
        (el) => el.parentElement!.getBoundingClientRect().right,
      );
      await page.mouse.move(Math.min(right, width) - 14, over.y, { steps: 3 });
      await expect(liveRegion(page)).toHaveText(`${NAME} is over the Closed column.`, {
        timeout: 10_000,
      });
      expect((await scrolls(page))[0], 'the other columns stay where they were').toBe(chain);
      await page.mouse.up();
      await cancel('Closed');
    });
    await test.step('out of Closed', async () => {
      await page.getByRole('button', { name: `Move ${NAME}` }).click();
      await page.getByRole('menuitem', { name: 'Closed', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Reason').selectOption({ index: 1 });
      await dialog
        .getByRole('button', { name: /^Close/ })
        .first()
        .click();
      await expect(dialog).toBeHidden();
      await dragged.scrollIntoViewIfNeeded();
      await drag(page, dragged, await pointIn(page, 'New'));
      await expect(liveRegion(page)).toHaveText(`${NAME} is over the New column.`);
      await page.mouse.up();
      // The stage rules' answer, for the column it was over.
      await expect(liveRegion(page)).toHaveText(
        `${NAME} was not moved. Use Reopen to move a closed opportunity back to New.`,
      );
    });
  });
}

/** Moves the card through every column and back with the keyboard, seen and announced at each. */
async function keyboardSteps(page: Page, width: number, seen = 100) {
  await resize(page, width, { settled: true });
  await withoutGlide(page);
  await card(page, OPP.company, OPP.title).focus();
  await page.keyboard.press('Space');
  await announced(page, `${NAME} is over the New column.`);
  await expect(liveRegion(page)).toHaveText(`${NAME} is over the New column.`);
  // The sensor listens from a timer after the pick-up (boardKeyboard.spec.ts, keyboardDrop).
  await page.waitForTimeout(100);
  const steps = [
    ...COLUMNS.slice(1).map((c) => ['ArrowRight', c] as const),
    ...[...COLUMNS]
      .reverse()
      .slice(1)
      .map((c) => ['ArrowLeft', c] as const),
  ];
  for (const [key, name] of steps) {
    await page.keyboard.press(key);
    await announced(page, `${NAME} is over the ${name} column.`);
    await expect(liveRegion(page)).toHaveText(`${NAME} is over the ${name} column.`);
    // The card's centre is in the part of the column that is on screen, which is a real part.
    await expect
      .poll(
        async () => {
          const d = await drawn(page, name);
          const c = (await page.locator('.cursor-grabbing.shadow-lg').boundingBox())!;
          const x = c.x + c.width / 2;
          return { in: x >= d.left && x <= d.right, seen: shown(d) >= seen, page: d.sideways };
        },
        { message: `${name} at ${width} px`, intervals: [10, 20, 40, 80] },
      )
      .toEqual({ in: true, seen: true, page: 0 });
  }
  await page.keyboard.press('Escape');
  await announced(page, `Moving ${NAME} was cancelled.`);
  await expect(liveRegion(page)).toHaveText(`Moving ${NAME} was cancelled.`);
}

test('moved with the keyboard from New to Closed and back: on screen at each step', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await board(page);
  for (const width of [375, 768, 900]) await keyboardSteps(page, width);
});

test('the one end column expanded on a phone keeps its control and its ring on screen, by mouse and keyboard (#997)', async ({
  page,
}) => {
  await board(page, []);
  for (const { width } of PHONES) {
    await resize(page, width);
    for (const name of ENDS)
      for (const how of ['mouse', 'keyboard'] as const) {
        const what = `${name}, ${how}, ${width} px`;
        const press = async (button: Locator) => {
          if (how === 'mouse') return await button.click();
          await button.focus();
          await page.keyboard.press('Enter');
        };
        await press(expand(page, name));
        await expect(collapse(page, name), what).toBeFocused();
        await expect(column(page, name).getByRole('heading'), what).toBeInViewport({ ratio: 1 });
        await expect(collapse(page, name), what).toBeInViewport({ ratio: 1 });
        const room = await collapse(page, name).evaluate((b) => {
          const r = b.getBoundingClientRect();
          const a = b.closest('[data-board-scroller]')!.getBoundingClientRect();
          return Math.min(r.left - a.left, a.right - r.right, r.top - a.top, a.bottom - r.bottom);
        });
        expect(room, what).toBeGreaterThanOrEqual(4);
        await press(collapse(page, name));
        await expect(expand(page, name), what).toBeFocused();
        await expect(expand(page, name), what).toBeInViewport({ ratio: 1 });
      }
  }
});

for (const end of ENDS) {
  test(`with ${end} expanded on a phone, dragged with the mouse to each end column and back (#997)`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await board(page, [end]);
    const dragged = card(page, OPP.company, OPP.title);
    // A drag out of the other columns scrolls them on the way (dnd-kit's own auto-scroll).
    const unscroll = async () => {
      await page.evaluate(() => {
        for (const a of document.querySelectorAll('[data-board-scroller]')) a.scrollLeft = 0;
      });
      await frames(page);
    };
    for (const { width } of PHONES) {
      await resize(page, width, { settled: true });
      for (const name of ENDS) {
        await drag(page, dragged, await pointIn(page, name));
        await page.mouse.up();
        await dialogIs(page, true);
        await expect(liveRegion(page), `${width} px`).toContainText(
          `waiting for a reason to move to the ${name}`,
        );
        await page.keyboard.press('Escape');
        await dialogIs(page, false);
        await expect(page.getByRole('dialog')).toBeHidden();
        await unscroll();
      }
    }
    await resize(page, 1920);
    await page.getByRole('button', { name: `Move ${NAME}` }).click();
    await page.getByRole('menuitem', { name: end, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Reason').selectOption({ index: 1 });
    await dialog
      .getByRole('button', { name: /^(Close|Dismiss)/ })
      .first()
      .click();
    await expect(dialog).toBeHidden();
    for (const { width } of PHONES) {
      await resize(page, width, { settled: true });
      await unscroll();
      await drag(page, dragged, await pointIn(page, 'New'));
      await announced(page, `${NAME} is over the New column.`);
      await expect(liveRegion(page), `${width} px`).toHaveText(`${NAME} is over the New column.`);
      await page.mouse.up();
      // The stage rules' answer, for the column it was over.
      await expect(liveRegion(page), `${width} px`).toContainText(`${NAME} was not moved.`);
    }
  });

  test(`with ${end} expanded on a phone, moved with the keyboard from New to Closed and back: on screen at each step (#997)`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await board(page, [end]);
    // A rail has 56 px, and the others 48 px at 320.
    for (const { width, others } of PHONES) await keyboardSteps(page, width, Math.min(others, 56));
  });
}
