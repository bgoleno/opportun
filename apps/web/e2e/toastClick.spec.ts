// A toast takes the pointer from its first drawing on (https://github.com/bgoleno/opportun/issues/1014),
// and only where it is.
import { expect, test, type Page } from '@playwright/test';
import { registerUser, toasts } from './helpers';

const RESULT = {
  id: 'r1',
  runId: 'run',
  sourceId: 'src',
  sourceKind: 'ats_greenhouse',
  roleTargetId: null,
  dedupeKey: 'a|b|c',
  aiScore: 91,
  aiRationale: 'Fits.',
  rankSkipReason: null,
  rankDeferredAt: null,
  rankBatchSentAt: null,
  prefilterOutcome: null,
  prefilterRule: null,
  resolution: 'full',
  resolvedSourceRef: null,
  disposition: 'pending',
  opportunityId: null,
  sourceMailChannel: null,
  sourceMailExternalId: null,
  dismissReason: null,
  dismissNote: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  posting: {
    company: 'Contoso',
    title: 'Engineer',
    descriptionMd: 'Words.',
    postingUrl: null,
    location: null,
    remote: true,
    compNote: null,
    externalId: 'x1',
    postedAt: null,
  },
};

const view = (page: Page) => toasts(page).getByRole('button', { name: 'View opportunity' });

/** Whether the point is on a toast, on the toasts' own list around them, or on the page under it. */
const under = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px!, py!);
      if (el?.closest('[role="region"] li')) return 'toast';
      return el?.closest('[role="region"]') ? 'list' : 'page';
    },
    [x, y],
  );

/** Accepts a result already in the pipeline, with React's work `late` ms late: its toast is drawn. */
async function toasted(page: Page, late: number) {
  // React's scheduler posts to itself on a MessagePort, as late as a busy main thread would make it.
  await page.addInitScript(() => {
    const w = window as unknown as { reactLate?: number };
    const post = MessagePort.prototype.postMessage as (...args: unknown[]) => void;
    MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
      if (w.reactLate === undefined) post.apply(this, args);
      else setTimeout(() => post.apply(this, args), w.reactLate);
    };
  });
  await registerUser(page);
  await page.route(/\/api\/v1\/discovery\/results\?/, async (route) => {
    if (route.request().method() !== 'GET') return await route.fallback();
    const here = new URL(route.request().url()).searchParams.get('disposition') === 'pending';
    await route.fulfill({ json: { items: here ? [RESULT] : [], total: here ? 1 : 0 } });
  });
  await page.route(/\/api\/v1\/discovery\/results\/r1\/accept/, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: 'already_decided',
          message: 'This result was already accepted.',
          disposition: 'accepted',
          existingId: 'o-9',
        },
      },
    }),
  );
  await page.goto('/discovery');
  const accept = page.getByRole('button', { name: 'Accept Engineer at Contoso' });
  await expect(accept).toBeVisible();
  if (late > 0)
    await page.evaluate((ms) => {
      (window as unknown as { reactLate?: number }).reactLate = ms;
    }, late);
  await accept.click();
  await view(page).waitFor({ state: 'attached' });
  return (await view(page).boundingBox())!;
}

test('a click on a toast just drawn does what its button says, with React’s next task a second late', async ({
  page,
}) => {
  const box = await toasted(page, 1000);
  // The mouse as it is, without waiting for the button to take the pointer.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(/\/opportunities\/o-9$/);
});

test('beside its toasts the page takes the pointer, and where a closed one was', async ({
  page,
}) => {
  const box = await toasted(page, 0);
  const at = [box.x + box.width / 2, box.y + box.height / 2] as const;
  expect(await under(page, ...at)).toBe('toast');
  const list = (await toasts(page).getByRole('list').boundingBox())!;
  // The list's own padding around its toasts is the list's, as it was.
  expect(await under(page, list.x + 4, box.y)).toBe('list');
  expect(await under(page, list.x - 10, list.y + list.height / 2)).toBe('page');
  expect(await under(page, list.x + list.width / 2, list.y - 10)).toBe('page');
  await toasts(page).getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(view(page)).toBeHidden();
  expect(await under(page, ...at)).toBe('page');
});
