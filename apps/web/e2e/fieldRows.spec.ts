// Fields side by side line up, whichever has a hint or an error
// (https://github.com/bgoleno/opportun/issues/951): in each row of a form the labels start at one
// height, and so do the controls. Each screen is measured with its hints, and with an error under one
// field of a row. Assisted apply's details step is in assistedApply.spec.ts.
import { expect, test, type Page } from '@playwright/test';
import { expectLinedUp } from './fieldRows';
import { card, createOpportunity, registerUser, signInAsAdmin } from './helpers';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await registerUser(page);
});

test('Settings > AI: an API key, and a model policy', async ({ page }) => {
  await page.goto('/settings/ai');
  const key = ['Provider | API key', 'Key name (optional) | Expires (optional)'];
  await expect(page.getByLabel('API key')).toBeVisible();
  await expectLinedUp(page, key);
  await button(page, 'Add key').click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expectLinedUp(page, key);
  const policy = [
    'Provider | Model',
    'Max output tokens | Temperature',
    'Input price (USD per million tokens) | Output price (USD per million tokens)',
  ];
  await page.getByRole('button', { name: /^Edit/ }).first().click();
  await expect(page.getByLabel('Max output tokens')).toBeVisible();
  await expectLinedUp(page, [...key, ...policy]);
  await page.getByLabel('Max output tokens').fill('x');
  await page.getByLabel('Max output tokens').press('Enter');
  await expect(page.getByLabel('Max output tokens')).toHaveAttribute('aria-invalid', 'true');
  await expectLinedUp(page, [...key, ...policy]);
});

test('Settings > Profile: the profile, its links, and the application details', async ({
  page,
}) => {
  await page.goto('/settings/profile');
  const email = page.getByLabel('Contact email');
  await expect(email).toBeVisible();
  const rows = [
    'Full name | Headline',
    'Contact email | Phone',
    'Location (city) | Work authorization',
    'First name | Last name',
    'Phone country code | School',
    'Degree | LinkedIn profile',
    'Website | Links',
  ];
  await expectLinedUp(page, rows);
  await email.fill('x');
  await button(page, 'Add link').click();
  await page.getByLabel('Link 1 URL').fill('x');
  await button(page, 'Save profile').click();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('LinkedIn profile').fill('x');
  await button(page, 'Save application details').click();
  await expect(page.getByLabel('LinkedIn profile')).toHaveAttribute('aria-invalid', 'true');
  await expectLinedUp(page, [...rows, 'Link 1 label | Link 1 URL']);
});

test('Settings > Role targets, and Resume rules', async ({ page }) => {
  await page.goto('/settings/role-targets');
  await button(page, 'New role target').click();
  const rows = [
    'Name | Title family',
    'Minimum seniority | Maximum seniority',
    'Work arrangement | Minimum compensation | Maximum compensation',
  ];
  await expect(page.getByLabel('Title family')).toBeVisible();
  await expectLinedUp(page, rows);
  await page.getByLabel('Name', { exact: true }).fill('A');
  await page.getByLabel('Minimum compensation').fill('x');
  await page.getByLabel('Minimum compensation').press('Enter');
  await expect(page.getByLabel('Title family')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Minimum compensation')).toHaveAttribute('aria-invalid', 'true');
  await expectLinedUp(page, rows);
  await page.goto('/settings/resume-rules');
  await button(page, 'New rule').click();
  await expect(page.getByLabel('Order')).toBeVisible();
  await expectLinedUp(page, ['Category | Order']);
});

test('Discovery: a new source', async ({ page }) => {
  await page.goto('/discovery/sources');
  await button(page, 'New source').click();
  await expect(page.getByLabel('Role target (optional)')).toBeVisible();
  await expectLinedUp(page, ['Schedule (cron, optional) | Role target (optional)']);
});

test('a new opportunity, and its timeline’s composer', async ({ page }) => {
  await page.goto('/pipeline');
  await button(page, 'New opportunity').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill('x');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByLabel('Company')).toHaveAttribute('aria-invalid', 'true');
  await expectLinedUp(page, ['Company | Title']);
  await createOpportunity(page, { company: 'Contoso', title: 'Engineer' });
  await card(page, 'Contoso', 'Engineer').getByRole('link', { name: 'Engineer' }).click();
  await page.getByLabel('Type').selectOption('interview');
  await button(page, 'Add').first().click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expectLinedUp(page, ['Type | Title', 'Participants | When']);
});

test('filters and one-line forms', async ({ page }) => {
  for (const [path, label] of [
    ['/settings/metrics', 'Search metrics'],
    ['/settings/traces', 'Task'],
    ['/network', 'Name'],
    ['/discovery/companies', 'Sort by'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByLabel(label, { exact: true }).first()).toBeVisible();
    await expectLinedUp(page, []);
  }
});

test('Settings > Telemetry: each destination', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/settings/telemetry');
  const type = page.getByLabel('Destination type');
  for (const [label, rows] of [
    ['OTLP', ['Base path | Header name']],
    ['Datadog Agent', []],
    ['Prometheus', []],
    ['InfluxDB', ['Organisation | Bucket']],
  ] as const) {
    await type.selectOption({ label });
    await expectLinedUp(page, ['Destination type | Scheme', 'Host | Port', ...rows]);
  }
});
