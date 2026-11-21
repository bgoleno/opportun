// The Inbox's own actions end to end (https://github.com/bgoleno/opportun/issues/690): Sync now
// with no reload (#645), Reject single and bulk with its confirmation (#647) and with a second
// session that linked a message meanwhile (#666), and a row's Reclassify and Link. Messages come
// in through the Apple Mail connector's batch route (bearer token, no browser), so each test owns
// exactly the rows it acts on; the server's AI fake classifies "Interview availability" mail as
// job-related scheduling for a Contoso role, which, with no Contoso opportunity, stays unlinked in
// Needs review. Runs in both CI legs (sqlite and postgres): the #666 guard is a conditional update
// whose worth is that it holds on both dialects.
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { connectGoogle, createOpportunity, PASSWORD, registerUser, toasts } from './helpers';

/** Creates a mail:push device token through Settings > Integrations and returns it. */
async function mailToken(page: Page): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Inbox e2e');
  await dialog.getByRole('checkbox', { name: /^Apple Mail connector/ }).setChecked(true);
  await dialog.getByRole('checkbox', { name: /^Browser capture/ }).setChecked(false);
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  await shown.getByRole('button', { name: 'I saved it' }).click();
  await expect(shown).toBeHidden();
  return token;
}

interface Msg {
  /** The row's accessible name. */
  subject: string;
  /** Unique per message: the row's checkbox is named after it. */
  from: string;
}

/**
 * Pushes unlinked Needs review messages through the connector, then waits until each is listed
 * in Needs review (classification runs in the job queue).
 */
