// An opportunity's own data end to end (https://github.com/bgoleno/opportun/issues/691): the
// Details tab's posting link and attachments and a timeline note, a password change ending the
// user's other sessions, and Settings > Data's export imported again into another account. Runs in
// both CI legs (sqlite and postgres); the export and import go through the dialect layer.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { card, createOpportunity, moveTo, PASSWORD, registerUser, toasts } from './helpers';
import { readZip } from './zip';

/** Opens an opportunity from its pipeline card and returns its id (from the URL). */
async function openOpportunity(page: Page, company: string, title: string): Promise<string> {
  await page.goto('/pipeline');
  await card(page, company, title).getByRole('link').first().click();
  await page.waitForURL(/\/opportunities\/[^/]+$/);
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

/** A POST, PATCH or DELETE through the page's session, with its CSRF token. */
async function csrfHeaders(ctx: BrowserContext): Promise<Record<string, string>> {
  const csrf = (await ctx.cookies()).find((c) => c.name === 'opportun_csrf')?.value ?? '';
  return { 'x-csrf-token': csrf };
}

async function signedInAs(browser: Browser, email: string, password = PASSWORD) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  return { ctx, page };
}

test('Details: the posting link is saved, a file is attached, opened and deleted, and a note is added', async ({
  page,
}) => {
  await registerUser(page);
  await createOpportunity(page, { company: 'Initech', title: 'Platform Lead' });
  const id = await openOpportunity(page, 'Initech', 'Platform Lead');

  // The posting link: a value that is not a link is refused, a link is saved and read back.
  await page.getByRole('tab', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Edit link' }).click();
  await page.getByLabel('Posting link').fill('not a link');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('Posting link')).toBeVisible();
  const link = 'https://jobs.initech.example/platform-lead';
  await page.getByLabel('Posting link').fill(link);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('Posting link')).toBeHidden();
  const saved = await page.request.get(`/api/v1/opportunities/${id}`);
  expect(((await saved.json()) as { postingUrl: string | null }).postingUrl).toBe(link);
  await page.reload();
  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page.getByRole('link', { name: /jobs\.initech\.example/ })).toBeVisible();

  // An attachment: uploaded, listed, opened with its own bytes, then deleted.
  const bytes = Buffer.from('%PDF-1.4\n% qa attachment for #691\n%%EOF\n');
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: 'offer-letter.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(toasts(page).getByText('File attached')).toBeVisible();
  const fileLink = page.getByRole('link', { name: /offer-letter\.pdf/ });
  await expect(fileLink).toBeVisible();
  const href = await fileLink.getAttribute('href');
  const opened = await page.request.get(href!);
  expect(opened.status()).toBe(200);
  expect(Buffer.from(await opened.body()).equals(bytes)).toBe(true);
  await page.getByRole('button', { name: 'Delete offer-letter.pdf' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(fileLink).toBeHidden();
  expect((await page.request.get(href!)).status()).toBe(404);

  // A note on the timeline, listed and still there after a reload.
  await page.getByRole('tab', { name: 'Timeline' }).click();
  const composer = page.getByRole('form', { name: 'Add to timeline' });
  await composer.getByLabel('Type').selectOption('note');
  await composer.getByLabel('Title').fill('Call with the hiring manager');
  await composer.getByLabel('Details').fill('They want someone to own the platform roadmap.');
  await composer.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Call with the hiring manager')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Call with the hiring manager')).toBeVisible();
});

