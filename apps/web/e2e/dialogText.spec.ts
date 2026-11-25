// Dialogs that carry someone's words, a message's subject and addresses, an opportunity's title, a
// job site's posting, hold one long unbroken one inside them
// (https://github.com/bgoleno/opportun/issues/921, https://github.com/bgoleno/opportun/issues/954).
// The Revoke confirmation is in devices.spec.ts. The lists are answered here: what is measured is the
// dialogs, not how a message or a posting got its text.
import { expect, test, type Page } from '@playwright/test';
import { fit } from './dialogFit';
import { registerUser } from './helpers';

const WIDTHS = [375, 768, 1280, 1920];

const SUBJECT = 'S'.repeat(120);
const TITLE = 'T'.repeat(120);

const MESSAGE = {
  id: 'c1',
  channel: 'apple_mail',
  externalId: 'x1',
  threadKey: 't1',
  direction: 'inbound',
  from: `Recruiter <${'f'.repeat(100)}@example.com>`,
  to: [`${'t'.repeat(100)}@example.com`],
  subject: SUBJECT,
  snippet: 'Snippet',
  classification: 'scheduling',
  classificationConfidence: 0.9,
  outreachKind: null,
  sentAt: Date.now() - 60_000,
  createdAt: Date.now() - 60_000,
  contactId: null,
  opportunityId: 'o1',
  opportunityTitle: TITLE,
  companyName: 'Contoso',
  opportunityStage: 'dismissed',
  needsReview: true,
  proposedTransition: 'in_process',
};

async function openInbox(page: Page, over: Partial<typeof MESSAGE> = {}) {
  await page.route(/\/api\/v1\/communications\?/, async (route) => {
    const here = new URL(route.request().url()).searchParams.get('view') === 'needs_review';
    await route.fulfill({
      json: { items: here ? [{ ...MESSAGE, ...over }] : [], total: here ? 1 : 0 },
    });
  });
  await page.goto('/inbox');
  const row = page.getByRole('listitem', { name: over.subject ?? SUBJECT, exact: true });
  await expect(row).toBeVisible();
  return row;
}

for (const width of WIDTHS) {
  test(`a long unbroken subject and title stay inside their dialogs, at ${width} px (#921)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await registerUser(page);
    const row = await openInbox(page);
    for (const [button, name] of [
      ['Open', SUBJECT],
      ['Reopen and move', `Reopen ${TITLE}?`],
    ] as const) {
      await row.getByRole('button', { name: button, exact: true }).click();
      const dialog = page.getByRole('dialog', { name });
      await expect(dialog).toBeVisible();
      const measured = await fit(dialog);
      expect(measured, `${button}: ${JSON.stringify(measured)}`).toEqual({
        sideways: 0,
        outside: [],
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });
}

// 100 characters each, the longest word of https://github.com/bgoleno/opportun/issues/954.
const WORD = 'W'.repeat(100);
const COMPANY = `Contoso${'C'.repeat(93)}`;

/** Everything in the open dialog `name` stays inside it, at each width. */
async function holds(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const measured = await fit(dialog);
    expect
      .soft(measured, `${name} at ${width} px: ${JSON.stringify(measured)}`)
      .toEqual({ sideways: 0, outside: [] });
  }
}

const POSTING = {
  company: 'Contoso',
  title: 'Engineer',
  descriptionMd: 'Words.',
  postingUrl: 'https://jobs.example/1',
  location: 'Remote',
  remote: true,
  compNote: null,
  externalId: 'x1',
  postedAt: null,
};

/** The review queue with one result, opened on its own dialog. */
async function openResult(page: Page, posting: Record<string, unknown>, aiRationale = 'Fits.') {
  const result = {
    id: 'r1',
    runId: 'run',
    sourceId: 'src',
    sourceKind: 'ats_greenhouse',
    roleTargetId: null,
    dedupeKey: 'a|b|c',
    aiScore: 91,
    aiRationale,
    rankSkipReason: null,
    rankDeferredAt: null,
    rankBatchSentAt: null,
    prefilterOutcome: null,
    prefilterRule: null,
    resolution: 'needs_capture',
    resolvedSourceRef: null,
    disposition: 'pending',
    opportunityId: null,
    sourceMailChannel: null,
    sourceMailExternalId: null,
    dismissReason: null,
    dismissNote: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    posting: { ...POSTING, ...posting },
  };
  await page.route(/\/api\/v1\/discovery\/results\?/, async (route) => {
    if (route.request().method() !== 'GET') return await route.fallback();
    const here = new URL(route.request().url()).searchParams.get('disposition') === 'pending';
    await route.fulfill({ json: { items: here ? [result] : [], total: here ? 1 : 0 } });
  });
  await page.goto('/discovery');
  await reopenResult(page, result.posting.title);
}

const reopenResult = (page: Page, title: string) =>
  page.getByRole('button', { name: title, exact: true }).click();

const press = (page: Page, name: string) =>
  page.getByRole('dialog').getByRole('button', { name, exact: true }).click();

test('a posting with a long unbroken title and company stays inside Discovery’s dialogs (#954)', async ({
  page,
}) => {
  await registerUser(page);
  await openResult(page, { title: WORD, company: COMPANY });
  await holds(page, WORD);
  await press(page, 'Capture description');
  await holds(page, 'Capture description');
  await press(page, 'Cancel');
  await reopenResult(page, WORD);
  await press(page, 'Dismiss');
  await holds(page, 'Dismiss result');
  await press(page, 'Cancel');
  await page.route(/\/api\/v1\/discovery\/results\/r1\/accept/, (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'duplicate', message: 'Already tracked', existingId: 'o1' } },
    }),
  );
  await reopenResult(page, WORD);
  await press(page, 'Accept');
  await holds(page, 'Already in your pipeline?');
});

for (const field of ['location', 'compNote', 'descriptionMd', 'aiRationale'] as const) {
  test(`a posting’s long unbroken ${field} stays inside its dialog (#954)`, async ({ page }) => {
    await registerUser(page);
    if (field === 'aiRationale') await openResult(page, {}, WORD);
    else await openResult(page, { [field]: WORD });
    await holds(page, POSTING.title);
  });
}

