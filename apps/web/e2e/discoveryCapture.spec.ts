// The Discovery review workflow, end to end: a job-alert card, its posting on LinkedIn or Indeed,
// Capture this page in the built extension, and the card gone from the open Discovery page with one
// opportunity at Interested (https://github.com/bgoleno/opportun/issues/967, the owner's seven steps
// W1 to W7; https://github.com/bgoleno/opportun/issues/970). Each test names the case of the list it
// is (https://github.com/bgoleno/opportun/issues/967#issuecomment-7120097602). The pages are mocks
// answered at the sites' own addresses: nothing leaves the machine.
import { expect, test, type Request } from '@playwright/test';
import {
  ADDED,
  atDesk,
  COMPANY,
  DESCRIPTION,
  Desk,
  LEAVES_WITHIN,
  PLACE,
  posting,
  remaining,
  type Opportunity,
} from './captureDesk';
import { removeBuiltExtension } from './extension';
import { postingAddress, type AlertCard, type MockPosting } from './fixtures/postingPages';
import { toasts } from './helpers';

const SITES = ['linkedin', 'indeed'] as const;
const isList = (r: Request): boolean =>
  r.method() === 'GET' && /\/discovery\/results\?disposition=pending/.test(r.url());
const isDiscovery = (r: Request): boolean => /\/api\/v1\/discovery\//.test(r.url());

test.afterAll(removeBuiltExtension);

// --- the owner's path ------------------------------------------------------------------------

for (const { site, width } of [
  { site: 'linkedin', width: 1280 },
  { site: 'indeed', width: 1280 },
  { site: 'linkedin', width: 768 },
  { site: 'linkedin', width: 1920 },
] as const) {
  test(`W1 to W7, case 1: ${site} card, posting, capture, back, gone (${width} px)`, async () => {
    await atDesk(
      async (desk) => {
        const p = posting(site, 'Principal, Product Manager ( L5)');
        const others = [posting(site, 'Head of Robotics'), posting(site, 'Cover Sheet Auditor')];
        // The other cards are another site's mail's business: none is ever captured.
        await desk.alert(
          site,
          [p, ...others].map((x) => ({ posting: x, location: PLACE })),
        );
        await desk.discovery();
        await expect(desk.page.getByText(remaining(3))).toBeVisible();
        await expect(desk.row('Principal, Product Manager ( L5)')).toContainText('Needs capture');
        const kept = desk
          .row('Head of Robotics')
          .getByRole('checkbox', { name: 'Select Head of Robotics at Initech' });
        await kept.check();

        // W2 and W3: the posting opens in a tab of its own; reading it changes nothing.
        const opened = desk.context.waitForEvent('page');
        await desk.page
          .getByRole('link', {
            name: 'Open posting for Principal, Product Manager ( L5) at Initech',
          })
          .click();
        const tab = await opened;
        await expect(tab).toHaveURL(postingAddress(p));
        expect(await desk.opportunities(p.title)).toEqual([]);
        expect((await desk.results()).map((r) => r.disposition)).toEqual([
          'pending',
          'pending',
          'pending',
        ]);

        // W4: one click.
        expect((await desk.popup.capture(postingAddress(p))).startsWith(ADDED)).toBe(true);
        // W5, W6, W7.
        const one = await desk.oneAtInterested(p, { location: PLACE });
        await desk.back();
        await desk.leaves('Principal, Product Manager ( L5)', 2);
        await expect(kept).toBeChecked();
        await desk.quiet();
        expect(new URL(desk.page.url()).pathname).toBe('/discovery');

        // And where the user looks next.
        await desk.page.goto('/pipeline');
        await expect(
          desk.page
            .getByRole('region', { name: 'Interested column' })
            .getByRole('article', { name: `Initech: ${p.title}` }),
        ).toHaveCount(1);
        expect(
          (await desk.entries(one.id)).filter((e) => /^Captured from/.test(e.title)),
        ).toHaveLength(1);
      },
      { width, height: 900 },
    );
  });
}

test('W1, case 3: a page left alone asks for nothing more', async () => {
  await atDesk(async (desk) => {
    await desk.alert('linkedin', [{ posting: posting('linkedin', 'Quiet Role'), location: PLACE }]);
    await desk.discovery();
    await expect(desk.row('Quiet Role')).toBeVisible();
    // The first read's own window is over only after a return or an opened posting: neither here.
    await desk.page.waitForTimeout(1_000);
    let asked = 0;
    desk.page.on('request', (r) => {
      if (isDiscovery(r)) asked += 1;
    });
    await desk.page.waitForTimeout(8_000);
    expect(asked).toBe(0);
  });
});

