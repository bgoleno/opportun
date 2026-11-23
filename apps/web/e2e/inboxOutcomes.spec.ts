// What the Inbox says when an action takes its row out of the list, or the message was changed
// elsewhere (https://github.com/bgoleno/opportun/issues/895), on the real server, in a real browser,
// at a narrow, a laptop and a wide width. The changes "elsewhere" are the API's, behind the page's
// back. The messages are the AI fake's "Interview availability" mail: linked to the Contoso
// opportunity, each with a suggested move.
import { expect, test, type Page } from '@playwright/test';
import { createOpportunity, PASSWORD, registerUser, toasts } from './helpers';

const OPP = { company: 'Contoso', title: 'Senior Product Manager' };

/** Calls the API as the signed-in user, from the page (its cookies, its CSRF token). */
async function api(page: Page, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await page.evaluate(
    async ([m, p, b]) => {
      const csrf = /(?:^|; )opportun_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
      const r = await fetch(`/api/v1${p}`, {
        method: m,
        headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      return { status: r.status, text: await r.text() };
    },
    [method, path, body] as const,
  );
  expect(res.status, res.text).toBe(200);
  return JSON.parse(res.text);
}

async function seed(page: Page, tag: string, count: number): Promise<string[]> {
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Create token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a device token' });
  await dialog.getByLabel('Name').fill('Inbox outcomes e2e');
  await dialog.getByRole('checkbox', { name: /^Apple Mail connector/ }).setChecked(true);
  await dialog.getByRole('checkbox', { name: /^Browser capture/ }).setChecked(false);
  await dialog.getByLabel('Current password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy your device token' });
  const token = await shown.getByLabel('Device token').inputValue();
  await shown.getByRole('button', { name: 'I saved it' }).click();
  await expect(shown).toBeHidden();
  const subjects = Array.from(
    { length: count },
    (_, i) => `Interview availability ${tag} ${i + 1}`,
  );
  const res = await page.request.post('/api/v1/connector/mail/batch', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      messages: subjects.map((subject, i) => ({
        externalId: `outcomes-${tag}-${i + 1}`,
        threadKey: `outcomes-${tag}-${i + 1}`,
        from: `Recruiter ${tag}${i + 1} <r${i + 1}.${tag}@contoso.example>`,
        to: ['me@example.com'],
        subject,
        snippet: `Snippet ${i + 1}`,
        bodyText: `Could we find a time to talk? (${tag} ${i + 1})`,
        sentAt: Date.now() - 60_000 * (i + 1),
      })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  // Classification runs in the job queue: wait until every one is linked.
  await expect
    .poll(
      async () =>
        ((await api(page, 'GET', '/communications?view=linked&limit=50')) as { total: number })
          .total,
      { timeout: 60_000 },
    )
    .toBe(count);
  return subjects;
}

const row = (page: Page, subject: string) =>
  page.getByRole('listitem', { name: subject, exact: true });

async function idOf(page: Page, subject: string): Promise<{ id: string; opportunityId: string }> {
  const list = (await api(
    page,
    'GET',
    `/communications?view=all&limit=200&q=${encodeURIComponent(subject)}`,
  )) as { items: { id: string; subject: string; opportunityId: string }[] };
  return list.items.find((c) => c.subject === subject)!;
}

const openTab = async (page: Page, name: RegExp) => {
  await page.goto('/inbox');
  await page.getByRole('tab', { name }).click();
};

/** Picks the Contoso opportunity in a row's link dialog. */
async function linkFromRow(page: Page, subject: string) {
  await row(page, subject).getByRole('button', { name: 'Link to opportunity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Link to an opportunity' });
  await dialog.getByLabel('Search').fill(OPP.company);
  await dialog
    .getByRole('list', { name: 'Matching opportunities' })
    .getByRole('button', { name: OPP.title })
    .click();
}

for (const width of [375, 1280, 1920]) {
  test(`what each action says as its row leaves, at ${width} px (#895)`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await registerUser(page);
    await createOpportunity(page, OPP);
    const [refusedMove, moved, refusedLink] = (await seed(page, `w${width}`, 3)) as [
      string,
      string,
      string,
    ];
    await page.setViewportSize({ width, height: 900 });
    const toast = (text: string) => toasts(page).getByText(text, { exact: true });

    await test.step('a suggested move on a message rejected elsewhere', async () => {
      await openTab(page, /^Linked/);
      const move = row(page, refusedMove).getByRole('button', { name: 'Move to In process' });
      await expect(move).toBeVisible();
      const { id, opportunityId } = await idOf(page, refusedMove);
      await api(page, 'POST', `/communications/${id}/reject`, {
        reason: 'spam',
        expectedOpportunityId: opportunityId,
      });
      await move.click();
      await expect(toast('Stage not changed')).toBeVisible();
      await expect(
        toast('This message has been rejected, and its suggestion with it.'),
      ).toBeVisible();
      await expect(row(page, refusedMove)).toHaveCount(0);
    });

    await test.step('Unlink, from Linked', async () => {
      await row(page, moved).getByRole('button', { name: 'Change link' }).click();
      await page
        .getByRole('dialog', { name: 'Link to an opportunity' })
        .getByRole('button', { name: 'Unlink' })
        .click();
      await expect(toast('Message unlinked')).toBeVisible();
      await expect(row(page, moved)).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    await test.step('Link, from Needs review', async () => {
      await openTab(page, /^Needs review/);
      await linkFromRow(page, moved);
      await expect(toast('Message linked')).toBeVisible();
      await expect(row(page, moved)).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    await test.step('Not spam, from Spam', async () => {
      const { id } = await idOf(page, moved);
      await api(page, 'POST', `/communications/${id}/classify`, {
        classification: 'solicitation',
        outreachKind: 'broadcast_spam',
      });
      await openTab(page, /^Spam/);
      await row(page, moved).getByRole('button', { name: 'Not spam' }).click();
      await expect(toast('Moved to Needs review')).toBeVisible();
      await expect(row(page, moved)).toHaveCount(0);
    });

    await test.step('Link on a message rejected elsewhere', async () => {
      const { id, opportunityId } = await idOf(page, refusedLink);
      await api(page, 'POST', `/communications/${id}/classify`, { opportunityId: null });
      await openTab(page, /^Needs review/);
      await expect(row(page, refusedLink)).toBeVisible();
      await api(page, 'POST', `/communications/${id}/reject`, {
        reason: 'spam',
        expectedOpportunityId: null,
      });
      await linkFromRow(page, refusedLink);
      await expect(toast('Message not linked')).toBeVisible();
      await expect(toast('This message has been rejected, so it was left as it is.')).toBeVisible();
      await expect(row(page, refusedLink)).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const { items } = (await api(page, 'GET', `/opportunities/${opportunityId}/timeline`)) as {
        items: { id: string }[];
      };
      expect(items.filter((i) => i.id === id)).toEqual([]);
    });

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      'nothing is wider than the window',
    ).toBeLessThanOrEqual(0);
  });
}
