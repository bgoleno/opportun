// The resume flow's forms in place, its announcements and its finished steps
// (https://github.com/bgoleno/opportun/issues/749, gap 7 of qa's survey; shipped by #609). The
// unit tests run in jsdom, where focus and a live region's nodes are not a browser's: here the
// Resume tab's card opens "Register a base resume" in place, focus goes into the form, Cancel
// gives it back to the button and saves nothing; each change of place is said in the polite
// region as a node of its own, a repeated message included; and a finished step links to what it
// made. The mock Docs serve the resume.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { card as boardCard, choose, createOpportunity, registerUser } from './helpers';

const flowCard = (page: Page) => page.getByRole('region', { name: 'Resume for this application' });
const strip = (page: Page) => page.getByRole('region', { name: 'Next step for this resume' });
const steps = (view: Locator) => view.getByRole('list', { name: 'Resume steps' });
/** The flow's polite region (flowAnnouncer.tsx). */
const announcer = (view: Locator) => view.locator('p[role="status"][aria-live="polite"]');

const resumeCount = async (page: Page) =>
  ((await (await page.request.get('/api/v1/resumes?limit=200')).json()) as { items: unknown[] })
    .items.length;

test('the resume flow: a form opened in place takes focus and Cancel gives it back, each step is said once, and finished steps link back', async ({
  page,
}) => {
  await registerUser(page);
  const opp = { company: 'Northwind Labs', title: 'Platform Lead' };
  await createOpportunity(page, opp);
  await boardCard(page, opp.company, opp.title).getByRole('link').first().click();
  await page.waitForURL(/\/opportunities\/[^/]+$/);
  await page.getByRole('tab', { name: 'Resume' }).click();
  const card = flowCard(page);
  await expect(card.getByRole('heading', { name: 'Add a base resume to start.' })).toBeVisible();

  // Opened in place: focus goes into the form. Cancel closes it, gives focus back, saves nothing.
  const register = card.getByRole('button', { name: 'Register a base resume' });
  await register.click();
  const link = card.getByLabel('Google Doc link');
  await expect(link).toBeFocused();
  await link.fill('https://docs.google.com/document/d/e2eFlowA11yDoc01/edit');
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByLabel('Google Doc link')).toHaveCount(0);
  await expect(register).toBeFocused();
  expect(await resumeCount(page)).toBe(0);

  // Opened again and registered: the next place is said once, and focus moves to its sentence.
  await register.click();
  await expect(link).toBeFocused();
  await link.fill('https://docs.google.com/document/d/e2eFlowA11yDoc01/edit');
  await card.getByRole('button', { name: 'Register' }).click();
  const chooseBase = card.getByRole('heading', { name: 'Choose the resume to start from.' });
  await expect(chooseBase).toBeFocused();
  await expect(announcer(card).locator('span')).toHaveCount(1);
  await expect(announcer(card)).toHaveText('Base resume registered. Next: create a tailored copy.');
  expect(await resumeCount(page)).toBe(1);

  // On the copy's page, Mark as final is said; the same message again (back to In review, then
  // final again) is a new node, so a screen reader says it again.
  await card.getByRole('button', { name: 'Create tailored copy' }).click();
  await page.waitForURL(/\/resumes\/[^/]+$/);
  const s = strip(page);
  await expect(s.getByRole('button', { name: 'Mark as final' })).toBeVisible();
  const current = steps(s).locator('[aria-current="step"]');
  await s.getByRole('button', { name: 'Mark as final' }).click();
  await expect(current).toHaveText('4 Apply');
  // The region empties 7 s after a message (ANNOUNCE_CLEAR_MS): read it at once.
  const said = announcer(s).locator('span');
  await expect(said).toHaveCount(1);
  await expect(said).toHaveText(/^Marked final\. Next: /);
  const message = await said.textContent();
  await said.evaluate((el) => el.setAttribute('data-qa-first', '1'));
  await page.getByRole('button', { name: 'Change status' }).click();
  await choose(page, 'Status', 'In review');
  await expect(s.getByRole('button', { name: 'Mark as final' })).toBeVisible();
  await s.getByRole('button', { name: 'Mark as final' }).click();
  await expect(current).toHaveText('4 Apply');
  await expect(said).toHaveCount(1);
  await expect(said).toHaveText(message ?? '');
  await expect(said).not.toHaveAttribute('data-qa-first', '1');

  // A finished step links to what it made: Base opens the base resume's own page.
  const base = steps(s).getByRole('link', {
    name: /^1 Base \(completed\)\s*: Jane Example Base Resume$/,
  });
  await expect(base).toBeVisible();
  await expect(steps(s).locator('[aria-current="step"]').getByRole('link')).toHaveCount(0);
  const copyUrl = page.url();
  await base.click();
  await page.waitForURL((url) => url.href !== copyUrl && /\/resumes\/[^/]+$/.test(url.pathname));
  await expect(
    page.getByRole('heading', { name: 'Jane Example Base Resume', level: 1 }),
  ).toBeVisible();
});