test('W2 and W3, cases 4 and 5: every way to the posting opens it and changes nothing', async () => {
  await atDesk(async (desk) => {
    const p = posting('linkedin', 'Reading Role');
    const other = posting('linkedin', 'Other Role');
    await desk.alert('linkedin', [
      { posting: p, location: PLACE },
      { posting: other, location: PLACE },
    ]);
    await desk.discovery();
    await desk
      .row('Other Role')
      .getByRole('checkbox', { name: 'Select Other Role at Initech' })
      .check();
    await desk.row('Reading Role').focus();

    const byButton = await desk.openPosting(p);
    await byButton.close();

    const byKey = desk.context.waitForEvent('page');
    await desk.row('Reading Role').focus();
    await desk.page.keyboard.press('p');
    const keyed = await byKey;
    await expect(keyed).toHaveURL(postingAddress(p));
    await keyed.close();

    await desk
      .row('Reading Role')
      .getByRole('button', { name: 'Reading Role', exact: true })
      .click();
    const detail = desk.page.getByRole('dialog', { name: 'Reading Role' });
    const byDetail = desk.context.waitForEvent('page');
    await detail.getByRole('link', { name: 'Open the posting' }).click();
    const detailed = await byDetail;
    await expect(detailed).toHaveURL(postingAddress(p));
    await detailed.close();
    await desk.page.keyboard.press('Escape');

    await desk.back();
    await expect(desk.row('Reading Role')).toHaveAttribute('aria-current', 'true');
    await expect(
      desk.row('Other Role').getByRole('checkbox', { name: 'Select Other Role at Initech' }),
    ).toBeChecked();
    await expect(desk.page.getByText(remaining(2))).toBeVisible();
    expect((await desk.results()).map((r) => r.disposition)).toEqual(['pending', 'pending']);
    expect(await desk.opportunities(p.title)).toEqual([]);
  });
});

// --- W4 and W7: the server is still working ----------------------------------------------------

for (const site of SITES) {
  test(`W7, cases 8 and 35: ${site}, the popup closed and the user back before the capture has finished`, async () => {
    await atDesk(async (desk) => {
      const p = posting(site, 'Slow Role', {
        description: `${DESCRIPTION}\nqa-mock: refine takes 6000 ms`,
      });
      await desk.alert(site, [
        { posting: p, location: PLACE },
        { posting: posting(site, 'Other Role'), location: PLACE },
      ]);
      await desk.discovery();
      await desk.openPosting(p);
      const popup = await desk.popup.over(postingAddress(p));
      const sent = popup.waitForRequest(/connector\/capture/);
      await popup.getByRole('button', { name: 'Capture this page' }).click();
      await sent;
      await popup.waitForTimeout(300);
      await popup.close();
      await desk.back();
      expect(await desk.opportunities(p.title)).toEqual([]);
      await expect(desk.row('Slow Role')).toBeVisible();

      await expect
        .poll(async () => (await desk.opportunities(p.title)).map((o) => o.stage), {
          timeout: 20_000,
          intervals: [200],
        })
        .toEqual(['interested']);
      await desk.leaves('Slow Role', 1);
      await desk.quiet();
      const one = await desk.oneAtInterested(p);
      expect(
        (await desk.entries(one.id)).filter((e) => /^Captured from/.test(e.title)),
      ).toHaveLength(1);
    });
  });

  test(`W7, case 36: ${site}, two windows side by side, Discovery never returned to`, async () => {
    await atDesk(async (desk) => {
      const p = posting(site, 'Second Window Role');
      await desk.alert(site, [
        { posting: p, location: PLACE },
        { posting: posting(site, 'Other Role'), location: PLACE },
      ]);
      await desk.discovery();
      await desk.openPosting(p);
      expect(await desk.popup.capture(postingAddress(p))).toContain(ADDED);
      await desk.leaves('Second Window Role', 1);
      await desk.quiet();
      await desk.oneAtInterested(p);
    });
  });
}

