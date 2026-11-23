// Shared steps for the e2e flows. Every flow registers its own user, so each test sees only its
// own data on the shared server.
import { readFile } from 'node:fs/promises';
import {
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { BASE_URL } from '../playwright.config';

export const PASSWORD = 'correct horse battery staple';

/**
 * The instance admin's signed-in session, stored once for the run by global-setup.ts, so specs
 * act as the admin without signing in through the form: each form sign-in spends the login limit
 * (10 per address and email in 15 minutes), and the run's spend is checked in
 * global-teardown.ts (#776). Sign the admin in through the form only to test sign-in itself.
 */
export function adminStorageState(): string {
  const path = process.env.E2E_ADMIN_STATE;
  if (path === undefined || path === '')
    throw new Error('E2E_ADMIN_STATE is not set: global-setup.ts did not run');
  return path;
}

/** A browser context signed in as the admin, from the stored session. */
export async function adminContext(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  return browser.newContext({ ...options, storageState: adminStorageState() });
}

/** Signs this page's context in as the admin, from the stored session, and opens the Dashboard. */
export async function signInAsAdmin(page: Page): Promise<void> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this run's own temp file
  const state = JSON.parse(await readFile(adminStorageState(), 'utf8')) as {
    cookies: Parameters<BrowserContext['addCookies']>[0];
  };
  await page.context().addCookies(state.cookies);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

let seq = 0;

/**
 * Registers a fresh user, signed in on this page, and lands on the dashboard. A brand-new account
 * is offered the first-run tour (FR-U11); every flow but the tour's own declines it with Not now,
 * which is what a user who wants to get on with it does.
 *
 * The account is made through the test server's sign-up shortcut (POST /__mock/auth/users,
 * apps/server/src/testSupport/mockAuth.ts), which writes exactly what POST /auth/register writes
 * but spends none of the 100 sign-in attempts an address has per 15 minutes: one form sign-up a
 * test spent most of them over the run (#776). `viaForm` signs up through /register instead, for
 * the specs that test sign-up itself.
 */
export async function registerUser(
  page: Page,
  name = 'Jane Example',
  opts: { keepTour?: boolean; viaForm?: boolean } = {},
): Promise<string> {
  seq += 1;
  const email = `e2e-${Date.now()}-${seq}@example.com`;
  if (opts.viaForm === true) {
    await page.goto('/register');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel(/Confirm/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
  } else {
    // page.request shares the page's cookies, so the session it is given signs the page in.
    const res = await page.request.post('/__mock/auth/users', {
      data: { email, password: PASSWORD, displayName: name },
    });
    expect(res.status(), `sign-up shortcut: ${await res.text()}`).toBe(201);
    await page.goto('/');
  }
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  if (opts.keepTour !== true) {
    const welcome = page.getByRole('dialog', { name: "Let's get your search running" });
    await welcome.getByRole('button', { name: 'Not now' }).click();
    await expect(welcome).toBeHidden();
  }
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

/**
 * Creates a device token with the browser-capture scope through Settings, as a user setting up
 * the extension does, so a test can post a captured page the way the extension would.
 */
export async function createCaptureToken(page: Page, password = PASSWORD): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Chrome extension');
  await dialog.getByRole('checkbox', { name: /^Browser capture/ }).setChecked(true);
  await dialog.getByLabel('Current password').fill(password);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  await shown.getByRole('button', { name: 'I saved it' }).click();
  return token;
}

const STUB = '<!doctype html><title>Stub ATS</title><h1>Stub application form</h1>';

/**
 * Answers every request to a host other than the test server with a stub page, so nothing leaves
 * the machine: a handoff's new tab never reaches a real ATS (Opportun never submits; the e2e
 * never even visits).
 */
export async function stubOtherHosts(context: BrowserContext, base = BASE_URL): Promise<void> {
  await context.route(
    (url) => !url.href.startsWith(base),
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: STUB }),
  );
}

/** Registers a base resume from a Google Doc link on /resumes (OPPORTUN_DOCS_MOCK). */
export async function registerBaseResume(page: Page, docId: string): Promise<void> {
  await page.goto('/resumes');
  await page.getByLabel('Google Doc link').fill(`https://docs.google.com/document/d/${docId}/edit`);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('link', { name: 'Jane Example Base Resume' })).toBeVisible();
}

/**
 * An opportunity whose posting the server will confirm on a recognised Greenhouse board, the path
 * a user takes: the extension captures the LinkedIn job page, and the posting job
 * (posting.reconcile, every second here) finds the same job on the company's board (the
 * OPPORTUN_SOURCE_MOCK fixture: boards.greenhouse.io/vandelay/jobs/1002), which names the ATS and
 * the requisition. The LinkedIn page itself is never fetched: the capture carries it. Returns the
 * opportunity's id; the caller waits for the confirmation in whatever its page shows.
 */
export async function captureGreenhouseOpportunity(
  page: Page,
  playwright: PlaywrightWorkerArgs['playwright'],
  server: { baseURL: string; password: string } = { baseURL: BASE_URL, password: PASSWORD },
): Promise<string> {
  const token = await createCaptureToken(page, server.password);
  const extension = await playwright.request.newContext({ baseURL: server.baseURL });
  try {
    const res = await extension.post('/api/v1/connector/capture', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        url: 'https://www.linkedin.com/jobs/view/3901234599/',
        title: 'Staff Platform Engineer | Vandelay Industries | LinkedIn',
        text: [
          'Vandelay Industries',
          'Staff Platform Engineer',
          'Remote (US) · 2 days ago',
          'Full-time',
          'About the job',
          'Lead our Go platform on Kubernetes. Terraform and on-call leadership a plus.',
          'About the company',
          'Vandelay Industries',
        ].join('\n'),
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { kind: string; opportunityId: string };
    expect(body.kind).toBe('job');
    return body.opportunityId;
  } finally {
    await extension.dispose();
  }
}
