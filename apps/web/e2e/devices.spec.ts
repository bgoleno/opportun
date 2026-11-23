// Device tokens and the two programs that use them (FR-M5, FR-C5), against the live server.
// Tokens are created and revoked through Settings > Integrations > Extensions and Connectors; the
// Apple Mail connector and the capture extension are played by bearer-only API calls from the
// test (no Mac, no browser extension in CI), exactly as those programs call the server.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
// The synthetic LinkedIn profile capture the server's own capture tests use.
import { PROFILE } from '../../server/test/fixtures/capture/pages';
import { PASSWORD, registerUser } from './helpers';

type Scope = 'mail:push' | 'capture:push';
/** Each scope and the checkbox that grants it in the Create dialog. */
const SCOPE_BOXES: [Scope, RegExp][] = [
  ['mail:push', /^Apple Mail connector/],
  ['capture:push', /^Browser capture/],
];

/** Creates a device token through the Devices card and returns it as shown (once). */
async function createDeviceToken(page: Page, name: string, scopes: Scope[]): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill(name);
  for (const [scope, box] of SCOPE_BOXES) {
    await dialog.getByRole('checkbox', { name: box }).setChecked(scopes.includes(scope));
  }
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  expect(token).toMatch(/^odt_/);
  await shown.getByRole('button', { name: 'I saved it' }).click();
  await expect(shown).toBeHidden();
  await expect(page.getByRole('list', { name: 'Device tokens' })).toContainText(name);
  return token;
}

/** One message as the opportun-connector CLI pushes it (adapters/mailProvider InboundMessage). */
function inbound(externalId: string, subject: string) {
  return {
    externalId,
    threadKey: `thread-${externalId}`,
    from: 'Priya Shah <priya@northwind.example>',
    to: ['me@example.com'],
    subject,
    snippet: 'We are hiring a Staff Platform Engineer and your background fits.',
    bodyText:
      'Hi, we are hiring a Staff Platform Engineer at Northwind Labs and your background fits. Open to a chat?',
    sentAt: Date.now() - 60_000,
  };
}

/** POST /connector/mail/batch with the bearer token alone (no session cookie, no CSRF). */
function pushMail(request: APIRequestContext, token: string, messages: unknown[]) {
  return request.post('/api/v1/connector/mail/batch', {
    headers: { authorization: `Bearer ${token}` },
    data: { messages },
  });
}

