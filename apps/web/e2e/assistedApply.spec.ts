// Assisted apply with the feature off (https://github.com/bgoleno/opportun/issues/117 criterion
// 5): the e2e server runs without OPPORTUN_SUBMISSIONS, as every install and the demo do by
// default, so the opportunity page must show nothing of the feature, and a deep link to the
// apply page must say it is not available rather than offer anything.
import { expect, test } from '@playwright/test';
import { card, createOpportunity, registerUser } from './helpers';

test('feature off: the opportunity page shows nothing of assisted apply, and the apply page says so', async ({
  page,
}) => {
  await registerUser(page);
  const opp = { company: 'Initech', title: 'Platform Engineer' };
  await createOpportunity(page, opp);
  await card(page, opp.company, opp.title).getByRole('link', { name: opp.title }).click();
  await expect(page.getByRole('heading', { name: opp.title, level: 1 })).toBeVisible();
  // The rail has loaded (the panel sits above Next steps), so an absence is meaningful.
  await expect(page.getByText(/next steps/i).first()).toBeVisible();
  await expect(page.getByText(/assisted apply/i)).toHaveCount(0);
  await expect(page.getByText(/apply on/i)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /apply/i })).toHaveCount(0);

  const id = new URL(page.url()).pathname.split('/').pop() as string;
  await page.goto(`/opportunities/${id}/apply?step=review`);
  await expect(page.getByText('Assisted apply is not available here.')).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});
