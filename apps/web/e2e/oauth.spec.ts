// OAuth sign-in (FR-S4) end to end: an admin configures GitHub sign-in, a member links their
// GitHub account from Settings > Security, signs out, signs back in with "Continue with
// GitHub", and unlinks it; a 2FA-enabled member signing in with GitHub still gets the code
// step (OAuth replaces only the password). The provider's consent page is intercepted here and answered with
// the redirect GitHub would send; the server's OAuth mock (OPPORTUN_OAUTH_MOCK) plays the
// token and userinfo endpoints for the identity encoded in the code.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
// The server's own TOTP implementation computes the codes an authenticator app would show.
import { totpCode } from '../../server/src/lib/totp';
import { mockOAuthCode, type MockOAuthIdentity } from '../../server/src/testSupport/mockOAuth';
import { ADMIN } from './global-setup';
import { PASSWORD, registerUser, toasts } from './helpers';

/** The redirect GitHub would send back to the callback after consent, as `identity`. */
function callbackFor(authorizeUrl: string, identity: MockOAuthIdentity): string {
  const auth = new URL(authorizeUrl);
  expect(auth.origin + auth.pathname).toBe('https://github.com/login/oauth/authorize');
  const callback = new URL(auth.searchParams.get('redirect_uri') ?? '');
  callback.searchParams.set('code', mockOAuthCode(identity));
  callback.searchParams.set('state', auth.searchParams.get('state') ?? '');
  return callback.toString();
}

/**
 * Plays GitHub's consent page as `identity`. Linking navigates to github.com directly (after
 * the password-confirmed POST), so that navigation is answered with the callback redirect.
 * Sign-in goes through the app's /start redirect, which Playwright cannot intercept at the
 * far end, so /start is intercepted instead: it runs for real (signed state, binding
 * cookie), and its redirect is rewritten to the callback.
 */
async function fakeGithubConsent(page: Page, identity: MockOAuthIdentity): Promise<void> {
  await page.route('https://github.com/login/oauth/authorize**', async (route) => {
    await route.fulfill({
      status: 302,
      headers: { location: callbackFor(route.request().url(), identity) },
    });
  });
  await page.route('**/api/v1/auth/oauth/github/start**', async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const callback = callbackFor(res.headers().location ?? '', identity);
    const setCookie = res
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value)
      .join('\n');
    await route.fulfill({
      status: 302,
      headers: { location: callback, 'set-cookie': setCookie },
    });
  });
}

/**
 * The instance admin, signed in once for this file in a context of its own and kept for its
 * tests: the suite signs the admin in from several files, and each sign-in counts against the
 * login limit (10 per address and email in 15 minutes, routes/auth.ts LOGIN_LIMIT), which a
 * sign-in per test here pushed the whole run past (#749).
 */
let adminContext: BrowserContext | undefined;
async function adminPage(browser: Browser): Promise<Page> {
  if (adminContext === undefined) {
    adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await admin.goto('/login');
    await admin.getByLabel('Email').fill(ADMIN.email);
    await admin.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await admin.getByRole('button', { name: 'Sign in' }).click();
    await expect(admin.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    return admin;
  }
  return adminContext.pages()[0] ?? (await adminContext.newPage());
}

test.afterAll(async () => {
  await adminContext?.close();
  adminContext = undefined;
});

/** Configures GitHub sign-in as the instance admin. */
async function configureGithubSignIn(browser: Browser): Promise<void> {
  const admin = await adminPage(browser);
  await admin.goto('/settings/users');
  const github = admin.getByRole('region', { name: 'GitHub sign-in' });
  await expect(github.getByLabel('Redirect URI', { exact: true })).toHaveValue(
    /\/api\/v1\/auth\/oauth\/github\/callback$/,
  );
  await github.getByLabel('Client ID').fill('e2e-github-client');
  await github.getByLabel('Client secret').fill('e2e-github-secret');
  await github.getByRole('button', { name: 'Save' }).click();
  // A change to who can sign in asks for the admin's own password (#620 point 3).
  const confirm = admin.getByRole('dialog', { name: 'Confirm your password' });
  await confirm.getByLabel('Current password').fill(ADMIN.password);
  await confirm.getByRole('button', { name: 'Continue' }).click();
  await expect(github.getByText('Configured')).toBeVisible();
}

test('sign in with GitHub: admin configures, member links, signs in, unlinks (FR-S4)', async ({
  page,
  browser,
}) => {
  await configureGithubSignIn(browser);

  const email = await registerUser(page, 'Octo Member');
  // The provider reports an UNVERIFIED address: linking from a signed-in session does not
  // depend on it, and signing in later matches the link, not the email.
  const identity = { id: String(Date.now()), email, emailVerified: false };
  await fakeGithubConsent(page, identity);
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Link GitHub' }).click();
  const confirmLink = page.getByRole('dialog', { name: 'Confirm your password' });
  await confirmLink.getByLabel('Current password').fill(PASSWORD);
  await confirmLink.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/security');
  await expect(page.getByText('Account linked. You can now sign in with it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlink GitHub' })).toBeVisible();

  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // Someone else's GitHub account with the member's address, unverified, gets nowhere.
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');
  await page.unrouteAll();
  await fakeGithubConsent(page, { id: `${identity.id}9`, email, emailVerified: false });
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page.getByText(/No account here matches that sign-in/)).toBeVisible();
  await expect(page).toHaveURL(/\/login\?oauth=unknown$/);

  // Even a VERIFIED address on another GitHub account never links or signs in (no email-based
  // password reset exists here, so a mailbox is not a key to the account).
  await page.unrouteAll();
  await fakeGithubConsent(page, { id: `${identity.id}8`, email, emailVerified: true });
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/login\?oauth=existing_account$/);
  await expect(page.getByText(/This email already has an account here/)).toBeVisible();

  // Back in with the password, unlink with the password.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Unlink GitHub' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm your password' });
  await confirm.getByLabel('Current password').fill(PASSWORD);
  await confirm.getByRole('button', { name: 'Continue' }).click();
  await expect(toasts(page).getByText('GitHub unlinked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Link GitHub' })).toBeVisible();
});

