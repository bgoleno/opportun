// Critical flows (NFR-QLT1) against the built SPA and the real server, with AI, Google Docs
// and Gmail served by the server's env-gated fakes (see playwright.config.ts).
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ADMIN } from './global-setup';
// The server's own TOTP implementation computes the codes an authenticator app would show.
import { totpCode } from '../../server/src/lib/totp';
import {
  card,
  choose,
  connectGoogle,
  createOpportunity,
  moveTo,
  PASSWORD,
  registerUser,
  toasts,
} from './helpers';

const PACK_DIR = fileURLToPath(new URL('./fixtures/pack', import.meta.url));

test('register, set up, track opportunities, and see correct dashboard counts', async ({
  page,
}) => {
  await registerUser(page);

  // Onboarding: the first-run setup the install guide walks through (profile, role target).
  await page.goto('/settings/profile');
  await page.getByLabel('Full name').fill('Jane Example');
  await page.getByLabel('Headline').fill('Platform engineer for developer tools');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(toasts(page).getByText('Profile saved')).toBeVisible();

  await page.goto('/settings/role-targets');
  await page.getByRole('button', { name: 'New role target' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Staff platform');
  await page.getByLabel('Title family').fill('Platform Engineer');
  await page.getByRole('button', { name: 'Add role target' }).click();
  await expect(toasts(page).getByText('Role target added')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Staff platform active' })).toBeChecked();

  const acme = { company: 'Acme Robotics', title: 'Staff Platform Engineer' };
  const globex = { company: 'Globex', title: 'Junior Developer' };
  await createOpportunity(page, acme);
  await createOpportunity(page, globex);

  await moveTo(page, acme, 'Applied');

  await card(page, globex.company, globex.title).getByRole('button', { name: 'Dismiss' }).click();
  const dialog = page.getByRole('dialog', { name: 'Dismiss opportunity' });
  await choose(dialog, 'Reason', 'Seniority');
  await dialog.getByLabel('Note (optional)').fill('Too junior');
  await dialog.getByRole('button', { name: 'Dismiss' }).click();
  await expect(dialog).toBeHidden();

  await page.goto('/');
  const counts = page.getByRole('region', { name: 'Pipeline by stage' });
  await expect(counts.getByRole('link', { name: 'Applied 1' })).toBeVisible();
  await expect(counts.getByRole('link', { name: 'Dismissed 1' })).toBeVisible();
  await expect(counts.getByRole('link', { name: 'New 0' })).toBeVisible();
  await expect(counts.getByRole('link', { name: 'Interested 0' })).toBeVisible();
});

// Two distinct defects were found chasing #124, not one flaky test:
//
// 1. The dismiss dialog used to close as soon as the form submitted (useStageFlow.confirmReason
//    called setPendingReason(null) before the mutation was even sent, let alone awaited):
//    "dialog hidden" was not a signal the server received the change, only that the UI handed
//    it off. That told the person it worked before anything happened over the network. Fixed
//    below, and the fix is what this test protects: the dialog now only hides on success.
// 2. A plain fetch with no special handling for page teardown can, per the Fetch spec, be
//    dropped by the browser when the page navigates away mid-flight; `keepalive: true` (api.ts)
//    is the documented fix. Three ways of proving this in a real browser were tried and each
//    had a confound that made it answer a different question than it looked like it did:
//    page.route()'s continue()-after-a-delay pauses the request at the CDP Fetch-interception
//    layer, which is torn down with the navigating-away frame regardless of keepalive (a false
//    negative, failing even with the fix applied); proxying the delay through a separate
//    Node-side fetch passed regardless of the fix, because that request is made by the Node
//    process, which a page navigation never tears down (a false positive); CDP network-latency
//    emulation slows the browser's real request without touching its lifecycle, which does
//    exercise the right code path, but it passed with and without the fix in this environment,
//    so it does not reliably distinguish them either. Covered instead by a unit test of what
//    api() asks fetch to do (src/lib/api.test.ts) rather than an unreliable end-to-end proof of
//    the browser's own navigation-time request handling.

test('a dismissal still lands when the user waits for the dialog, which now only hides on success (#124)', async ({
  page,
}) => {
  await registerUser(page);
  const globex = { company: 'Globex', title: 'Junior Developer' };
  await createOpportunity(page, globex);

  await page.route('**/api/v1/opportunities/*/stage', async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });

  await card(page, globex.company, globex.title).getByRole('button', { name: 'Dismiss' }).click();
  const dialog = page.getByRole('dialog', { name: 'Dismiss opportunity' });
  await choose(dialog, 'Reason', 'Seniority');
  await dialog.getByRole('button', { name: 'Dismiss' }).click();
  // Only hides once the (deliberately slow) request actually succeeds.
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  await page.goto('/');
  const counts = page.getByRole('region', { name: 'Pipeline by stage' });
  await expect(counts.getByRole('link', { name: 'Dismissed 1' })).toBeVisible();
});

test('resume: register a base, tailor a copy with the AI chat, score it, mark submitted', async ({
  page,
}) => {
  await registerUser(page);
  const opp = {
    company: 'Northwind Labs',
    title: 'Staff Platform Engineer',
    description: 'Build our Go platform on Kubernetes. Terraform a plus.',
  };
  await createOpportunity(page, opp);

  await page.goto('/resumes');
  await page
    .getByLabel('Google Doc link')
    .fill('https://docs.google.com/document/d/e2eBaseResumeDoc01/edit');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('link', { name: 'Jane Example Base Resume' })).toBeVisible();

  await page.goto('/pipeline');
  await card(page, opp.company, opp.title).getByRole('link', { name: opp.title }).click();
  await page.getByRole('tab', { name: 'Resume' }).click();
  await page.getByRole('button', { name: 'Create tailored copy' }).click();
  await page.waitForURL(/\/resumes\/[^/]+$/);

  // Tailoring chat round-trip: the mock model streams a reply with one suggested edit.
  await page.getByLabel('Message').fill('Emphasize Kubernetes for this role.');
  await page.getByRole('button', { name: 'Send' }).click();
  const conversation = page.getByRole('list', { name: 'Conversation' });
  await expect(conversation).toContainText('Your Go platform work maps well to this role.');
  await expect(conversation).toContainText('Built the Go billing platform on Kubernetes');
  await conversation.getByRole('button', { name: 'Apply' }).click();
  await expect(conversation.getByText('Applied', { exact: true })).toBeVisible();

  // Match report.
  await page.getByRole('button', { name: 'Score match' }).click();
  await expect(page.getByLabel('Match score')).toHaveAttribute('value', '82');
  await expect(page.getByText('Terraform', { exact: true })).toBeVisible();

  // Mark submitted.
  await choose(page, 'Status', 'Submitted');
  await page.getByLabel('Submitted to').fill('Northwind careers portal');
  await page.getByRole('button', { name: 'Mark submitted' }).click();
  await expect(page.getByText(/Sent to Northwind careers portal/)).toBeVisible();
});

test('import a pack, see it in the pipeline, re-import without duplicates', async ({ page }) => {
  await registerUser(page);
  const rows = [
    { company: 'Acme Robotics', title: 'Staff Software Engineer', stage: 'Applied' },
    { company: 'Globex', title: 'Engineering Manager', stage: 'Interested' },
    { company: 'Initech', title: 'Platform Engineer', stage: 'New' },
  ];
  const report = page.locator('dl');

  await page.goto('/settings/data');
  await page.getByLabel('Or a folder').setInputFiles(PACK_DIR);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(report).toContainText('Created3');
  await expect(report).toContainText('Unchanged0');

  await page.goto('/pipeline');
  for (const r of rows) {
    await expect(card(page, r.company, r.title)).toHaveCount(1);
    await expect(page.getByRole('button', { name: `Move ${r.company}: ${r.title}` })).toHaveText(
      r.stage,
    );
  }

  await page.goto('/settings/data');
  await page.getByLabel('Or a folder').setInputFiles(PACK_DIR);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(report).toContainText('Created0');
  await expect(report).toContainText('Unchanged3');

  await page.goto('/pipeline');
  await page.getByRole('button', { name: 'Table' }).click();
  for (const r of rows) {
    await expect(page.getByRole('row').filter({ hasText: r.title })).toHaveCount(1);
  }
  await page.goto('/');
  const counts = page.getByRole('region', { name: 'Pipeline by stage' });
  await expect(counts.getByRole('link', { name: 'Applied 1' })).toBeVisible();
  await expect(counts.getByRole('link', { name: 'Interested 1' })).toBeVisible();
  await expect(counts.getByRole('link', { name: 'New 1' })).toBeVisible();
});

test('inbox: synced mail creates, filters and proposes; accepting moves the stage', async ({
  page,
}) => {
  await registerUser(page);
  // The fixture mailbox has an interview request for this role (see mockGoogle.ts).
  const contoso = { company: 'Contoso', title: 'Senior Product Manager' };
  await createOpportunity(page, contoso);
  await moveTo(page, contoso, 'Applied');

  await connectGoogle(page, 'Connect Gmail (read-only)');
  // Connected: the Gmail card now offers a sync.
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible();
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Sync now' }).click();

  // Sync and classification run in the job queue; the inbox refreshes as they land.
  await page.getByRole('tab', { name: /^Linked/ }).click();
  const interview = page.getByRole('listitem', {
    name: 'Interview availability for Senior Product Manager',
  });
  await expect(async () => {
    await page.reload();
    await page.getByRole('tab', { name: /^Linked/ }).click();
    await expect(interview).toBeVisible({ timeout: 1000 });
    await expect(
      page.getByRole('listitem', { name: 'Staff Platform Engineer at Northwind Labs' }),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });

  await page.getByRole('tab', { name: /^Spam/ }).click();
  await expect(page.getByRole('listitem', { name: '50 hot remote jobs this week' })).toBeVisible();

  // The targeted solicitation created an opportunity.
  await page.goto('/pipeline');
  await expect(card(page, 'Northwind Labs', 'Staff Platform Engineer')).toBeVisible();

  // Accept the proposed transition on the interview request.
  await page.goto('/inbox');
  await page.getByRole('tab', { name: /^Linked/ }).click();
  await interview.getByRole('button', { name: 'Move to In process' }).click();
  await expect(interview.getByRole('button', { name: 'Move to In process' })).toBeHidden();

  await page.goto('/pipeline');
  await expect(
    page.getByRole('button', { name: `Move Contoso: Senior Product Manager` }),
  ).toHaveText('In process');
});

test('find posting: an opportunity with no description gets one from the company board', async ({
  page,
}) => {
  await registerUser(page);
  // The fixture board (OPPORTUN_SOURCE_MOCK) carries this exact title, so the search settles on
  // one confident candidate and attaches it without a picker.
  const opp = { company: 'Vandelay Industries', title: 'Staff Platform Engineer' };
  await createOpportunity(page, opp);

  await page.goto('/pipeline');
  await card(page, opp.company, opp.title).getByRole('link', { name: opp.title }).click();
  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page.getByText('No description.')).toBeVisible();

  await page.getByRole('button', { name: 'Find posting' }).click();
  await expect(toasts(page).getByText('Posting attached')).toBeVisible();
  await expect(page.getByText(/Lead our Go platform on Kubernetes/)).toBeVisible();
  await expect(page.getByRole('link', { name: /boards\.greenhouse\.io/ })).toBeVisible();

  // The attach is on the record, not just in the field.
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByRole('list', { name: 'Timeline' })).toContainText('Job posting attached');
});