test('W7, case 37: a return by focus, by visibility, or both, is one read of the list', async () => {
  await atDesk(async (desk) => {
    await desk.alert('linkedin', [{ posting: posting('linkedin', 'Stay Role'), location: PLACE }]);
    await desk.discovery();
    await expect(desk.row('Stay Role')).toBeVisible();
    for (const events of [
      ['focus'],
      ['visibilitychange'],
      ['visibilitychange', 'focus'],
    ] as const) {
      await desk.page.waitForTimeout(1_500);
      let reads = 0;
      const count = (r: Request) => {
        if (isList(r)) reads += 1;
      };
      desk.page.on('request', count);
      await desk.back([...events]);
      await desk.page.waitForTimeout(1_200);
      desk.page.off('request', count);
      expect(reads, events.join(' + ')).toBe(1);
    }
  });
});

test('W7, case 38: the asking ends 60 s after a return, and 10 minutes after a posting is opened', async () => {
  await atDesk(async (desk) => {
    const p = posting('linkedin', 'Waiting Role');
    await desk.alert('linkedin', [{ posting: p, location: PLACE }]);
    await desk.page.clock.install();
    await desk.discovery();
    await expect(desk.row('Waiting Role')).toBeVisible();
    let asked = 0;
    desk.page.on('request', (r) => {
      if (isDiscovery(r)) asked += 1;
    });
    const during = async (ms: number): Promise<number> => {
      asked = 0;
      // Steps, so a timer that arms the next one is followed, and each answer can land.
      for (let t = 0; t < ms; t += 1_000) {
        await desk.page.clock.runFor(1_000);
        await desk.page.waitForTimeout(10);
      }
      await desk.page.waitForTimeout(300);
      return asked;
    };
    await desk.back();
    expect(await during(55_000), 'within a minute of the return').toBeGreaterThan(5);
    await during(10_000);
    expect(await during(30_000), 'after the minute').toBe(0);

    await desk.openPosting(p);
    expect(await during(60_000), 'after a posting was opened').toBeGreaterThan(5);
    await desk.page.clock.fastForward(10 * 60_000);
    await during(5_000);
    expect(await during(30_000), 'after ten minutes').toBe(0);
  });
});

for (const width of [768, 1280, 1920])
  test(`W7, cases 39 and 41: selection, focus and place when the card leaves (${width} px)`, async () => {
    await atDesk(
      async (desk) => {
        const list = Array.from({ length: 24 }, (_, i) =>
          posting('linkedin', `Listed Role ${String(i + 1).padStart(2, '0')}`),
        );
        await desk.alert(
          'linkedin',
          list.map((x) => ({ posting: x, location: PLACE })),
        );
        await desk.discovery();
        const rows = desk.cards;
        await expect(rows).toHaveCount(24);
        const names = await rows.evaluateAll((els) =>
          els.map((e) => e.getAttribute('aria-label') ?? ''),
        );
        const at = 11;
        const gone = list.find((p) => `${p.title} at ${COMPANY}` === names.at(at)) as MockPosting;
        const next = names[at + 1] as string;
        await rows.nth(at).focus();
        const above = await rows.nth(at - 1).boundingBox();

        expect(await desk.capture(gone)).toContain(ADDED);
        await desk.back();
        await desk.leaves(gone.title, 23);
        const after = desk.page.getByRole('listitem', { name: next, exact: true });
        await expect(after).toHaveAttribute('aria-current', 'true');
        await expect(after).toBeFocused();
        const aboveNow = await desk.page
          .getByRole('listitem', { name: names[at - 1] as string, exact: true })
          .boundingBox();
        expect(Math.abs((aboveNow?.y ?? 0) - (above?.y ?? 0))).toBeLessThanOrEqual(2);

        // The last of the list: the selection goes to the one before it.
        const last = list.find((p) => `${p.title} at ${COMPANY}` === names.at(23)) as MockPosting;
        await rows.last().focus();
        expect(await desk.capture(last)).toContain(ADDED);
        await desk.back();
        await desk.leaves(last.title, 22);
        await expect(rows.last()).toHaveAttribute('aria-current', 'true');
      },
      { width, height: 900 },
    );
  });

test('W7, case 41: the only card, and the list is empty', async () => {
  await atDesk(async (desk) => {
    const p = posting('linkedin', 'Only Role');
    await desk.alert('linkedin', [{ posting: p, location: PLACE }]);
    await desk.discovery();
    await desk.openPosting(p);
    expect(await desk.popup.capture(postingAddress(p))).toContain(ADDED);
    await desk.back();
    await desk.leaves('Only Role', 0);
    await desk.quiet();
  });
});