test('sign in with GitHub on a 2FA account still asks for the code (FR-S3, FR-S4)', async ({
  page,
  browser,
}) => {
  await configureGithubSignIn(browser);
  const email = await registerUser(page, 'Octo Twofactor');
  await fakeGithubConsent(page, { id: `${Date.now()}7`, email, emailVerified: true });
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Link GitHub' }).click();
  const confirmLink = page.getByRole('dialog', { name: 'Confirm your password' });
  await confirmLink.getByLabel('Current password').fill(PASSWORD);
  await confirmLink.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Unlink GitHub' })).toBeVisible();

  await page.getByRole('button', { name: 'Enable two-factor' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm your password' });
  await confirm.getByLabel('Current password').fill(PASSWORD);
  await confirm.getByRole('button', { name: 'Continue' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up two-factor sign-in' });
  const secret = await setup.getByLabel('Setup key', { exact: true }).inputValue();
  // Pinned time steps, as in the core two-factor flow: activate with step S, sign in with S+1.
  const STEP_MS = 30_000;
  const step = Math.floor(Date.now() / STEP_MS);
  await setup.getByLabel('Code from the app').fill(totpCode(secret, step * STEP_MS));
  await setup.getByRole('button', { name: 'Turn on' }).click();
  await page.getByRole('button', { name: 'I saved them' }).click();

  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');

  // OAuth replaces the password, not the second factor.
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor sign-in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeHidden();
  // The pending token travels in the fragment and is taken off the address bar.
  await expect(page).not.toHaveURL(/pending2fa/);
  expect(
    Math.floor(Date.now() / STEP_MS) - step,
    'sign-in must follow activation within the TOTP window',
  ).toBeLessThanOrEqual(2);
  await page.getByLabel('Authentication code').fill(totpCode(secret, (step + 1) * STEP_MS));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
});

// #602 (qa's e2e survey, gap 4, issue #749): an admin's reset of a member's password also
// unlinks every sign-in provider, so a reset meant to lock someone out is not undone by the
// GitHub sign-in they linked. Before the reset, GitHub signs the member in; after it, the same
// GitHub account matches no one, and Settings > Security offers Link again.
test('an admin password reset also unlinks GitHub sign-in (#602)', async ({ page, browser }) => {
  await configureGithubSignIn(browser);
  const name = 'Octo Reset';
  const email = await registerUser(page, name);
  const identity = { id: `${Date.now()}5`, email, emailVerified: false };
  await fakeGithubConsent(page, identity);
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Link GitHub' }).click();
  const confirmLink = page.getByRole('dialog', { name: 'Confirm your password' });
  await confirmLink.getByLabel('Current password').fill(PASSWORD);
  await confirmLink.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'Unlink GitHub' })).toBeVisible();

  // Linked: GitHub signs the member in.
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // The admin resets the member's password from Settings > Users.
  const admin = await adminPage(browser);
  await admin.goto('/settings/users');
  await admin
    .getByRole('row')
    .filter({ hasText: email })
    .getByRole('button', { name: `Reset password for ${name}` })
    .click();
  const confirm = admin.getByRole('dialog', { name: 'Confirm your password' });
  await confirm.getByLabel('Current password').fill(ADMIN.password);
  await confirm.getByRole('button', { name: 'Continue' }).click();
  const shown = admin.getByRole('dialog', { name: 'Temporary password' });
  const temporary = await shown
    .getByLabel(`Temporary password for ${name}`, { exact: true })
    .inputValue();
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(shown).toBeHidden();

  // The reset ended the member's session; the same GitHub account no longer signs anyone in.
  await page.reload();
  await page.waitForURL((url) => url.pathname === '/login');
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/login\?oauth=unknown$/);
  await expect(page.getByText(/No account here matches that sign-in/)).toBeVisible();

  // With the temporary password the member is in, and GitHub reads as not linked.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(temporary);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/settings/security');
  await expect(page.getByRole('button', { name: 'Link GitHub' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlink GitHub' })).toHaveCount(0);
});
