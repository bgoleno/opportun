// The first-run tour in a real browser (FR-U11, design section 11 criteria 8 to 10): the
// production build, served by the real server with its real CSP, walked end to end at phone
// sizes in both themes.
import { expect, test, type Page } from '@playwright/test';
import { registerUser } from './helpers';

const STEP_HEADINGS = [
  'Three steps to a working search',
  'Bring your own AI key',
  'Let your inbox do the data entry',
  'Your mail will land here',
  'Every role, from first look to offer',
  'New roles, ranked for you',
  'One resume, tailored for every role',
  'See who can refer you',
  "You're ready to go",
];

/** Collects CSP violations from the moment the page loads. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('__reportCsp', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __reportCsp: (v: string) => void }).__reportCsp(
        `${e.violatedDirective} ${e.blockedURI}`,
      );
    });
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text()))
      violations.push(m.text());
  });
  return violations;
}

const tourCard = (page: Page) => page.locator('dialog[data-tour-layer] [data-tour-card]');

/** No horizontal overflow, the card fully on screen, and not over the highlighted target. */
async function expectLayoutSound(page: Page, label: string): Promise<void> {
  await expect(tourCard(page)).not.toHaveAttribute('data-layout', 'searching');
  // The spotlight animates between steps (200ms) and the card fades in: measure once it has
  // stopped moving, not mid-transition.
  const measure = () =>
    page.evaluate(() => {
      const de = document.documentElement;
      const cardEl = document.querySelector('[data-tour-card]')!;
      const card = cardEl.getBoundingClientRect();
      const spot = document.querySelector('[data-tour-spotlight]')?.getBoundingClientRect();
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        vw: window.innerWidth,
        vh: window.innerHeight,
        layout: cardEl.getAttribute('data-layout'),
        card: { top: card.top, left: card.left, right: card.right, bottom: card.bottom },
        spot:
          spot === undefined
            ? null
            : { top: spot.top, left: spot.left, right: spot.right, bottom: spot.bottom },
      };
    });
  let m = await measure();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    const again = await measure();
    if (JSON.stringify(again) === JSON.stringify(m)) break;
    m = again;
  }
  expect(m.scrollWidth, `${label}: horizontal overflow`).toBeLessThanOrEqual(m.clientWidth);
  expect(m.card.left, `${label}: card left`).toBeGreaterThanOrEqual(0);
  expect(m.card.top, `${label}: card top`).toBeGreaterThanOrEqual(0);
  expect(m.card.right, `${label}: card right`).toBeLessThanOrEqual(m.vw);
  expect(m.card.bottom, `${label}: card bottom`).toBeLessThanOrEqual(m.vh);
  if (m.spot !== null) {
    const overlapW = Math.min(m.card.right, m.spot.right) - Math.max(m.card.left, m.spot.left);
    const overlapH = Math.min(m.card.bottom, m.spot.bottom) - Math.max(m.card.top, m.spot.top);
    // The spotlight is the target's visible, highlighted part (clamped beside the sheet).
    // The one designed exception (section 6.2): an anchored card over a target taller than 60%
    // of the viewport sits inside its top edge rather than off-screen beyond it.
    const large = m.layout === 'anchored' && m.spot.bottom - m.spot.top > m.vh * 0.6;
    if (!large) {
      expect(
        overlapW > 0 && overlapH > 0,
        `${label}: card covers the target ${JSON.stringify(m)}`,
      ).toBe(false);
    }
  }
}

async function walkTour(page: Page, label: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /Let's get your search running/ });
  await expect(dialog).toBeVisible();
  await expectLayoutSound(page, `${label} welcome`);
  await dialog.getByRole('button', { name: 'Start the tour' }).click();
  for (const [i, heading] of STEP_HEADINGS.entries()) {
    const layer = page.locator('dialog[data-tour-layer]');
    // A substring match: the accessible name also carries the "Step N of 9:" prefix.
    await expect(layer.getByRole('heading', { name: heading })).toBeVisible();
    await expect(layer.getByText(`Step ${i + 1} of 9`, { exact: true })).toBeVisible();
    await expectLayoutSound(page, `${label} step ${i + 1}`);
    await layer
      .getByRole('button', { name: i === STEP_HEADINGS.length - 1 ? 'Done' : 'Next' })
      .click();
  }
  await expect(page.locator('dialog[data-tour-layer]')).toHaveCount(0);
}

for (const [w, h] of [
  [360, 740],
  [740, 360],
] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`tour at ${w}x${h} (${scheme}): no overflow, card on screen, no CSP violation`, async ({
      page,
    }) => {
      const violations = await watchCsp(page);
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await registerUser(page, 'Tour Taker', { keepTour: true });
      await walkTour(page, `${w}x${h} ${scheme}`);
      // Focus returns to the page (the element focused before, or #main).
      await expect(page.locator(':focus')).toHaveCount(1);
      expect(violations).toEqual([]);
    });
  }
}

test('tour on a desktop: Do it now pauses to the pill, and the pause survives a reload', async ({
  page,
}) => {
  const violations = await watchCsp(page);
  await registerUser(page, 'Tour Pauser', { keepTour: true });
  await page.getByRole('button', { name: 'Start the tour' }).click();
  const layer = page.locator('dialog[data-tour-layer]');
  await layer.getByRole('button', { name: 'Next' }).click();
  await expectLayoutSound(page, 'desktop step 2');
  await layer.getByRole('button', { name: 'Add my key' }).click();
  await expect(layer).toHaveCount(0);
  await expect(page.getByLabel('Provider')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Resume tour (2 of 9)' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Resume tour (2 of 9)' }).click();
  await expect(layer.getByText('Step 3 of 9', { exact: true })).toBeVisible();
  expect(violations).toEqual([]);
});

test('under reduced motion nothing in the tour transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await registerUser(page, 'Still Tourer', { keepTour: true });
  await page.getByRole('button', { name: 'Start the tour' }).click();
  const layer = page.locator('dialog[data-tour-layer]');
  await expect(layer.getByText('Step 1 of 9', { exact: true })).toBeVisible();
  await expect(tourCard(page)).not.toHaveAttribute('data-layout', 'searching');
  const moving = await page.evaluate(() =>
    [...document.querySelectorAll('dialog[data-tour-layer], dialog[data-tour-layer] *')]
      .filter((el) =>
        getComputedStyle(el)
          .transitionDuration.split(',')
          .some((d) => parseFloat(d) > 0),
      )
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(moving).toEqual([]);
});
