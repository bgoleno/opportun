// The resume flow end to end (https://github.com/bgoleno/opportun/issues/496, slice 4 of #400):
// a fresh account walks it once, the way a user would, from a base resume to Apply on Greenhouse,
// with the mock AI and Docs and assisted apply on (playwright.config.ts).
//
// The opportunity's Resume tab (its flow card, #440), the tailored copy's own page (its strip,
// #447) and the Assisted apply panel all read one state (resumeFlowState, #428). The unit tests
// pin each view on its own; this path checks that, on the real server, each shows the step the
// user is at as the user moves through it.
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  captureGreenhouseOpportunity,
  registerBaseResume,
  registerUser,
  stubOtherHosts,
} from './helpers';

test.beforeEach(async ({ context }) => {
  await stubOtherHosts(context);
});

/** The step a flow view marks as the current one, for example "2 Tailor". */
function currentStep(view: Locator): Locator {
  return view.getByRole('list', { name: 'Resume steps' }).locator('[aria-current="step"]');
}

/** The flow card on the opportunity's Resume tab. */
function flowCard(page: Page): Locator {
  return page.getByRole('region', { name: 'Resume for this application' });
}

test('resume flow: from a base resume to Apply on Greenhouse, the strip and the flow card at each step', async ({
  page,
  playwright,
}) => {
  await registerUser(page);
  // Registered and left as it is (a Draft): the flow's own step 1 is choosing it.
  await registerBaseResume(page, 'e2eFlowResumeDoc01');
  const id = await captureGreenhouseOpportunity(page, playwright);
  const applyHref = `/opportunities/${id}/apply?step=resume`;

  // The posting is confirmed once the panel's only reason is the resume: applyBlockedReason
  // (stage, recognised ATS, posting confirmed) is asked first, so the flow's step 1 sentence
  // there means nothing else stands in the way.
  const panel = page.getByRole('region', { name: 'Assisted apply' });
  await page.goto(`/opportunities/${id}`);
  await expect(async () => {
    await page.reload();
    await expect(panel.getByText('Choose the resume to start from.')).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });

  // Step 1 on the Resume tab: Create tailored copy opens the copy's own page.
  await page.getByRole('tab', { name: 'Resume' }).click();
  const tab = flowCard(page);
  await expect(currentStep(tab)).toHaveText('1 Base');
  await expect(
    tab.getByRole('heading', { name: 'Choose the resume to start from.' }),
  ).toBeVisible();
  await tab.getByRole('button', { name: 'Create tailored copy' }).click();
  await page.waitForURL(/\/resumes\/[^/]+$/);
  const copyUrl = new URL(page.url()).pathname;

  // Step 2 on the copy's page: the strip, with Mark as final in place.
  const strip = page.getByRole('region', { name: 'Next step for this resume' });
  await expect(strip.getByText('For Staff Platform Engineer at Vandelay Industries')).toBeVisible();
  await expect(currentStep(strip)).toHaveText('2 Tailor');
  await expect(strip.getByRole('heading', { name: /^Tailor ".+" for this role\.$/ })).toBeVisible();
  await strip.getByRole('button', { name: 'Mark as final' }).click();

  // Step 4: the strip moves on, and Apply on Greenhouse is the apply flow at its resume step.
  await expect(currentStep(strip)).toHaveText('4 Apply');
  await expect(strip.getByRole('heading', { name: 'Ready to apply.' })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Mark as final' })).toHaveCount(0);
  const stripApply = strip.getByRole('link', { name: 'Apply on Greenhouse' });
  await expect(stripApply).toHaveAttribute('href', applyHref);
  await stripApply.click();
  await page.waitForURL(`**${applyHref}`);
  // The apply flow's resume step (S2), the one Next: Details leaves.
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Next: Details' })).toBeVisible();

  // Back on the Resume tab: the flow card shows the same step, with the same way to apply.
  await page.goto(`/opportunities/${id}?tab=resume`);
  await expect(currentStep(tab)).toHaveText('4 Apply');
  await expect(tab.getByRole('heading', { name: 'Ready to apply.' })).toBeVisible();
  await expect(tab.getByRole('link', { name: 'Apply on Greenhouse' })).toHaveAttribute(
    'href',
    applyHref,
  );

  // And the Assisted apply panel (in the Timeline tab's rail) gives no resume reason: its
  // Apply on Greenhouse is a link to the same step, not a refused button with a reason and the
  // way to the Resume tab.
  await page.getByRole('tab', { name: 'Timeline' }).click();
  const panelApply = panel.getByRole('link', { name: 'Apply on Greenhouse' });
  await expect(panelApply).toHaveAttribute('href', applyHref);
  await expect(panel.getByRole('link', { name: 'Open the Resume tab' })).toHaveCount(0);
  await expect(panel.locator('[aria-disabled="true"]')).toHaveCount(0);
  await expect(panel.getByText('Choose the resume to start from.')).toHaveCount(0);

  // The copy is the one the flow follows, and its page still says so.
  await page.goto(copyUrl);
  await expect(currentStep(strip)).toHaveText('4 Apply');
});
