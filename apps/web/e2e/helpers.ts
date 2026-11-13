// Shared steps for the e2e flows. Every flow registers its own user through the UI, so each
// test sees only its own data on the shared server.
import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { BASE_URL } from '../playwright.config';

export const PASSWORD = 'correct horse battery staple';

let seq = 0;

/**
 * Registers a fresh user through /register and lands on the dashboard. A brand-new account is
 * offered the first-run tour (FR-U11); every flow but the tour's own declines it with Not now,
 * which is what a user who wants to get on with it does.
 */
export async function registerUser(
  page: Page,
  name = 'Jane Example',
  opts: { keepTour?: boolean } = {},
): Promise<string> {
  seq += 1;
  const email = `e2e-${Date.now()}-${seq}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel(/Confirm/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
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
export async function createCaptureToken(page: Page): Promise<string> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Chrome extension');
  await dialog.getByRole('checkbox', { name: /^Browser capture/ }).setChecked(true);
  await dialog.getByLabel('Current password').fill(PASSWORD);
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
export async function stubOtherHosts(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => !url.href.startsWith(BASE_URL),
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
): Promise<string> {
  const token = await createCaptureToken(page);
  const extension = await playwright.request.newContext({ baseURL: BASE_URL });
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
