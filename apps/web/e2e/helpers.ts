// Shared steps for the e2e flows. Every flow registers its own user through the UI, so each
// test sees only its own data on the shared server.
import { expect, type Locator, type Page } from '@playwright/test';

export const PASSWORD = 'correct horse battery staple';

let seq = 0;

/** Registers a fresh user through /register and lands on the dashboard. */
export async function registerUser(page: Page, name = 'Jane Example'): Promise<string> {
  seq += 1;
  const email = `e2e-${Date.now()}-${seq}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel(/Confirm/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  return email;
}

/**
 * The toast viewport (Radix Toast's "Notifications" region). Radix also copies each new toast's
 * text into a visually hidden live announcement outside this region for a moment, so an
 * unscoped getByText on toast text can match twice; scope toast assertions here.
 */
export function toasts(page: Page): Locator {
  return page.getByRole('region', { name: /^Notifications/ });
}

/** The kanban card for an opportunity ("Company: Title"). */
export function card(page: Page, company: string, title: string): Locator {
  return page.getByRole('article', { name: `${company}: ${title}`, exact: true });
}

/** Creates an opportunity from the pipeline's New opportunity dialog. */
export async function createOpportunity(
  page: Page,
  opp: { company: string; title: string; description?: string },
): Promise<void> {
  await page.goto('/pipeline');
  await page.getByRole('button', { name: 'New opportunity' }).click();
  const dialog = page.getByRole('dialog', { name: 'New opportunity' });
  await dialog.getByLabel('Company').fill(opp.company);
  await dialog.getByLabel('Title').fill(opp.title);
  if (opp.description !== undefined) {
    await dialog.getByLabel('Description').fill(opp.description);
  }
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, opp.company, opp.title)).toBeVisible();
}

/** Moves an opportunity through the stage menu on its pipeline card. */
export async function moveTo(
  page: Page,
  opp: { company: string; title: string },
  stage: string,
): Promise<void> {
  await page.goto('/pipeline');
  await page.getByRole('button', { name: `Move ${opp.company}: ${opp.title}` }).click();
  await page.getByRole('menuitem', { name: stage, exact: true }).click();
  await expect(page.getByRole('button', { name: `Move ${opp.company}: ${opp.title}` })).toHaveText(
    stage,
  );
}

/**
 * Connects Google through Settings > Integrations. The browser half of OAuth would leave for
 * accounts.google.com; here that request is answered with the redirect Google would send back
 * to the callback, and the server's Google fake (OPPORTUN_GMAIL_MOCK) exchanges the code.
 */
export async function connectGoogle(page: Page, button: string): Promise<void> {
  await page.route('https://accounts.google.com/**', async (route) => {
    const auth = new URL(route.request().url());
    const callback = new URL(auth.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('code', 'e2e-auth-code');
    callback.searchParams.set('state', auth.searchParams.get('state') ?? '');
    await route.fulfill({ status: 302, headers: { location: callback.toString() } });
  });
  await page.goto('/settings/integrations');
  await page.getByLabel('Client id').fill('e2e-client.apps.googleusercontent.com');
  await page.getByLabel('Client secret').fill('GOCSPX-e2e-client-secret');
  await page.getByRole('button', { name: 'Save client' }).click();
  const callback = page.waitForResponse((r) =>
    r.url().includes('/api/v1/integrations/google/callback'),
  );
  await page.getByRole('button', { name: button }).click();
  const res = await callback;
  expect(res.status(), await res.text().catch(() => '')).toBe(302);
  expect(res.headers().location ?? '').not.toContain('google=');
  await page.waitForURL((url) => url.pathname === '/settings/integrations');
}

/** Selects an option by its visible text in a native select found by label. */
export async function choose(scope: Page | Locator, label: string, option: string) {
  await scope.getByLabel(label, { exact: true }).selectOption({ label: option });
}