test('W7, case 40: "select all matching" loses only the captured one', async () => {
  test.setTimeout(150_000);
  await atDesk(async (desk) => {
    const list = Array.from({ length: 210 }, (_, i) => posting('linkedin', `Bulk Role ${i + 1}`));
    for (let i = 0; i < list.length; i += 70) {
      await desk.alert(
        'linkedin',
        list.slice(i, i + 70).map((x) => ({ posting: x, location: PLACE })),
        false,
      );
    }
    await desk.discovery();
    // An order ranking leaves alone, and read before the selection: one made while the new order is
    // still being read loses the cards that order does not show.
    const read = desk.page.waitForResponse((r) => /sort=-createdAt/.test(r.url()));
    await desk.page.getByLabel('Sort by').selectOption({ label: 'Date discovered' });
    await read;
    await expect(desk.cards.first()).toHaveAccessibleName(/Bulk Role/);
    // It pages by score, and ranking still moves rows between its pages: pressed again until it has all.
    await expect(async () => {
      await desk.page.getByRole('button', { name: 'Select all 210 matching' }).click();
      await expect(desk.page.getByText('210 selected')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    const first = await desk.cards.first().getAttribute('aria-label');
    const gone = list.find((p) => `${p.title} at ${COMPANY}` === first) as MockPosting;
    expect(await desk.capture(gone)).toContain(ADDED);
    await desk.back();
    await expect(desk.page.getByText(remaining(209))).toBeVisible({ timeout: LEAVES_WITHIN });
    await expect(desk.page.getByText('209 selected')).toBeVisible();
  });
});

// --- W5: which card, and how many opportunities --------------------------------------------------

for (const site of SITES) {
  for (const [what, cardAt, pageAt, kept] of [
    ['both name another place', PLACE, 'Denver', PLACE],
    ['only the page names one', null, 'Denver', 'Denver'],
    ['neither names one', null, null, null],
  ] as const) {
    test(`W5, case 12: ${site}, ${what}`, async () => {
      await atDesk(async (desk) => {
        const p = posting(site, 'Placed Role', {
          description:
            pageAt === null ? DESCRIPTION : `${DESCRIPTION}\nqa-mock: location is ${pageAt}.`,
        });
        await desk.alert(site, [
          { posting: p, location: cardAt },
          { posting: posting(site, 'Other Role'), location: PLACE },
        ]);
        await desk.discovery();
        await desk.openPosting(p);
        expect(await desk.popup.capture(postingAddress(p))).toContain(ADDED);
        await desk.oneAtInterested(p, { location: kept });
        await desk.back();
        await desk.leaves('Placed Role', 1);
        await desk.quiet();
      });
    });
  }

  test(`W5, case 19: ${site}, captured twice`, async () => {
    await atDesk(async (desk) => {
      const p = posting(site, 'Twice Role');
      await desk.alert(site, [
        { posting: p, location: PLACE },
        { posting: posting(site, 'Other Role'), location: PLACE },
      ]);
      await desk.discovery();
      await desk.openPosting(p);
      expect(await desk.popup.capture(postingAddress(p))).toContain(ADDED);
      const one = await desk.oneAtInterested(p);
      const results = (await desk.results()).length;
      expect
        .soft(await desk.popup.capture(postingAddress(p)))
        .toBe('Already in your pipeline, at Interested. This page was added to its timeline.');
      expect((await desk.oneAtInterested(p)).id).toBe(one.id);
      expect(await desk.results()).toHaveLength(results);
      await desk.back();
      await desk.leaves('Twice Role', 1);
      await desk.quiet();
    });
  });
}

test("W5, case 14: the tab ends at LinkedIn's /jobs/view/<words>-<id>", async () => {
  await atDesk(async (desk) => {
    const p = posting('linkedin', 'Slug Role');
    await desk.alert('linkedin', [
      { posting: p, location: PLACE },
      { posting: posting('linkedin', 'Other Role'), location: PLACE },
    ]);
    await desk.discovery();
    expect(
      await desk.capture(p, `https://www.linkedin.com/jobs/view/slug-role-at-initech-${p.id}/`),
    ).toContain(ADDED);
    await desk.oneAtInterested(p);
    await desk.back();
    await desk.leaves('Slug Role', 1);
  });
});

test("W5, case 23: another user's card for the same posting is untouched", async () => {
  await atDesk(async (a) => {
    await atDesk(async (b) => {
      const p = posting('linkedin', 'Shared Role');
      await a.alert('linkedin', [{ posting: p, location: PLACE }]);
      await b.alert('linkedin', [{ posting: p, location: PLACE }]);
      await b.discovery();
      const before = [await b.results(), await b.opportunities(p.title)];
      await a.discovery();
      await a.openPosting(p);
      expect(await a.popup.capture(postingAddress(p))).toContain(ADDED);
      await a.back();
      await a.leaves('Shared Role', 0);
      await a.oneAtInterested(p);
      await b.back();
      await b.page.waitForTimeout(LEAVES_WITHIN);
      await expect(b.row('Shared Role')).toBeVisible();
      expect([await b.results(), await b.opportunities(p.title)]).toEqual(before);
    });
  });
});

// --- W6 and W7: an opportunity that was there before ----------------------------------------------

test("W6, case 30: the user's own description is never replaced", async () => {
  await atDesk(async (desk) => {
    const p = posting('linkedin', 'Described Role');
    await desk.alert('linkedin', [{ posting: p, location: PLACE }]);
    const { id } = await desk.api<{ id: string }>('POST', '/opportunities', {
      companyName: COMPANY,
      title: p.title,
      location: PLACE,
      sourceKind: 'manual',
    });
    const mine = 'What I wrote myself.\n\nWith two  spaces.';
    await desk.api('PATCH', `/opportunities/${id}`, { descriptionMd: mine });
    const stored = (await desk.opportunities(p.title))[0]?.descriptionMd as string;
    await desk.discovery();
    await desk.openPosting(p);
    expect
      .soft(await desk.popup.capture(postingAddress(p)))
      .toBe(
        'Already in your pipeline: moved to Interested. Its own description was kept; this page is on its timeline.',
      );
    await desk.oneAtInterested(p, { descriptionMd: stored });
    expect(
      (await desk.entries(id)).filter((e) => e.title === 'Captured from LinkedIn'),
    ).toHaveLength(1);
    await desk.back();
    await desk.leaves('Described Role', 0);
  });
});

for (const [stage, label, end, said] of [
  ['dismissed', 'Dismissed', 'interested', 'Already in your pipeline: moved to Interested.'],
  [
    'applied',
    'Applied',
    'applied',
    'Already in your pipeline, at Applied. This page was added to its timeline.',
  ],
] as const) {
  test(`W7, cases 32 and 33: an opportunity already at ${label}`, async () => {
    await atDesk(async (desk) => {
      const p = posting('linkedin', 'Tracked Role');
      await desk.alert('linkedin', [{ posting: p, location: PLACE }]);
      const { id } = await desk.api<{ id: string }>('POST', '/opportunities', {
        companyName: COMPANY,
        title: p.title,
        location: PLACE,
        sourceKind: 'manual',
      });
      await desk.api('POST', `/opportunities/${id}/stage`, {
        to: stage,
        ...(stage === 'dismissed' ? { dismissedReason: 'other' } : {}),
      });
      await desk.discovery();
      await desk.openPosting(p);
      expect.soft(await desk.popup.capture(postingAddress(p))).toContain(said);
      const one = await desk.oneAtInterested(p, { stage: end });
      expect(one.id).toBe(id);
      await desk.back();
      await desk.leaves('Tracked Role', 0);
      await desk.quiet();
    });
  });
}

// --- a card left behind ---------------------------------------------------------------------------

/** A Discovery page that has not heard of the capture: its reads of results are held back. */
async function leftBehind(desk: Desk, p: MockPosting): Promise<void> {
  await desk.page.route(/\/api\/v1\/discovery\/results\?/, (route) =>
    route.request().method() === 'GET' ? route.abort() : route.continue(),
  );
  expect(await desk.capture(p)).toContain(ADDED);
  // The posting check the capture queued writes to the opportunity too: let it, before comparing.
  await expect
    .poll(async () => (await desk.opportunities(p.title)).map((o) => o.postingState))
    .not.toContain('searching');
  await expect(desk.row(p.title)).toBeVisible();
}
const caughtUp = (desk: Desk) => desk.page.unroute(/\/api\/v1\/discovery\/results\?/);

for (const how of ['the button', 'the key', 'the detail dialog'] as const) {
  test(`case 42: Accept by ${how} on a card already captured says so, with a link`, async () => {
    await atDesk(async (desk) => {
      const p = posting('linkedin', 'Left Role');
      await desk.alert('linkedin', [
        { posting: p, location: PLACE },
        { posting: posting('linkedin', 'Other Role'), location: PLACE },
      ]);
      await desk.discovery();
      await expect(desk.row('Left Role')).toBeVisible();
      await leftBehind(desk, p);
      const before = [await desk.results(), await desk.opportunities(p.title)];
      await desk.row('Left Role').focus();
      if (how === 'the button') {
        await desk.row('Left Role').getByRole('button', { name: 'Accept Left Role' }).click();
      } else if (how === 'the key') {
        await desk.page.keyboard.press('i');
      } else {
        await desk.page.keyboard.press('Enter');
        await desk.page
          .getByRole('dialog', { name: 'Left Role' })
          .getByRole('button', { name: 'Accept' })
          .click();
      }
      await expect(toasts(desk.page).getByText('Already in your pipeline')).toBeVisible();
      await expect(desk.page.getByRole('dialog')).toHaveCount(0);
      await expect(desk.row('Left Role')).toHaveCount(0);
      expect([await desk.results(), await desk.opportunities(p.title)]).toEqual(before);
      await caughtUp(desk);
      const one = (await desk.opportunities(p.title))[0] as Opportunity;
      await toasts(desk.page).getByRole('button', { name: 'View opportunity' }).click();
      await expect(desk.page).toHaveURL((url) => url.pathname === `/opportunities/${one.id}`);
    });
  });
}

test('case 44: Dismiss on a card already captured says so and dismisses nothing', async () => {
  await atDesk(async (desk) => {
    const p = posting('linkedin', 'Left Role');
    await desk.alert('linkedin', [{ posting: p, location: PLACE }]);
    await desk.discovery();
    await expect(desk.row('Left Role')).toBeVisible();
    await leftBehind(desk, p);
    const before = [await desk.results(), await desk.opportunities(p.title)];
    await desk.row('Left Role').getByRole('button', { name: 'Dismiss Left Role' }).click();
    const dialog = desk.page.getByRole('dialog', { name: 'Dismiss result' });
    await dialog.getByLabel('Reason').selectOption({ index: 1 });
    await dialog.getByRole('button', { name: 'Dismiss' }).click();
    await expect(
      toasts(desk.page).getByText('Not dismissed: already in your pipeline'),
    ).toBeVisible();
    await expect(toasts(desk.page).getByRole('button', { name: 'View opportunity' })).toBeVisible();
    expect([await desk.results(), await desk.opportunities(p.title)]).toEqual(before);
  });
});

for (const action of ['Accept', 'Dismiss'] as const) {
  test(`case 45: bulk ${action} with a card already captured does the other one only`, async () => {
    await atDesk(async (desk) => {
      const p = posting('linkedin', 'Left Role');
      const other = posting('linkedin', 'Other Role');
      const third = posting('linkedin', 'Third Role');
      await desk.alert(
        'linkedin',
        [p, other, third].map((x) => ({ posting: x, location: PLACE })),
      );
      await desk.discovery();
      for (const t of ['Left Role', 'Other Role']) {
        await desk
          .row(t)
          .getByRole('checkbox', { name: `Select ${t} at ${COMPANY}` })
          .check();
      }
      await leftBehind(desk, p);
      const [one] = await desk.opportunities(p.title);
      await caughtUp(desk);
      await desk.page.getByRole('button', { name: action, exact: true }).first().click();
      await desk.page
        .getByRole('dialog')
        .getByRole('button', { name: `${action} 2`, exact: true })
        .click();
      await expect(
        toasts(desk.page).getByText(
          `1 ${action === 'Accept' ? 'accepted' : 'dismissed'}; 1 already decided`,
        ),
      ).toBeVisible();
      expect(await desk.opportunities(p.title)).toEqual([one]);
      const now = await desk.results();
      const of = (x: MockPosting) => now.find((r) => r.posting.externalId === x.id)?.disposition;
      expect([of(p), of(other), of(third)]).toEqual([
        'accepted',
        action === 'Accept' ? 'accepted' : 'dismissed',
        'pending',
      ]);
    });
  });
}

for (const choice of ['Attach to existing', 'Create anyway'] as const) {
  test(`case 47: a true match, nothing captured: ${choice} works`, async () => {
    await atDesk(async (desk) => {
      const p = posting('linkedin', 'Matched Role');
      await desk.alert('linkedin', [{ posting: p, location: PLACE }]);
      await desk.api('POST', '/opportunities', {
        companyName: COMPANY,
        title: p.title,
        location: PLACE,
        sourceKind: 'manual',
      });
      await desk.discovery();
      await desk.row('Matched Role').getByRole('button', { name: 'Accept Matched Role' }).click();
      const dialog = desk.page.getByRole('dialog', { name: 'Already in your pipeline?' });
      await expect(
        dialog.getByRole('link', { name: 'View the existing opportunity' }),
      ).toBeVisible();
      await dialog.getByRole('button', { name: choice }).click();
      await expect(dialog).toBeHidden();
      await desk.leaves('Matched Role', 0);
      expect(await desk.opportunities(p.title)).toHaveLength(choice === 'Create anyway' ? 2 : 1);
    });
  });

  test(`case 43: captured while the duplicate dialog is open, then ${choice}`, async () => {
    await atDesk(async (desk) => {
      const p = posting('linkedin', 'Raced Role');
      await desk.alert('linkedin', [{ posting: p, location: PLACE }]);
      const { id } = await desk.api<{ id: string }>('POST', '/opportunities', {
        companyName: COMPANY,
        title: p.title,
        location: PLACE,
        sourceKind: 'manual',
      });
      await desk.discovery();
      await desk.row('Raced Role').getByRole('button', { name: 'Accept Raced Role' }).click();
      const dialog = desk.page.getByRole('dialog', { name: 'Already in your pipeline?' });
      await expect(dialog).toBeVisible();
      await desk.capture(p);
      await dialog.getByRole('button', { name: choice }).click();
      await expect(dialog).toBeHidden();
      await expect(toasts(desk.page).getByText('Already in your pipeline')).toBeVisible();
      await expect(toasts(desk.page).getByText('Not accepted')).toHaveCount(0);
      const list = await desk.opportunities(p.title);
      expect(list.map((o) => [o.id, o.stage])).toEqual([[id, 'interested']]);
    });
  });
}

test('case 48: the matched opportunity deleted while the dialog is open', async () => {
  await atDesk(async (desk) => {
    const p = posting('linkedin', 'Vanished Role');
    await desk.alert('linkedin', [{ posting: p, location: PLACE }]);
    const { id } = await desk.api<{ id: string }>('POST', '/opportunities', {
      companyName: COMPANY,
      title: p.title,
      location: PLACE,
      sourceKind: 'manual',
    });
    await desk.discovery();
    await desk.row('Vanished Role').getByRole('button', { name: 'Accept Vanished Role' }).click();
    const dialog = desk.page.getByRole('dialog', { name: 'Already in your pipeline?' });
    await expect(dialog).toBeVisible();
    const csrf = (await desk.context.cookies()).find((c) => c.name === 'opportun_csrf')?.value;
    const gone = await desk.page.request.delete(`/api/v1/opportunities/${id}`, {
      headers: { 'x-csrf-token': csrf ?? '' },
    });
    expect(gone.ok()).toBe(true);
    await dialog.getByRole('button', { name: 'Attach to existing' }).click();
    await expect(dialog).toBeHidden();
    await expect(toasts(desk.page).getByText(/deleted/)).toBeVisible();
    await expect(desk.row('Vanished Role')).toBeVisible();
    expect((await desk.results()).map((r) => r.disposition)).toEqual(['pending']);
  });
});

// --- one card, several locations --------------------------------------------------------------------

for (const [what, sites] of [
  ['two on LinkedIn', ['linkedin', 'linkedin']],
  ['two on Indeed', ['indeed', 'indeed']],
  ['three, across both', ['linkedin', 'indeed', 'linkedin']],
] as const) {
  for (let first = 0; first < sites.length; first += 1) {
    test(`W7, cases 50 and 51: a card with locations, ${what}, number ${first + 1} captured first`, async () => {
      await atDesk(async (desk) => {
        const places = ['Springfield', 'Denver', 'Boise'];
        const card = sites.map((s, i) => ({
          posting: posting(s, 'Many Places Role'),
          location: places.at(i) as string,
        }));
        for (const s of SITES) {
          const of = card.filter((c) => c.posting.site === s);
          if (of.length > 0) await desk.alert(s, of);
        }
        await desk.alert('linkedin', [
          { posting: posting('linkedin', 'Other Role'), location: PLACE },
        ]);
        await desk.discovery();
        await expect(desk.row('Many Places Role')).toHaveAccessibleName(
          `Many Places Role at ${COMPANY}, ${card.length} locations`,
        );
        const chosen = card.at(first) as AlertCard;
        const n = card.length - 1;
        expect
          .soft(await desk.capture(chosen.posting))
          .toMatch(
            n === 1
              ? /^Added to your pipeline as Interested\..*other posting on its card was linked/
              : /^Added to your pipeline as Interested\..*2 other postings on its card were linked/,
          );
        const one = await desk.oneAtInterested(chosen.posting);
        await desk.back();
        await desk.leaves('Many Places Role', 1);
        await desk.quiet();
        const links = (await desk.entries(one.id)).map((e) => e.externalUrl);
        for (const c of card) {
          expect(
            // The capture's own entry has the page's address, with no slash at its end.
            links.filter(
              (u) => u === postingAddress(c.posting) || `${u}/` === postingAddress(c.posting),
            ),
            `${c.location} on the timeline`,
          ).toHaveLength(1);
        }

        // Another of its locations, captured later: the same opportunity, nothing more.
        const later = card.find((c) => c !== chosen) as AlertCard;
        const results = (await desk.results()).length;
        expect
          .soft(await desk.capture(later.posting))
          .toContain('Already in your pipeline, at Interested.');
        expect((await desk.oneAtInterested(chosen.posting)).id).toBe(one.id);
        expect(await desk.results()).toHaveLength(results);
      });
    });
  }
}

test('case 53: Senior and Principal of one title are two cards; Sr is Senior', async () => {
  await atDesk(async (desk) => {
    const senior = posting('linkedin', 'Senior Archive Keeper');
    const sr = posting('linkedin', 'Sr Archive Keeper');
    const principal = posting('linkedin', 'Principal Archive Keeper');
    await desk.alert('linkedin', [
      { posting: senior, location: 'Springfield' },
      { posting: sr, location: 'Denver' },
      { posting: principal, location: 'Boise' },
    ]);
    await desk.discovery();
    const rows = desk.cards;
    await expect(rows).toHaveCount(2);
    await expect(desk.row('Principal Archive Keeper')).toHaveAccessibleName(
      `Principal Archive Keeper at ${COMPANY}`,
    );
    await desk
      .row('Principal Archive Keeper')
      .getByRole('button', { name: 'Accept Principal Archive Keeper' })
      .click();
    await expect(toasts(desk.page).getByText('Added to pipeline')).toBeVisible();
    await expect(rows).toHaveCount(1);
    const now = await desk.results();
    const of = (p: MockPosting) => now.find((r) => r.posting.externalId === p.id)?.disposition;
    expect([of(senior), of(sr), of(principal)]).toEqual(['pending', 'pending', 'accepted']);
  });
});

test('case 53: capturing the Senior posting leaves the Principal card', async () => {
  await atDesk(async (desk) => {
    const senior = posting('linkedin', 'Senior Archive Keeper');
    const principal = posting('linkedin', 'Principal Archive Keeper');
    await desk.alert('linkedin', [
      { posting: senior, location: 'Springfield' },
      { posting: principal, location: 'Boise' },
    ]);
    await desk.discovery();
    await expect(desk.cards).toHaveCount(2);
    expect(await desk.capture(senior)).toContain(ADDED);
    await desk.back();
    await desk.leaves('Senior Archive Keeper', 1);
    await expect(desk.row('Principal Archive Keeper')).toBeVisible();
    expect(await desk.opportunities(principal.title)).toEqual([]);
  });
});

test('case 55: a location that arrives after the capture makes no card and is linked', async () => {
  await atDesk(async (desk) => {
    const p = posting('linkedin', 'Later Place Role');
    const late = posting('linkedin', 'Later Place Role');
    await desk.alert('linkedin', [{ posting: p, location: 'Springfield' }]);
    await desk.discovery();
    expect(await desk.capture(p)).toContain(ADDED);
    const one = await desk.oneAtInterested(p);
    await desk.alert('linkedin', [{ posting: late, location: 'Denver' }], false);
    const linked = async () =>
      (await desk.entries(one.id)).filter((e) => e.externalUrl === postingAddress(late)).length;
    await expect.poll(linked).toBe(1);
    await desk.discovery();
    await expect(desk.row('Later Place Role')).toHaveCount(0);
    expect(await desk.oneAtInterested(p)).toMatchObject({
      id: one.id,
      location: one.location,
      descriptionMd: one.descriptionMd,
    });

    expect.soft(await desk.capture(late)).toContain('Already in your pipeline, at Interested.');
    expect((await desk.oneAtInterested(p)).id).toBe(one.id);
  });
});