test('device token: created with the password, shown once, revoked, then refused (FR-M5)', async ({
  page,
  playwright,
  baseURL,
}) => {
  await registerUser(page);
  // A wrong password mints nothing.
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Work MacBook');
  await dialog.getByLabel('Current password').fill('not my password');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByText('That is not your current password.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('No device tokens yet.')).toBeVisible();

  const token = await createDeviceToken(page, 'Work MacBook', ['mail:push']);
  // Shown once: neither the page nor the list API has it after the dialog closes.
  await page.reload();
  const row = page.getByRole('listitem', { name: 'Work MacBook' });
  await expect(row).toContainText('Apple Mail connector (mail:push)');
  await expect(page.locator('body')).not.toContainText(token);
  const list = await page.request.get('/api/v1/device-tokens');
  expect(list.ok()).toBe(true);
  expect(await list.text()).not.toContain(token);

  // A clean API context: the token is the only credential the "connector" presents.
  const connector = await playwright.request.newContext({ baseURL });
  try {
    const ok = await pushMail(connector, token, [inbound('lifecycle-1', 'Coffee next week?')]);
    expect(ok.status(), await ok.text()).toBe(200);
    expect(await ok.json()).toEqual({ stored: 1, inserted: 1 });
    // Write only: the token reads nothing.
    const read = await connector.get('/api/v1/communications', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect([401, 403]).toContain(read.status());

    await page.reload();
    await expect(row).toContainText('Last used');
    await row.getByRole('button', { name: 'Revoke' }).click();
    await page
      .getByRole('dialog', { name: 'Revoke Work MacBook?' })
      .getByRole('button', { name: 'Revoke' })
      .click();
    await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0);

    // Refused on the very next request, not at some expiry.
    const refused = await pushMail(connector, token, [inbound('lifecycle-2', 'Coffee again?')]);
    expect(refused.status()).toBe(401);
    expect(await refused.json()).toEqual({ error: { code: 'invalid_token' } });
  } finally {
    await connector.dispose();
  }
});

test('apple mail: a connector batch lands in the Inbox with the Apple Mail badge (FR-M5)', async ({
  page,
  playwright,
  baseURL,
}) => {
  await registerUser(page);
  const token = await createDeviceToken(page, 'Home Mac', ['mail:push']);
  const connector = await playwright.request.newContext({ baseURL });
  try {
    // The AI mock classifies this subject as targeted outreach for Northwind Labs.
    const message = inbound(`apple-${Date.now()}`, 'Staff Platform Engineer at Northwind Labs');
    const res = await pushMail(connector, token, [message]);
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual({ stored: 1, inserted: 1 });
    // A re-push of the same batch (the connector retrying) upserts, never duplicates.
    const again = await pushMail(connector, token, [message]);
    expect(await again.json()).toEqual({ stored: 1, inserted: 0 });
  } finally {
    await connector.dispose();
  }

  // The Devices card reports the batch.
  await page.reload();
  await expect(
    page.getByText(/^Apple Mail: connected, last batch .* \(1 message\)\.$/),
  ).toBeVisible();

  // Classification runs in the job queue; the inbox shows the message once it lands.
  await page.goto('/inbox');
  const item = page.getByRole('listitem', { name: 'Staff Platform Engineer at Northwind Labs' });
  await expect(async () => {
    await page.reload();
    await page.getByRole('tab', { name: /^Linked/ }).click();
    await expect(item).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(item.getByTitle('Source')).toHaveText('Apple Mail');
  await expect(page.getByRole('listitem', { name: /Northwind Labs/ })).toHaveCount(1);
});

// https://github.com/bgoleno/opportun/issues/904. The request reaches the server, which makes the
// token; its answer does not reach the page.
test('device token: one whose answer is lost is listed, and can be revoked', async ({ page }) => {
  await registerUser(page);
  await page.goto('/settings/integrations');
  await expect(page.getByText('No device tokens yet.')).toBeVisible();
  await page.route('**/api/v1/device-tokens', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const made = await route.fetch();
    expect(made.status()).toBe(201);
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Lost MacBook');
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(
    dialog.getByText(/^Could not confirm that "Lost MacBook" was created/),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByText(/^A token named "Lost MacBook" was created since then/),
  ).toBeVisible();
  const row = page.getByRole('listitem', { name: 'Lost MacBook' });
  await expect(row.getByText('Not shown here')).toBeVisible();
  await row.getByRole('button', { name: 'Revoke' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke Lost MacBook?' })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(row.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(page.getByText(/its value was not shown here/)).toBeHidden();
});

// qa on https://github.com/bgoleno/opportun/pull/918: the browser's own close event of the dialog reads
// the list again, and over a network the read before it is still out.
test('device token: a retry that works leaves nothing said, with a list that is slow to read', async ({
  page,
}) => {
  await registerUser(page);
  let first = true;
  await page.route('**/api/v1/device-tokens', async (route) => {
    if (route.request().method() === 'GET') {
      const answer = await route.fetch();
      await new Promise((r) => setTimeout(r, 300));
      // The page may have cancelled it meanwhile.
      return route.fulfill({ response: answer }).catch(() => undefined);
    }
    if (!first) return route.continue();
    first = false;
    await route.abort('connectionrefused');
  });
  await page.goto('/settings/integrations');
  await expect(page.getByText('No device tokens yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Second MacBook');
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(
    dialog.getByText(/^Could not confirm that "Second MacBook" was created/),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page
    .getByRole('dialog', { name: 'Copy your device token' })
    .getByRole('button', { name: 'I saved it' })
    .click();
  await expect(page.getByRole('listitem', { name: 'Second MacBook' })).toHaveCount(1);
  await expect(page.getByText(/^Could not confirm that/)).toHaveCount(0);
  await expect(page.getByText('Not shown here')).toHaveCount(0);
});

test('capture: a LinkedIn profile posted by the extension becomes a contact (FR-C5)', async ({
  page,
  playwright,
  baseURL,
}) => {
  await registerUser(page);
  const token = await createDeviceToken(page, 'Chrome extension', ['capture:push']);
  const extension = await playwright.request.newContext({ baseURL });
  try {
    const res = await extension.post('/api/v1/connector/capture', {
      headers: { authorization: `Bearer ${token}` },
      data: PROFILE,
    });
    // 201: a new contact (200 would mean an existing one was updated).
    expect(res.status(), await res.text()).toBe(201);
    expect(await res.json()).toMatchObject({ kind: 'profile', created: true });

    // A capture:push token cannot push mail: scopes are enforced per route.
    const wrongScope = await pushMail(extension, token, [inbound('scope-1', 'Hello')]);
    expect(wrongScope.status()).toBe(403);
  } finally {
    await extension.dispose();
  }

  await page.goto('/network');
  const contacts = page.getByRole('table', { name: 'Network' });
  await expect(contacts).toContainText('Dana Testworth');
  await expect(contacts.getByRole('row', { name: /Dana Testworth/ })).toContainText('Captured');
});

// qa on #918: one long word for a name (100 characters, the server's limit) pushed Revoke off the
// screen and the page sideways. A live row and a revoked one.
test('device token: a long unbroken name stays in its row, all of it, and Revoke stays on screen (#921)', async ({
  page,
}) => {
  await registerUser(page);
  const live = 'W'.repeat(100);
  const revoked = 'm'.repeat(100);
  await createDeviceToken(page, revoked, ['mail:push']);
  await page
    .getByRole('listitem', { name: revoked, exact: true })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(
    page
      .getByRole('listitem', { name: revoked, exact: true })
      .getByText('Revoked', { exact: true }),
  ).toBeVisible();
  await createDeviceToken(page, live, ['mail:push', 'capture:push']);

  for (const width of [375, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const measured = await page.evaluate(
      (names) => {
        const vw = document.documentElement.clientWidth;
        return {
          sideways: document.documentElement.scrollWidth - vw,
          rows: names.map((name) => {
            const row = [...document.querySelectorAll('ul[aria-label="Device tokens"] > li')].find(
              (li) => li.getAttribute('aria-label') === name,
            )!;
            const box = row.getBoundingClientRect();
            // Every line of the name, as drawn.
            const text = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            while (text.nextNode() !== null && text.currentNode.textContent !== name);
            const range = document.createRange();
            range.selectNodeContents(text.currentNode);
            const lines = [...range.getClientRects()];
            // Drawn in full: nothing between the name and the page clips it.
            let clipped = false;
            for (let el = text.currentNode.parentElement; el !== null; el = el.parentElement) {
              const cs = getComputedStyle(el);
              if (cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none') clipped = true;
              if (
                el !== document.documentElement &&
                el !== document.body &&
                cs.overflowX !== 'visible'
              ) {
                const b = el.getBoundingClientRect();
                if (lines.some((l) => l.right > b.right + 0.5)) clipped = true;
              }
            }
            return {
              rowRight: box.right,
              lines: lines.length,
              nameRight: Math.max(...lines.map((l) => l.right)),
              clipped,
              buttons: [...row.querySelectorAll('button')].map((b) => ({
                name: b.textContent,
                left: b.getBoundingClientRect().left,
                right: b.getBoundingClientRect().right,
              })),
            };
          }),
        };
      },
      [live, revoked],
    );
    const at = `at ${width} px: ${JSON.stringify(measured)}`;
    expect(measured.sideways, at).toBe(0);
    for (const r of measured.rows) {
      expect(r.rowRight, at).toBeLessThanOrEqual(width);
      expect(r.nameRight, at).toBeLessThanOrEqual(r.rowRight);
      expect(r.clipped, at).toBe(false);
    }
    const [revoke] = measured.rows[0]!.buttons;
    expect(revoke, at).toMatchObject({ name: 'Revoke' });
    expect(revoke!.left, at).toBeGreaterThanOrEqual(0);
    expect(revoke!.right, at).toBeLessThanOrEqual(measured.rows[0]!.rowRight);
  }
});