async function opportunity(page: Page, companyName: string, title: string): Promise<string> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'opportun_csrf')?.value;
  const res = await page.request.post('/api/v1/opportunities?force=true', {
    headers: { 'x-csrf-token': csrf ?? '' },
    data: { companyName, title, sourceKind: 'manual' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

for (const [what, company, posting] of [
  ['company', COMPANY, {}],
  ['candidate’s title', 'Contoso', { title: WORD }],
  ['candidate’s location', 'Contoso', { location: WORD }],
  ['candidate’s description', 'Contoso', { descriptionMd: WORD }],
  ['candidate’s link', 'Contoso', { postingUrl: `https://jobs.example/${WORD}` }],
] as const) {
  test(`a long unbroken ${what} stays inside Find posting’s dialog (#954)`, async ({ page }) => {
    await registerUser(page);
    const id = await opportunity(page, company, 'Engineer');
    const candidate = { posting: { ...POSTING, ...posting }, score: 0.8, otherLocations: [] };
    await page.route(/\/find-posting/, (route) =>
      route.fulfill({
        json: { outcome: 'candidates', candidates: [candidate], board: [candidate] },
      }),
    );
    await page.goto(`/opportunities/${id}`);
    await page.getByRole('tab', { name: 'Details' }).click();
    await page.getByRole('button', { name: 'Find posting' }).click();
    await holds(page, 'Add the posting');
  });
}

const matches = (page: Page) =>
  page.getByRole('list', { name: 'Matching opportunities' }).getByRole('button');

test('long unbroken titles and companies stay inside the Merge dialogs (#954)', async ({
  page,
}) => {
  await registerUser(page);
  const id = await opportunity(page, 'Contoso', WORD);
  await opportunity(page, COMPANY, 'Engineer');
  await opportunity(page, 'Contoso', TITLE);
  await page.goto(`/opportunities/${id}`);
  await page.getByRole('button', { name: /More/ }).click();
  await page.getByRole('menuitem', { name: 'Merge into...' }).click();
  await expect(matches(page)).toHaveCount(2);
  await holds(page, 'Merge into another opportunity');
  await matches(page).filter({ hasText: COMPANY }).click();
  await holds(page, 'Merge these opportunities?');
});

test('long unbroken titles and companies stay inside the Link dialog (#954)', async ({ page }) => {
  await registerUser(page);
  await opportunity(page, 'Contoso', WORD);
  await opportunity(page, COMPANY, 'Engineer');
  const row = await openInbox(page, { subject: 'Hello' });
  await row.getByRole('button', { name: 'Change link' }).click();
  await expect(matches(page)).toHaveCount(2);
  await holds(page, 'Link to an opportunity');
});

test('a message’s long unbroken words never make the Inbox scroll sideways (#954)', async ({
  page,
}) => {
  await registerUser(page);
  // A 170-character subject, and the opportunity it is linked to ("Linked to").
  await openInbox(page, {
    subject: 'S'.repeat(170),
    snippet: 'n'.repeat(170),
    opportunityTitle: WORD,
    companyName: COMPANY,
  });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect.soft(sideways, `${width} px`).toBe(0);
  }
});