async function seedNeedsReview(
  page: Page,
  request: APIRequestContext,
  tag: string,
  count: number,
): Promise<Msg[]> {
  const token = await mailToken(page);
  const msgs = Array.from({ length: count }, (_, i) => ({
    subject: `Interview availability ${tag} ${i + 1}`,
    from: `Recruiter ${tag}${i + 1} <r${i + 1}.${tag}@contoso.example>`,
  }));
  const res = await request.post('/api/v1/connector/mail/batch', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      messages: msgs.map((m, i) => ({
        externalId: `inbox-e2e-${tag}-${i + 1}`,
        threadKey: `thread-${tag}-${i + 1}`,
        from: m.from,
        to: ['me@example.com'],
        subject: m.subject,
        snippet: `Snippet ${tag} ${i + 1}`,
        bodyText: `Could we find a time to talk? (${tag} ${i + 1})`,
        sentAt: Date.now() - 60_000 * (i + 1),
      })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  await page.goto('/inbox');
  await expect(async () => {
    await page.reload();
    for (const m of msgs) {
      await expect(row(page, m)).toBeVisible({ timeout: 1000 });
    }
  }).toPass({ timeout: 30_000 });
  return msgs;
}

const row = (page: Page, m: Msg) => page.getByRole('listitem', { name: m.subject, exact: true });
const box = (page: Page, m: Msg) =>
  row(page, m).getByRole('checkbox', { name: `Select message from ${m.from}` });

/** The message as the API returns it, found by subject across every view. */
async function readMessage(request: APIRequestContext, subject: string) {
  const res = await request.get(
    `/api/v1/communications?view=all&limit=200&q=${encodeURIComponent(subject)}`,
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    items: {
      id: string;
      subject: string | null;
      snippet: string | null;
      opportunityId: string | null;
    }[];
  };
  return body.items.find((c) => c.subject === subject);
}

/** Links a row to the opportunity ("Company: Title") from its own Link button. */
async function linkFromRow(page: Page, m: Msg, opp: string) {
  const [company, title] = opp.split(': ') as [string, string];
  await row(page, m).getByRole('button', { name: 'Link to opportunity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Link to an opportunity' });
  await dialog.getByLabel('Search').fill(company);
  // A string name matches as a case-insensitive substring of the button's name.
  await dialog
    .getByRole('list', { name: 'Matching opportunities' })
    .getByRole('button', { name: title })
    .click();
  await expect(dialog).toBeHidden();
}

async function signedInAs(browser: Browser, email: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  return ctx;
}

test('Sync now: the new mail, the tab counts and the sync time show with no reload, then polling stops (#645)', async ({
  page,
}) => {
  await registerUser(page);
  // Rows already on screen when the sync's status changes: each must not add its own refresh of
  // the lists (qa's fail on #668 was one refresh per row's Open original).
  await seedNeedsReview(page, page.request, 's1', 5);
  await connectGoogle(page, 'Connect Gmail (read-only)');
  // Connected: the Gmail card offers a sync (and the callback's own navigation has settled).
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible();
  await page.goto('/inbox');
  await expect(page.getByText('Not synced yet')).toBeVisible();

  const statusReads: number[] = [];
  const listReads: number[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path === '/api/v1/integrations/gmail') statusReads.push(Date.now());
    if (path === '/api/v1/communications') listReads.push(Date.now());
  });

  await page.getByRole('button', { name: 'Sync now' }).click();
  // No reload and no tab switch: the fixture mailbox's mail, its tab counts and the sync time
  // come in on their own once classified.
  await expect(
    page.getByRole('listitem', { name: 'Staff Platform Engineer at Northwind Labs' }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('tab', { name: /^Needs review\s*\(?\d+\)?/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Spam\s*\(?1\)?/ })).toBeVisible();
  await expect(page.getByText(/^Synced /)).toBeVisible();

  // Then it stops asking: no status read for 10 s once everything has landed.
  await expect(async () => {
    const last = statusReads.at(-1) ?? 0;
    expect(Date.now() - last).toBeGreaterThan(10_000);
  }).toPass({ timeout: 2 * 60_000, intervals: [1000] });
  // And the lists were read a bounded number of times, not once per row on screen per status
  // answer (qa's fail on #668): five views per refresh, a handful of refreshes.
  expect(listReads.length).toBeLessThanOrEqual(5 * statusReads.length);
});

test('Reject: one selected row leaves, the confirmation counts what is left, Cancel sends nothing (#647)', async ({
  page,
}) => {
  await registerUser(page);
  await createOpportunity(page, { company: 'Initech', title: 'Platform Lead' });
  const [a, b] = await seedNeedsReview(page, page.request, 'r1', 2);

  await box(page, a!).check();
  await box(page, b!).check();
  await expect(page.getByText('2 selected')).toBeVisible();

  // A row linked from its own button leaves Needs review, and leaves the selection with it.
  await linkFromRow(page, a!, 'Initech: Platform Lead');
  await expect(row(page, a!)).toBeHidden();
  await expect(page.getByText('1 selected')).toBeVisible();

  let bulkCalls = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/communications/bulk') {
      bulkCalls += 1;
    }
  });
  await page.getByRole('button', { name: 'Reject 1', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Reject 1 message?' });
  await expect(confirm).toContainText('for good');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect(bulkCalls).toBe(0);
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Reject 1', exact: true }).click();
  await confirm.getByRole('button', { name: 'Reject 1' }).click();
  await expect(toasts(page).getByText('1 rejected')).toBeVisible();
  expect(bulkCalls).toBe(1);
  await expect(row(page, b!)).toBeHidden();

  // The linked one kept its content and its link; only the one still shown was rejected.
  const linked = await readMessage(page.request, a!.subject);
  expect(linked?.snippet).toBe('Snippet r1 1');
  expect(linked?.opportunityId).not.toBeNull();
  expect(await readMessage(page.request, b!.subject)).toBeUndefined();
});