test('theme choice persists across reloads (FR-U10)', async ({ page }) => {
  await registerUser(page);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: /^Theme:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible();

  // The choice is stored on the server too: with the local mirror gone it still comes back.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('two-factor sign-in: enable, sign out, sign in with a code, turn off (FR-S3)', async ({
  page,
}) => {
  const email = await registerUser(page);
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Enable two-factor' }).click();
  // Credential changes re-ask for the current password (a stolen cookie alone is not enough).
  const confirm = page.getByRole('dialog', { name: 'Confirm your password' });
  await confirm.getByLabel('Current password').fill(PASSWORD);
  await confirm.getByRole('button', { name: 'Continue' }).click();

  const setup = page.getByRole('dialog', { name: 'Set up two-factor sign-in' });
  const qr = setup.getByRole('img', { name: 'QR code for your authenticator app' });
  await expect(qr).toBeVisible();
  // The data: URL actually renders under the CSP (img-src 'self' data:).
  await expect
    .poll(() => qr.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const secret = await setup.getByLabel('Setup key', { exact: true }).inputValue();
  // Codes are pinned to explicit time steps, not to "now" at each use. The server (same
  // clock) accepts a code for steps now-1..now+1 and never a step at or below the last one
  // it accepted. Activation submits step S (server is at S or S+1 when it arrives, so S is
  // accepted and recorded); sign-in submits S+1, which is above S and in the window as long
  // as the server is at step S..S+2 when it arrives (at least 60s of slack). The guard
  // below turns a pathologically slow run into a clear failure instead of a flake.
  const STEP_MS = 30_000;
  const step = Math.floor(Date.now() / STEP_MS);
  await setup.getByLabel('Code from the app').fill(totpCode(secret, step * STEP_MS));
  await setup.getByRole('button', { name: 'Turn on' }).click();

  const codes = page.getByRole('list', { name: 'Recovery codes' });
  await expect(codes.getByRole('listitem')).toHaveCount(10);
  const recovery = (await codes.getByRole('listitem').first().textContent()) ?? '';
  await page.getByRole('button', { name: 'I saved them' }).click();
  await expect(codes).toBeHidden();
  await expect(page.getByText('10 recovery codes left', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor sign-in' })).toBeVisible();
  // Step S+1: the activation code (step S) itself is spent (replay guard).
  expect(
    Math.floor(Date.now() / STEP_MS) - step,
    'sign-in must follow activation within the TOTP window',
  ).toBeLessThanOrEqual(2);
  await page.getByLabel('Authentication code').fill(totpCode(secret, (step + 1) * STEP_MS));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // Turn it off with a recovery code; the next sign-in is a single step again.
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Turn off' }).click();
  const off = page.getByRole('dialog', { name: 'Turn off two-factor sign-in' });
  await off.getByLabel('Current password').fill(PASSWORD);
  await off.getByRole('button', { name: 'Use a recovery code' }).click();
  await off.getByLabel('Recovery code').fill(recovery);
  await off.getByRole('button', { name: 'Turn off' }).click();
  await expect(toasts(page).getByText('Two-factor sign-in turned off')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable two-factor' })).toBeVisible();
});

test('admin resets a member password from Settings > Users (FR-S1)', async ({ page, browser }) => {
  const email = await registerUser(page, 'Reset Member');

  const adminContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    await admin.goto('/login');
    await admin.getByLabel('Email').fill(ADMIN.email);
    await admin.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await admin.getByRole('button', { name: 'Sign in' }).click();
    await expect(admin.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await admin.goto('/settings/users');
    const row = admin.getByRole('row').filter({ hasText: email });
    await row.getByRole('button', { name: 'Reset password for Reset Member' }).click();
    await admin
      .getByRole('dialog', { name: 'Reset password for Reset Member?' })
      .getByRole('button', { name: 'Reset password' })
      .click();
    const shown = admin.getByRole('dialog', { name: 'Temporary password' });
    const temporary = await shown
      .getByLabel('Temporary password for Reset Member', { exact: true })
      .inputValue();
    expect(temporary.length).toBeGreaterThanOrEqual(24);
    await shown.getByRole('button', { name: 'Done' }).click();
    await expect(shown).toBeHidden();

    // The member was signed out everywhere; the temporary password signs them back in.
    await page.reload();
    await page.waitForURL((url) => url.pathname === '/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(temporary);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  } finally {
    await adminContext.close();
  }
});
