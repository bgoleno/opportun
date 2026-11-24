// Dialogs whose title or description carries someone's words, a message's subject and addresses and
// an opportunity's title, hold one long unbroken one inside them
// (https://github.com/bgoleno/opportun/issues/921). The Revoke confirmation is in devices.spec.ts.
// The list is answered here: what is measured is the dialogs, not how a message got its text.
import { expect, test, type Page } from '@playwright/test';
import { fit } from './dialogFit';
import { registerUser } from './helpers';

const SUBJECT = 'S'.repeat(120);
const TITLE = 'T'.repeat(120);

const MESSAGE = {
  id: 'c1',
  channel: 'apple_mail',
  externalId: 'x1',
  threadKey: 't1',
  direction: 'inbound',
  from: `Recruiter <${'f'.repeat(100)}@example.com>`,
  to: [`${'t'.repeat(100)}@example.com`],
  subject: SUBJECT,
  snippet: 'Snippet',
  classification: 'scheduling',
  classificationConfidence: 0.9,
  outreachKind: null,
  sentAt: Date.now() - 60_000,
  createdAt: Date.now() - 60_000,
  contactId: null,
  opportunityId: 'o1',
  opportunityTitle: TITLE,
  companyName: 'Contoso',
  opportunityStage: 'dismissed',
  needsReview: true,
  proposedTransition: 'in_process',
};

async function openInbox(page: Page) {
  await page.route(/\/api\/v1\/communications\?/, async (route) => {
    const here = new URL(route.request().url()).searchParams.get('view') === 'needs_review';
    await route.fulfill({
      json: { items: here ? [MESSAGE] : [], total: here ? 1 : 0 },
    });
  });
  await page.goto('/inbox');
  const row = page.getByRole('listitem', { name: SUBJECT, exact: true });
  await expect(row).toBeVisible();
  return row;
}

for (const width of [375, 768, 1280, 1920]) {
  test(`a long unbroken subject and title stay inside their dialogs, at ${width} px (#921)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await registerUser(page);
    const row = await openInbox(page);
    for (const [button, name] of [
      ['Open', SUBJECT],
      ['Reopen and move', `Reopen ${TITLE}?`],
    ] as const) {
      await row.getByRole('button', { name: button, exact: true }).click();
      const dialog = page.getByRole('dialog', { name });
      await expect(dialog).toBeVisible();
      const measured = await fit(dialog);
      expect(measured, `${button}: ${JSON.stringify(measured)}`).toEqual({
        sideways: 0,
        outside: [],
      });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });
}