test('Reject from two sessions: a message linked in the other leaves its content alone (#666)', async ({
  page,
  browser,
}) => {
  const email = await registerUser(page);
  await createOpportunity(page, { company: 'Initech', title: 'Platform Lead' });
  const [a, b] = await seedNeedsReview(page, page.request, 'r2', 2);
  await box(page, a!).check();
  await box(page, b!).check();
  await expect(page.getByText('2 selected')).toBeVisible();

  // The second session links A while this one still shows it selected (no refetch here).
  const other = await signedInAs(browser, email);
  try {
    const second = await other.newPage();
    await second.goto('/inbox');
    await linkFromRow(second, a!, 'Initech: Platform Lead');
  } finally {
    await other.close();
  }

  await page.getByRole('button', { name: 'Reject 2', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Reject 2 messages?' })
    .getByRole('button', { name: 'Reject 2' })
    .click();
  await expect(toasts(page).getByText('1 rejected')).toBeVisible();
  await expect(toasts(page).getByText('1 was changed elsewhere and left as it is.')).toBeVisible();

  const kept = await readMessage(page.request, a!.subject);
  expect(kept?.snippet).toBe('Snippet r2 1');
  expect(kept?.opportunityId).not.toBeNull();
  expect(await readMessage(page.request, b!.subject)).toBeUndefined();
});

test('a row: Reclassify takes it out of Needs review, Link moves it to Linked, a filter clears the selection', async ({
  page,
}) => {
  await registerUser(page);
  await createOpportunity(page, { company: 'Initech', title: 'Platform Lead' });
  const [a, b, c] = await seedNeedsReview(page, page.request, 'r3', 3);
  const needsReview = page.getByRole('tab', { name: /^Needs review/ });
  await expect(needsReview).toContainText('3');

  // Reclassify A as Other: no longer job-related, so it leaves Needs review, and the count drops.
  await row(page, a!).getByRole('button', { name: 'Reclassify' }).click();
  const reclassify = page.getByRole('dialog', { name: 'Reclassify message' });
  await reclassify.getByLabel('Type').selectOption({ label: 'Other' });
  await reclassify.getByRole('button', { name: 'Save' }).click();
  await expect(reclassify).toBeHidden();
  await expect(row(page, a!)).toBeHidden();
  await expect(needsReview).toContainText('2');

  // Link B: it moves to Linked, under its opportunity.
  await linkFromRow(page, b!, 'Initech: Platform Lead');
  await expect(row(page, b!)).toBeHidden();
  await page.getByRole('tab', { name: /^Linked/ }).click();
  await expect(row(page, b!)).toContainText('Initech');

  // A filter change clears a selection, though the row is still listed.
  await needsReview.click();
  await box(page, c!).check();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByLabel('Sender').fill('r3');
  await expect(row(page, c!)).toBeVisible();
  await expect(page.getByText('1 selected')).toBeHidden();
  await expect(box(page, c!)).not.toBeChecked();
});

test('a single Reject from a row wipes that one; a row linked elsewhere since is left as it is (#666)', async ({
  page,
  browser,
}) => {
  const email = await registerUser(page);
  await createOpportunity(page, { company: 'Initech', title: 'Platform Lead' });
  const [a, b] = await seedNeedsReview(page, page.request, 'r4', 2);

  // B: rejected from its own button, so only B goes.
  await row(page, b!).getByRole('button', { name: 'Reject' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reject this message' });
  await dialog.getByLabel('Why should this not be here?').selectOption({ index: 1 });
  const rejected = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/communications\/[^/]+\/reject$/.test(r.url()),
  );
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  // The answer, not the toast: the row's refetch can close the dialog before its success toast
  // shows (a known gap, raised on #672), so the toast is not something to wait for yet.
  expect((await rejected).status()).toBe(200);
  await expect(row(page, b!)).toBeHidden();
  expect(await readMessage(page.request, b!.subject)).toBeUndefined();
  expect((await readMessage(page.request, a!.subject))?.snippet).toBe('Snippet r4 1');

  // A: its dialog opened here, then linked in a second session before Reject is pressed. The
  // server refuses a reject of a message that changed since it was shown (409 message_changed),
  // so A keeps its content and its link.
  await row(page, a!).getByRole('button', { name: 'Reject' }).click();
  await dialog.getByLabel('Why should this not be here?').selectOption({ index: 1 });
  const other = await signedInAs(browser, email);
  try {
    const second = await other.newPage();
    await second.goto('/inbox');
    await linkFromRow(second, a!, 'Initech: Platform Lead');
  } finally {
    await other.close();
  }
  const answer = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/communications\/[^/]+\/reject$/.test(r.url()),
  );
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  expect((await answer).status()).toBe(409);
  const kept = await readMessage(page.request, a!.subject);
  expect(kept?.snippet).toBe('Snippet r4 1');
  expect(kept?.opportunityId).not.toBeNull();
});