test('a password change signs out the other session, and only the new password signs in (#561)', async ({
  page,
  browser,
}) => {
  const email = await registerUser(page);
  const other = await signedInAs(browser, email);
  try {
    await page.goto('/settings/security');
    await page.getByLabel('Current password').fill(PASSWORD);
    const fresh = 'a brand new passphrase for 691';
    await page.getByLabel('New password', { exact: true }).fill(fresh);
    await page.getByLabel('Confirm new password').fill(fresh);
    await page.getByRole('button', { name: /^Change password/ }).click();
    await expect(toasts(page).getByText('Password changed')).toBeVisible();

    // This session stays signed in.
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();

    // The other one is signed out: its next request is refused and it lands on /login.
    expect((await other.page.request.get('/api/v1/auth/me')).status()).toBe(401);
    await other.page.goto('/pipeline');
    await other.page.waitForURL((url) => url.pathname === '/login');

    // The old password is refused; the new one signs in.
    await other.page.getByLabel('Email').fill(email);
    await other.page.getByLabel('Password').fill(PASSWORD);
    await other.page.getByRole('button', { name: 'Sign in' }).click();
    await expect(other.page.getByRole('alert')).toBeVisible();
    await expect(other.page).toHaveURL(/\/login/);
    await other.page.getByLabel('Password').fill(fresh);
    await other.page.getByRole('button', { name: 'Sign in' }).click();
    // Back where it was sent from when it was signed out.
    await expect(other.page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible();
  } finally {
    await other.ctx.close();
  }
});

test('Settings > Data: the export holds what was entered, and imported into another account gives the same opportunities', async ({
  page,
  browser,
  context,
}) => {
  await registerUser(page);
  const opps = [
    { company: 'Initech', title: 'Platform Lead' },
    { company: 'Globex', title: 'Staff Engineer' },
    { company: 'Hooli', title: 'Engineering Manager' },
  ];
  for (const o of opps) await createOpportunity(page, o);
  await moveTo(page, opps[0]!, 'Applied');
  await moveTo(page, opps[1]!, 'In process');
  const id = await openOpportunity(page, 'Hooli', 'Engineering Manager');
  const headers = await csrfHeaders(context);
  const link = 'https://jobs.hooli.example/em-42';
  const patched = await page.request.patch(`/api/v1/opportunities/${id}`, {
    headers,
    data: { postingUrl: link, location: 'Remote (US)' },
  });
  expect(patched.status(), await patched.text()).toBe(200);
  const note = await page.request.post(`/api/v1/opportunities/${id}/activities`, {
    headers,
    data: { kind: 'note', title: 'Export probe note', bodyMd: 'A note the export must keep.' },
  });
  expect(note.status(), await note.text()).toBe(201);
  const contact = await page.request.post('/api/v1/network', {
    headers,
    data: { name: 'Priya Export', company: 'Initech' },
  });
  expect(contact.status(), await contact.text()).toBe(201);

  // The export: opportunities.csv in the import format, export.json with every table of the
  // user's own data, and none of the tables that hold credentials.
  const res = await page.request.get('/api/v1/export');
  expect(res.status()).toBe(200);
  const zipBytes = Buffer.from(await res.body());
  const files = readZip(zipBytes);
  const csv = files['opportunities.csv']!.toString('utf8');
  for (const o of opps) expect(csv).toContain(`${o.company},${o.title}`);
  expect(csv).toContain(link);
  const dump = files['export.json']!.toString('utf8');
  expect(dump).toContain('A note the export must keep.');
  expect(dump).toContain('Priya Export');
  const tables = Object.keys(
    (JSON.parse(dump) as { tables?: Record<string, unknown> }).tables ?? JSON.parse(dump),
  );
  for (const secret of ['secrets', 'sessions', 'oauth_accounts', 'device_tokens']) {
    expect(tables).not.toContain(secret);
  }

  // Imported into a second account: the same opportunities, at the same stages, with the link.
  const second = await browser.newContext();
  try {
    const b = await second.newPage();
    await registerUser(b, 'Sam Import');
    const importOnce = async () => {
      await b.goto('/settings/data');
      await b
        .getByLabel('Zip file', { exact: true })
        .setInputFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: zipBytes });
      await b.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(b.getByText('Every row imported cleanly.')).toBeVisible({ timeout: 30_000 });
    };
    await importOnce();
    const list = async () =>
      (
        (await (await b.request.get('/api/v1/opportunities?limit=200')).json()) as {
          items: {
            title: string;
            stage: string;
            postingUrl: string | null;
            location: string | null;
          }[];
        }
      ).items;
    const imported = await list();
    expect(imported.map((o) => o.title).sort()).toEqual(opps.map((o) => o.title).sort());
    const byTitle = new Map(imported.map((o) => [o.title, o]));
    expect(byTitle.get('Platform Lead')?.stage).toBe('applied');
    expect(byTitle.get('Staff Engineer')?.stage).toBe('in_process');
    expect(byTitle.get('Engineering Manager')?.postingUrl).toBe(link);
    expect(byTitle.get('Engineering Manager')?.location).toBe('Remote (US)');
    // The first account's own data never reached the second.
    const contacts = await (await b.request.get('/api/v1/network')).text();
    expect(contacts).not.toContain('Priya Export');

    // Importing the same export again changes nothing.
    await importOnce();
    expect((await list()).length).toBe(opps.length);
  } finally {
    await second.close();
  }
});
