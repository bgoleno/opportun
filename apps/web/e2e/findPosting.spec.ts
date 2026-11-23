// Find posting from every posting state, and the user's description kept through the posting
// checks (https://github.com/bgoleno/opportun/issues/859). The flows changed with #804, #830,
// #847, #855, #856 and #858, and qa's regression passes kept finding races at their seams; the
// unit tests mock the board, so these walk the real routes against the source mock's fixture
// board (apps/server/src/testSupport/mockSources.ts: Vandelay Industries, jobs 1001 to 1003),
// whose listing a spec can hold, trim or change (POST /__mock/discovery/listing).
import { expect, test, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { createCaptureToken, registerUser, toasts } from './helpers';

const COMPANY = 'Vandelay Industries';
const TYPED = 'My own notes on this role, typed into the Description editor.';

const csrf = async (page: Page) =>
  (await page.context().cookies()).find((c) => c.name === 'opportun_csrf')?.value ?? '';

/** An opportunity at the fixture company, with a posting link and the user's own description. */
async function opportunity(
  page: Page,
  title: string,
  opts: { postingUrl?: string; descriptionMd?: string } = {},
): Promise<string> {
  const headers = { 'x-csrf-token': await csrf(page) };
  const res = await page.request.post('/api/v1/opportunities?force=true', {
    headers,
    data: {
      companyName: COMPANY,
      title,
      sourceKind: 'manual',
      ...(opts.postingUrl === undefined ? {} : { postingUrl: opts.postingUrl }),
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  // Saved as the Description editor saves it, so it counts as the user's own text.
  if (opts.descriptionMd !== undefined) {
    const saved = await page.request.patch(`/api/v1/opportunities/${id}`, {
      headers,
      data: { descriptionMd: opts.descriptionMd },
    });
    expect(saved.status()).toBe(200);
  }
  return id;
}

/** A job captured by the extension; the background posting check then looks it up on the board. */
async function captured(
  page: Page,
  playwright: PlaywrightWorkerArgs['playwright'],
  title: string,
): Promise<string> {
  const token = await createCaptureToken(page);
  const extension = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const res = await extension.post('/api/v1/connector/capture', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        url: `https://www.linkedin.com/jobs/view/${Date.now()}/`,
        title: `${title} | ${COMPANY} | LinkedIn`,
        text: [
          COMPANY,
          title,
          'Remote (US)',
          'About the job',
          `The ${title} role, as captured.`,
        ].join('\n'),
      },
    });
    expect([200, 201], await res.text()).toContain(res.status());
    return ((await res.json()) as { opportunityId: string }).opportunityId;
  } finally {
    await extension.dispose();
  }
}

async function details(page: Page, id: string) {
  await page.goto(`/opportunities/${id}`);
  await page.getByRole('tab', { name: 'Details' }).click();
}

/** The opportunity's timeline, as its tab lists it. */
async function timeline(page: Page, id: string) {
  await page.goto(`/opportunities/${id}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  return page.getByRole('list', { name: 'Timeline' });
}

async function description(page: Page, id: string): Promise<string | null> {
  const res = await page.request.get(`/api/v1/opportunities/${id}`);
  return ((await res.json()) as { descriptionMd: string | null }).descriptionMd;
}

/** Waits until the held board listing has been asked for: the check is now reading the board. */
async function boardBeingRead(page: Page) {
  await expect
    .poll(
      async () =>
        ((await (await page.request.get('/__mock/discovery/listing')).json()) as { reads: number })
          .reads,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
}

/** Waits for the background posting check to settle the posting (the Details tab shows it on load). */
async function settled(
  page: Page,
  id: string,
): Promise<{ postingState: string; postingStateDetail: string | null }> {
  let last = { postingState: '', postingStateDetail: null as string | null };
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/v1/opportunities/${id}`);
        last = (await res.json()) as typeof last;
        return last.postingState;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^(needs_review|confirmed)$/);
  return last;
}

/** What the fixture board's next listings do (see mockSources.ts ListingControl). */
async function listing(
  page: Page,
  control: { holdMs?: number; drop?: string[]; append?: Record<string, string> },
) {
  // Cleared first, so its read count starts again from this control.
  await page.request.delete('/__mock/discovery/listing');
  const res = await page.request.post('/__mock/discovery/listing', { data: control });
  expect(res.status(), await res.text()).toBe(200);
}

test.afterEach(async ({ page }) => {
  await page.request.delete('/__mock/discovery/listing');
});

test.describe('Find posting from each posting state (#859)', () => {
  test('no posting yet: a board link, no link, and a gh_jid careers link', async ({ page }) => {
    await registerUser(page);
    // A board link: the job it names is attached, with the board's description.
    const board = await opportunity(page, 'Senior Backend Engineer', {
      postingUrl: 'https://boards.greenhouse.io/vandelayindustries/jobs/1003',
    });
    await details(page, board);
    await page.getByRole('button', { name: 'Find posting' }).click();
    await expect(toasts(page).getByText('Posting attached')).toBeVisible();
    await expect(toasts(page).getByText('Senior Backend Engineer')).toBeVisible();
    await expect(page.getByText(/Build import and export services/)).toBeVisible();
    await expect(page.getByText("Matched on the company's board.")).toBeVisible();
    const boardTimeline = await timeline(page, board);
    await expect(boardTimeline).toContainText('Job posting attached');
    await expect(boardTimeline).toContainText(
      "Found on the company's ATS board, by the job this opportunity names.",
    );

    // No link: the one confident title match.
    const titled = await opportunity(page, 'Office Coordinator');
    await details(page, titled);
    await page.getByRole('button', { name: 'Find posting' }).click();
    await expect(toasts(page).getByText('Office Coordinator')).toBeVisible();
    const titledTimeline = await timeline(page, titled);
    await expect(titledTimeline).toContainText("Found on the company's ATS board.");
    await expect(titledTimeline).not.toContainText('by the job this opportunity names');

    // A careers-page gh_jid link, with the user's own description: Greenhouse's API names the job
    // (the board is known by now), the posting is confirmed, and the description stays.
    const careers = await opportunity(page, 'Operations Lead', {
      postingUrl: 'https://vandelay.example/careers?gh_jid=1002',
      descriptionMd: TYPED,
    });
    await details(page, careers);
    await page.getByRole('button', { name: 'Find posting' }).click();
    await expect(toasts(page).getByText('Recognised on Greenhouse')).toBeVisible();
    await expect(page.getByText('Confirmed by you.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Find posting' })).toHaveCount(0);
    expect(await description(page, careers)).toBe(TYPED);
  });

  test('a gh_jid identification writes its timeline entry (#847)', async ({ page }) => {
    // Find posting by the opportunity's own gh_jid link is on the record, as every other way a
    // posting is found.
    await registerUser(page);
    await details(page, await opportunity(page, 'Office Coordinator'));
    await page.getByRole('button', { name: 'Find posting' }).click();
    await expect(toasts(page).getByText('Posting attached')).toBeVisible();
    const careers = await opportunity(page, 'Operations Lead', {
      postingUrl: 'https://vandelay.example/careers?gh_jid=1002',
      descriptionMd: TYPED,
    });
    await details(page, careers);
    await page.getByRole('button', { name: 'Find posting' }).click();
    await expect(toasts(page).getByText('Recognised on Greenhouse')).toBeVisible();
    const entries = await timeline(page, careers);
    await expect(entries).toContainText('Job posting identified');
    await expect(entries).toContainText(
      'Recognised on Greenhouse, by the job its posting link names. Your own description was kept.',
    );
  });

  test('the board offers several candidates, one, or none', async ({ page }) => {
    await registerUser(page);
    // Several: two titles score alike, and the user picks one.
    const several = await opportunity(page, 'Platform Backend Engineer');
    await details(page, several);
    await page.getByRole('button', { name: 'Find posting' }).click();
    const picker = page.getByRole('dialog', { name: 'Add the posting' });
    await expect(picker).toContainText(
      'More than one posting on the Vandelay Industries board matches. Pick the one you applied to.',
    );
    const rows = picker.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await rows
      .filter({ hasText: 'Senior Backend Engineer' })
      .getByRole('button', { name: 'Attach' })
      .click();
    await expect(picker).toBeHidden();
    await expect(toasts(page).getByText('Senior Backend Engineer')).toBeVisible();
    await expect(await timeline(page, several)).toContainText('Job posting attached');

    // One: the job the link names is gone from the board, so a title match is offered, not taken.
    const missing = await opportunity(page, 'Staff Platform Engineer II', {
      postingUrl: 'https://boards.greenhouse.io/vandelayindustries/jobs/9999',
    });
    await details(page, missing);
    await page.getByRole('button', { name: 'Find posting' }).click();
    await expect(picker).toContainText(
      'One posting on the Vandelay Industries board may match. Attach it only if it is the one you applied to.',
    );
    await expect(picker).toContainText(
      "The job this opportunity names isn't on the company's board now.",
    );
    await expect(picker.getByRole('listitem')).toHaveCount(1);
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Find posting' })).toBeVisible();
    await expect(await timeline(page, missing)).not.toContainText('Job posting');

    // None: nothing close; the board's postings are there to search, and nothing changes.
    const none = await opportunity(page, 'Chief Fun Officer');
    await details(page, none);
    await page.getByRole('button', { name: 'Find posting' }).click();
    await expect(picker).toContainText(
      'No close match on the board. Search it, or add the posting by hand.',
    );
    await picker.getByRole('button', { name: 'Cancel' }).click();
    expect(await description(page, none)).toBeNull();
  });

  test('needs review after the background check: several postings, and none', async ({
    page,
    playwright,
  }) => {
    await registerUser(page);
    // Several postings: Choose posting opens the candidates, and a pick confirms the posting.
    const ambiguous = await captured(page, playwright, 'Platform Backend Engineer');
    expect(await settled(page, ambiguous)).toMatchObject({
      postingState: 'needs_review',
      postingStateDetail: 'ambiguous',
    });
    await details(page, ambiguous);
    await expect(
      page.getByText("Several postings on the company's board could be this one."),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(await timeline(page, ambiguous)).toContainText(
      'Posting search found more than one candidate',
    );
    await details(page, ambiguous);
    await page.getByRole('button', { name: 'Choose posting' }).click();
    const picker = page.getByRole('dialog', { name: 'Add the posting' });
    await picker
      .getByRole('listitem')
      .filter({ hasText: 'Staff Platform Engineer' })
      .getByRole('button', { name: 'Attach' })
      .click();
    await expect(toasts(page).getByText('Staff Platform Engineer')).toBeVisible();
    await expect(page.getByText(/Lead our Go platform on Kubernetes/)).toBeVisible();

    // None found: Look again offers the board's postings; Confirm keeps the captured posting.
    const none = await captured(page, playwright, 'Chief Fun Officer');
    expect(await settled(page, none)).toMatchObject({
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    });
    await details(page, none);
    await expect(
      page.getByText("This posting is not on the company's board right now."),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(await timeline(page, none)).toContainText(
      "Posting not found on the company's board",
    );
    await details(page, none);
    await page.getByRole('button', { name: 'Look again' }).click();
    await expect(picker).toContainText('No close match on the board.');
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Confirmed by you.')).toBeVisible();
    expect(await description(page, none)).toBe('The Chief Fun Officer role, as captured.');
  });

  test('confirmed: no Find posting; Refetch keeps the user’s description and refreshes the board’s', async ({
    page,
  }) => {
    await registerUser(page);
    // The board's own description, then the board's copy changes: Refetch brings the new copy.
    const board = await opportunity(page, 'Senior Backend Engineer');
    await details(page, board);
    await page.getByRole('button', { name: 'Find posting' }).click();
    await expect(page.getByText("Matched on the company's board.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Find posting' })).toHaveCount(0);
    await listing(page, { append: { '1003': ' Now also Kafka.' } });
    await page.getByRole('button', { name: 'Refetch' }).click();
    const ask = page.getByRole('dialog', { name: 'Refetch this posting?' });
    await expect(ask).toContainText(
      "This replaces the current description with a fresh copy from the company's board.",
    );
    await ask.getByRole('button', { name: 'Refetch' }).click();
    await expect(page.getByText(/Now also Kafka\./)).toBeVisible();
    await expect(await timeline(page, board)).toContainText(
      "Refetched from the company's ATS board, by the job this opportunity names.",
    );

    // The user's own description (#812, #830): Refetch re-checks the board and keeps it.
    await page.request.delete('/__mock/discovery/listing');
    const own = await opportunity(page, 'Office Coordinator', {
      postingUrl: 'https://boards.greenhouse.io/vandelayindustries/jobs/1001',
      descriptionMd: TYPED,
    });
    await details(page, own);
    await page.getByRole('button', { name: 'Find posting' }).click();
    await expect(page.getByText('Confirmed by you.')).toBeVisible();
    await page.getByRole('button', { name: 'Refetch' }).click();
    await expect(ask).toContainText(
      "Opportun checks the company's board again; your description is kept.",
    );
    await ask.getByRole('button', { name: 'Refetch' }).click();
    await expect(toasts(page).getByText('Office Coordinator')).toBeVisible();
    expect(await description(page, own)).toBe(TYPED);
    await expect(await timeline(page, own)).toContainText(
      "Checked on the company's board; your description was kept.",
    );
  });
});

test.describe("the user's description survives the posting checks (#851, #856, #858)", () => {
  // The background check keeps a description saved while it reads the board (#851, fixed by
  // #855). The two tests below stay fixme until #858 lands (#863): a re-derive that waits on the
  // board, and a board copy taken from the edited state, can still write over the user's text.
  test('saved while the background check waits on a slow board, it is kept', async ({
    page,
    playwright,
  }) => {
    await registerUser(page);
    await listing(page, { holdMs: 6_000 });
    // A captured job the board holds exactly: without the save, the check would confirm it and
    // replace the captured text with the board's copy.
    const id = await captured(page, playwright, 'Senior Backend Engineer');
    await details(page, id);
    await expect(
      page.getByText("Checking the company's job board for this posting."),
    ).toBeVisible();
    // Saved while the check waits on the board, not before it starts (that older case is covered
    // by postingReconcile's own tests).
    await boardBeingRead(page);
    await page.getByRole('button', { name: 'Edit description' }).click();
    await page.getByLabel('Description').fill(TYPED);
    await page.getByRole('button', { name: 'Save' }).click();
    expect(await settled(page, id)).toMatchObject({
      postingState: 'needs_review',
      postingStateDetail: 'edited',
    });
    await details(page, id);
    await expect(
      page.getByText('You edited this description, so the board copy was not merged in.'),
    ).toBeVisible();
    expect(await description(page, id)).toBe(TYPED);
    const entries = await timeline(page, id);
    await expect(entries).toContainText(
      'The description changed while the board was being checked, so the board search left it as it is.',
    );
    await expect(entries).not.toContainText("Replaced the description with the board's copy.");
  });

  test.fixme('saved while a re-derive waits on a slow board, it is kept', async ({
    page,
    playwright,
  }) => {
    await registerUser(page);
    const id = await captured(page, playwright, 'Senior Backend Engineer');
    expect(await settled(page, id)).toMatchObject({ postingState: 'confirmed' });
    await details(page, id);
    await expect(page.getByText("Matched on the company's board.")).toBeVisible();
    await listing(page, { holdMs: 6_000 });
    const rederived = page.waitForResponse(
      (r) => r.url().endsWith('/posting/rederive') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Re-derive from capture' }).click();
    await page
      .getByRole('dialog', { name: 'Re-derive this description?' })
      .getByRole('button', { name: 'Re-derive' })
      .click();
    await boardBeingRead(page);
    // The user saves from another tab while the re-derive waits on the board.
    const saved = await page.request.patch(`/api/v1/opportunities/${id}`, {
      headers: { 'x-csrf-token': await csrf(page) },
      data: { descriptionMd: TYPED },
    });
    expect(saved.status()).toBe(200);
    await rederived;
    expect(await description(page, id)).toBe(TYPED);
    await expect(await timeline(page, id)).not.toContainText(
      'merged with the captured page as usual',
    );
  });

  test.fixme('from edited, replacing the description with the board copy asks first', async ({
    page,
    playwright,
  }) => {
    await registerUser(page);
    await listing(page, { holdMs: 6_000 });
    const id = await captured(page, playwright, 'Senior Backend Engineer');
    await details(page, id);
    await expect(
      page.getByText("Checking the company's job board for this posting."),
    ).toBeVisible();
    // Saved while the check waits on the board, not before it starts (that older case is covered
    // by postingReconcile's own tests).
    await boardBeingRead(page);
    await page.getByRole('button', { name: 'Edit description' }).click();
    await page.getByLabel('Description').fill(TYPED);
    await page.getByRole('button', { name: 'Save' }).click();
    expect(await settled(page, id)).toMatchObject({
      postingState: 'needs_review',
      postingStateDetail: 'edited',
    });
    await details(page, id);
    await expect(
      page.getByText('You edited this description, so the board copy was not merged in.'),
    ).toBeVisible();
    await page.request.delete('/__mock/discovery/listing');
    for (const action of ['Review board copy', 'Find posting']) {
      await page.getByRole('button', { name: action }).click();
      const ask = page.getByRole('dialog');
      await expect(ask).toBeVisible();
      await ask.getByRole('button', { name: 'Cancel' }).click();
      expect(await description(page, id)).toBe(TYPED);
    }
  });
});
